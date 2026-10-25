import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
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

	it("returns a bounded prefix of an oversized line and stops reading the file", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-long-line-"));
		const path = join(root, "minified.txt");
		const size = 8 * 1024 * 1024;
		await writeFile(path, "x".repeat(size));
		const original = fs.createReadStream;
		let input: fs.ReadStream | undefined;
		const readSpy = spyOn(fs, "createReadStream").mockImplementation((path, options) => {
			input = original(path, options);
			return input;
		});
		try {
			const result = await readLineRange(path, 1, 1, 20);
			expect(result).toBe(`1: ${"x".repeat(16)}\n[truncated at 20 characters]`);
			expect(input?.bytesRead).toBeLessThan(size);
			expect(input?.destroyed).toBe(true);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("discards long skipped lines before reading the requested range", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-skip-line-"));
		const path = join(root, "source.txt");
		await writeFile(path, `${"x".repeat(2 * 1024 * 1024)}\nsecond\nthird\n`);
		expect(await readLineRange(path, 2, 3, 100)).toBe("2: second\n3: third");
	});

	it("preserves BOMs, Unicode and line endings across stream chunk boundaries", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-chunks-"));
		const path = join(root, "source.txt");
		// Split the four-byte emoji and the second CRLF across 64 KiB byte chunks.
		const first = `\uFEFF${"a".repeat(65_532)}😀`;
		const second = "b".repeat(65_530);
		await writeFile(path, `${first}\r\n${second}\r\nthird\rfourth\nlast`);
		expect(await readLineRange(path, 1, 5, 200_000)).toBe(
			`1: ${first}\n2: ${second}\n3: third\n4: fourth\n5: last`,
		);
		await writeFile(path, "x😀tail");
		expect(await readLineRange(path, 1, 1, 6)).toBe("1: x\n[truncated at 6 characters]");
	});

	it("stops after the requested range without reading the remaining file", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-range-"));
		const path = join(root, "source.txt");
		const size = 2 * 1024 * 1024;
		await writeFile(path, `first\n${"x".repeat(size)}`);
		const original = fs.createReadStream;
		let input: fs.ReadStream | undefined;
		const readSpy = spyOn(fs, "createReadStream").mockImplementation((path, options) => {
			input = original(path, options);
			return input;
		});
		try {
			expect(await readLineRange(path, 1, 1, 100)).toBe("1: first");
			expect(input?.bytesRead).toBeLessThan(size);
			expect(input?.destroyed).toBe(true);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("cancels a pending read with the caller's abort reason", async () => {
		const input = new PassThrough();
		input.setEncoding("utf8");
		input.write("first\n");
		const readSpy = spyOn(fs, "createReadStream").mockReturnValue(
			input as unknown as fs.ReadStream,
		);
		const controller = new AbortController();
		const reason = new Error("cancelled pending file read");
		const timeout = setTimeout(() => controller.abort(reason), 10);
		try {
			await expect(readLineRange("unused", 1, 2, 100, controller.signal)).rejects.toBe(reason);
			expect(input.destroyed).toBe(true);
			await expect(readLineRange("unused", 1, 2, 100, controller.signal)).rejects.toBe(reason);
			expect(readSpy).toHaveBeenCalledTimes(1);
		} finally {
			clearTimeout(timeout);
			input.destroy();
			readSpy.mockRestore();
		}
	});

	it("propagates filesystem read failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-bounded-error-"));
		await expect(readLineRange(join(root, "missing.txt"), 1, 1, 100)).rejects.toThrow("ENOENT");
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
