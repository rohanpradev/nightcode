import { describe, expect, it } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLineRange, readTextPrefix, sha256File } from "./bounded-files";

describe("bounded file reads", () => {
	it("reads prefixes and line ranges without returning unbounded content", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-read-"));
		const path = join(root, "large.txt");
		await writeFile(path, `${"x".repeat(100)}\nsecond\nthird\n`);

		const prefix = await readTextPrefix(path, 20);
		expect(prefix.startsWith("x".repeat(20))).toBe(true);
		expect(prefix).toContain("truncated");
		expect(await readLineRange(path, 2, 3, 100)).toBe("2: second\n3: third");
	});

	it("hashes a file incrementally", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-hash-"));
		const path = join(root, "value.txt");
		await writeFile(path, "value");
		expect(await sha256File(path)).toBe(
			new Bun.CryptoHasher("sha256").update("value").digest("hex"),
		);
	});
});
