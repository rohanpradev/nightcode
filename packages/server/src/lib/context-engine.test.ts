import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactMessages, generateRepomap, getSymbolCount, indexDirectory } from "./context-engine";

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
