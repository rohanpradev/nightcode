import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
});
