import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rename, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./cache";
import {
	assembleContext,
	compactMessages,
	generateRepomap,
	getSymbolCount,
	indexDirectory,
	indexFile,
	refreshRepositoryIndex,
} from "./context-engine";

describe("repository context", () => {
	it("keeps indexes isolated by workspace", async () => {
		const first = await mkdtemp(join(tmpdir(), "nightcode-index-a-"));
		const second = await mkdtemp(join(tmpdir(), "nightcode-index-b-"));
		await writeFile(join(first, "alpha.ts"), "export function alpha() { return 1; }");
		await writeFile(join(second, "beta.ts"), "export class Beta {}");

		await indexDirectory(first);
		await indexDirectory(second);

		expect(generateRepomap(500, first)).toContain("alpha");
		expect(generateRepomap(500, first)).not.toContain("Beta");
		expect(generateRepomap(500, second)).toContain("Beta");
		expect(getSymbolCount(first)).toBeGreaterThan(0);
		expect(getSymbolCount(second)).toBeGreaterThan(0);
	});

	it("uses normalized relative paths and ranks query matches before recency", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-index-ranking-"));
		const nested = join(root, "nested");
		await mkdir(nested);

		const payment = join(nested, "payment-service.ts");
		const ledger = join(nested, "ledger.ts");
		const newest = join(root, "newest.ts");
		const alphaShared = join(root, "a-shared.ts");
		const zetaShared = join(root, "z-shared.ts");

		await writeFile(payment, "export function reconcilePayment() { return true; }");
		await writeFile(ledger, "export class SettlementCoordinator {}");
		await writeFile(newest, "export function newestUnrelated() { return true; }");
		await writeFile(alphaShared, "export class SharedThing {}");
		await writeFile(zetaShared, "export class SharedThing {}");

		const oldTime = new Date("2020-01-01T00:00:00.000Z");
		const sharedTime = new Date("2021-01-01T00:00:00.000Z");
		const newTime = new Date("2025-01-01T00:00:00.000Z");
		await Promise.all([
			utimes(payment, oldTime, oldTime),
			utimes(ledger, oldTime, oldTime),
			utimes(newest, newTime, newTime),
			utimes(alphaShared, sharedTime, sharedTime),
			utimes(zetaShared, sharedTime, sharedTime),
		]);

		await indexDirectory(root);

		const byRecency = generateRepomap(2_000, root);
		expect(byRecency.indexOf("## newest.ts")).toBeLessThan(
			byRecency.indexOf("## nested/payment-service.ts"),
		);

		const byWindowsStylePath = generateRepomap(2_000, root, "nested\\payment");
		expect(byWindowsStylePath.indexOf("## nested/payment-service.ts")).toBeLessThan(
			byWindowsStylePath.indexOf("## newest.ts"),
		);
		expect(byWindowsStylePath).not.toContain(root);

		const bySymbol = generateRepomap(2_000, root, "SettlementCoordinator");
		expect(bySymbol.indexOf("## nested/ledger.ts")).toBeLessThan(bySymbol.indexOf("## newest.ts"));

		const stable = generateRepomap(2_000, root, "shared");
		expect(stable.indexOf("## a-shared.ts")).toBeLessThan(stable.indexOf("## z-shared.ts"));
	});

	it("bounds directory indexing by file size and count", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-index-bounds-"));
		await writeFile(join(root, "small-a.ts"), "export function smallA() {}");
		await writeFile(join(root, "small-b.ts"), "export function smallB() {}");
		await writeFile(join(root, "huge.ts"), `export const huge = "${"x".repeat(512)}";`);

		expect(await indexDirectory(root, { maxFileBytes: 80, maxFiles: 10 })).toBe(2);
		expect(generateRepomap(1_000, root)).not.toContain("huge.ts");

		expect(await indexDirectory(root, { maxFileBytes: 1_000, maxFiles: 1 })).toBe(1);
		const boundedMap = generateRepomap(1_000, root);
		expect(boundedMap.match(/^## /gm)?.length ?? 0).toBe(1);
	});

	it("rejects a directory link that escapes the workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-index-link-root-"));
		const outside = await mkdtemp(join(tmpdir(), "nightcode-index-link-outside-"));
		const linkedDirectory = join(root, "linked");
		await writeFile(join(root, "local.ts"), "export function localOnly() {}");
		await writeFile(join(outside, "outside.ts"), "export function escapeOnly() {}");

		try {
			await symlink(outside, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			const code = (error as { code?: string }).code;
			if (code && ["EACCES", "ENOSYS", "EPERM"].includes(code)) return;
			throw error;
		}

		expect(await indexFile(join(linkedDirectory, "outside.ts"), root)).toEqual([]);
		await indexDirectory(root);

		const map = generateRepomap(1_000, root);
		expect(map).toContain("localOnly");
		expect(map).not.toContain("escapeOnly");
		expect(map).not.toContain("outside.ts");
	});

	it("refreshes changed files, removes stale entries, and excludes sensitive sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-index-refresh-"));
		const source = join(root, "feature.ts");
		await writeFile(source, "export function oldFeature() {}");
		await writeFile(join(root, ".env.js"), "export const leakedSecret = 'nope';");
		await indexDirectory(root);
		expect(generateRepomap(1_000, root)).toContain("oldFeature");
		expect(generateRepomap(1_000, root)).not.toContain("leakedSecret");

		await writeFile(source, "export function newFeature() {}");
		const future = new Date(Date.now() + 2_000);
		await utimes(source, future, future);
		await refreshRepositoryIndex(root);
		const refreshed = generateRepomap(1_000, root);
		expect(refreshed).toContain("newFeature");
		expect(refreshed).not.toContain("oldFeature");

		await unlink(source);
		await refreshRepositoryIndex(root);
		expect(generateRepomap(1_000, root)).not.toContain("feature.ts");
	});

	it("compacts honestly without promoting old content to system instructions", () => {
		const compacted = compactMessages(
			[
				{ role: "user", content: "SECRET-OLD-INSTRUCTION" },
				{ role: "assistant", content: "old response" },
				{ role: "user", content: "recent" },
			],
			1,
		);
		expect(compacted[0]?.role).toBe("user");
		expect(compacted[0]?.content).not.toContain("SECRET-OLD-INSTRUCTION");
		expect(compacted.at(-1)?.content).toBe("recent");
	});

	it("bounds pinned context, resolves relative pins from the workspace, and deduplicates aliases", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-context-pins-"));
		const path = join(root, "feature.ts");
		await writeFile(path, "export const feature = true;");
		await indexDirectory(root);
		const config = {
			cwd: root,
			maxTokens: 200,
			minRelevance: 0,
			pinnedFiles: ["feature.ts", path],
		};
		const context = await assembleContext("feature", config);
		expect(context).toHaveLength(1);
		expect(context[0]?.reason).toBe("pinned");
		expect(context[0]?.content).toBe("export const feature = true;");
		expect(context[0]?.tokens).toBe(estimateTokens(context[0]?.content ?? ""));

		await writeFile(path, "x".repeat(100_000));
		const bounded = await assembleContext("feature", { ...config, maxTokens: 100 });
		expect(bounded[0]?.content).toContain("[truncated;");
		expect(bounded.reduce((total, file) => total + file.tokens, 0)).toBeLessThanOrEqual(100);
	});

	it("never lets context pins grant access to external or sensitive files", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-context-boundary-"));
		const outside = await mkdtemp(join(tmpdir(), "nightcode-context-external-"));
		const outsideFile = join(outside, "private.ts");
		await writeFile(outsideFile, "EXTERNAL_SECRET");
		await writeFile(join(root, ".env"), "API_KEY=SECRET");
		await writeFile(join(root, "visible.ts"), "export const visible = true;");
		const context = await assembleContext("", {
			cwd: root,
			maxTokens: 1000,
			minRelevance: 0,
			pinnedFiles: [outsideFile, ".env", "visible.ts"],
		});
		expect(context).toHaveLength(1);
		expect(context[0]?.content).toContain("visible");
	});

	it("revalidates an indexed path after its directory is replaced by an external link", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-context-stale-"));
		const outside = await mkdtemp(join(tmpdir(), "nightcode-context-stale-external-"));
		const nested = join(root, "source");
		await mkdir(nested);
		await writeFile(join(nested, "feature.ts"), "export const feature = true;");
		await writeFile(join(outside, "feature.ts"), "EXTERNAL_SECRET");
		await indexDirectory(root);
		await rename(nested, join(root, "original"));
		await symlink(outside, nested, process.platform === "win32" ? "junction" : "dir");
		const context = await assembleContext("feature", {
			cwd: root,
			maxTokens: 1000,
			minRelevance: 0,
			pinnedFiles: [],
		});
		expect(context).toEqual([]);
	});

	it("includes map headers and separators in its advertised token estimate", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-context-map-budget-"));
		await writeFile(join(root, "small.ts"), "export const small = () => true;");
		await indexDirectory(root);
		for (const maxTokens of [0, 1, 5, 10, 30, 100]) {
			expect(estimateTokens(generateRepomap(maxTokens, root))).toBeLessThanOrEqual(maxTokens);
		}
		expect(generateRepomap(Number.NaN, root)).toBe("");
	});

	it("ignores notices before choosing recent context and handles invalid keep counts", () => {
		const messages = [
			{ role: "user", content: "user objective" },
			{ role: "assistant", content: "assistant evidence" },
			...Array.from({ length: 10 }, () => ({ role: "notice", content: "UI diagnostic" })),
			{ role: "user", content: "continue" },
		];
		const compacted = compactMessages(messages, 3);
		expect(compacted.map((message) => message.content)).toEqual([
			"user objective",
			"assistant evidence",
			"continue",
		]);
		for (const keepLast of [0, -1, Number.NaN]) {
			expect(compactMessages(messages, keepLast).at(-1)?.content).toBe("continue");
		}
	});
});
