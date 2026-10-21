import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStructuredPatch, MAX_PATCH_FILE_BYTES, restorePatch } from "./patch-engine";
import { WorkspaceBoundary } from "./workspace-boundary";

describe("structured patch engine", () => {
	it("inserts replacement tokens literally and preserves UTF-8 BOMs on edit and undo", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-literal-"));
		const boundary = new WorkspaceBoundary(root);
		const path = join(root, "file.txt");
		const before = "\uFEFFprefix TARGET suffix\r\n";
		// biome-ignore lint/suspicious/noTemplateCurlyInString: replacement text must stay literal
		const replacement = "$$ $& $` $' $1 ${name}";
		await writeFile(path, before);
		const patch = await applyStructuredPatch(boundary, [
			{ type: "replace", path, oldText: "TARGET", newText: replacement },
		]);
		expect(await readFile(path, "utf8")).toBe(`\uFEFFprefix ${replacement} suffix\r\n`);
		await restorePatch(patch.snapshots, boundary);
		expect(await readFile(path, "utf8")).toBe(before);
	});

	it("rejects overlapping ambiguous matches before writing", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-overlap-"));
		const path = join(root, "file.txt");
		await writeFile(path, "aaa");
		await expect(
			applyStructuredPatch(new WorkspaceBoundary(root), [
				{ type: "replace", path, oldText: "aa", newText: "b" },
			]),
		).rejects.toThrow("multiple times");
		expect(await readFile(path, "utf8")).toBe("aaa");
	});

	for (const bytes of [new Uint8Array([0xff, 0xfe, 65]), new Uint8Array([65, 0, 66])]) {
		it(`rejects binary snapshots (${bytes.join(",")}) without partial writes`, async () => {
			const root = await mkdtemp(join(tmpdir(), "nightcode-patch-binary-"));
			const path = join(root, "binary.dat");
			await writeFile(path, bytes);
			await expect(
				applyStructuredPatch(new WorkspaceBoundary(root), [
					{ type: "create", path: "new.txt", content: "must not exist" },
					{ type: "delete", path },
				]),
			).rejects.toThrow("UTF-8");
			expect(await Bun.file(join(root, "new.txt")).exists()).toBe(false);
			expect(new Uint8Array(await readFile(path))).toEqual(bytes);
		});
	}

	it("bounds text snapshots and rejects lossy output", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-size-"));
		const boundary = new WorkspaceBoundary(root);
		const path = join(root, "large.txt");
		await writeFile(path, "x".repeat(MAX_PATCH_FILE_BYTES + 1));
		await expect(applyStructuredPatch(boundary, [{ type: "delete", path }])).rejects.toThrow(
			"8 MiB",
		);
		for (const content of ["a\0b", "\ud800", "x".repeat(MAX_PATCH_FILE_BYTES + 1)]) {
			await expect(
				applyStructuredPatch(boundary, [{ type: "create", path: "invalid.txt", content }]),
			).rejects.toThrow("Text patch output");
		}
		expect(await Bun.file(join(root, "invalid.txt")).exists()).toBe(false);
	});

	it("rolls back earlier writes if a later file cannot be created", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-rollback-"));
		await expect(
			applyStructuredPatch(new WorkspaceBoundary(root), [
				{ type: "create", path: "parent", content: "not a directory" },
				{ type: "create", path: "parent/child", content: "cannot write" },
			]),
		).rejects.toThrow();
		expect(await Bun.file(join(root, "parent")).exists()).toBe(false);
	});

	it("rolls back a partially completed undo if a later restore fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-undo-failure-"));
		const boundary = new WorkspaceBoundary(root);
		await writeFile(join(root, "a.txt"), "before-a");
		await writeFile(join(root, "b.txt"), "before-b");
		const patch = await applyStructuredPatch(boundary, [
			{ type: "update", path: "a.txt", content: "after-a" },
			{ type: "update", path: "b.txt", content: "after-b" },
		]);
		const originalRename = fs.rename;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === join(root, "a.txt")) throw new Error("injected restore failure");
			return originalRename(from, to);
		});
		try {
			await expect(restorePatch(patch.snapshots, boundary)).rejects.toThrow(
				"injected restore failure",
			);
		} finally {
			renameSpy.mockRestore();
		}
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("after-a");
		expect(await readFile(join(root, "b.txt"), "utf8")).toBe("after-b");
	});

	it("reports failed rollback paths while continuing to restore other files", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-rollback-failure-"));
		for (const name of ["a", "b", "c"]) await writeFile(join(root, `${name}.txt`), "before");
		const originalRename = fs.rename;
		let bWrites = 0;
		const renameSpy = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (to === join(root, "c.txt")) throw new Error("injected write failure");
			if (to === join(root, "b.txt") && ++bWrites === 2)
				throw new Error("injected rollback failure");
			return originalRename(from, to);
		});
		try {
			await expect(
				applyStructuredPatch(new WorkspaceBoundary(root), [
					{ type: "update", path: "a.txt", content: "after" },
					{ type: "update", path: "b.txt", content: "after" },
					{ type: "update", path: "c.txt", content: "after" },
				]),
			).rejects.toThrow(`Could not roll back ${join(root, "b.txt")}`);
		} finally {
			renameSpy.mockRestore();
		}
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("before");
		expect(await readFile(join(root, "b.txt"), "utf8")).toBe("after");
		expect(await readFile(join(root, "c.txt"), "utf8")).toBe("before");
	});

	it("refuses undo after a patched directory becomes a junction", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-junction-"));
		const outside = await mkdtemp(join(tmpdir(), "nightcode-patch-external-"));
		const directory = join(root, "nested");
		await mkdir(directory);
		await writeFile(join(directory, "file.txt"), "before");
		const boundary = new WorkspaceBoundary(root);
		const patch = await applyStructuredPatch(boundary, [
			{ type: "update", path: "nested/file.txt", content: "after" },
		]);
		await rename(directory, join(root, "original"));
		await writeFile(join(outside, "file.txt"), "after");
		await symlink(outside, directory, "junction");
		await expect(restorePatch(patch.snapshots, boundary)).rejects.toThrow("outside allowed roots");
		expect(await readFile(join(outside, "file.txt"), "utf8")).toBe("after");
	});

	it("validates the whole batch before mutating any file", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-"));
		await writeFile(join(root, "a.txt"), "original-a");
		await writeFile(join(root, "b.txt"), "original-b");
		const boundary = new WorkspaceBoundary(root);

		await expect(
			applyStructuredPatch(boundary, [
				{ type: "update", path: "a.txt", content: "changed-a" },
				{ type: "replace", path: "b.txt", oldText: "missing", newText: "changed-b" },
			]),
		).rejects.toThrow("oldText not found");
		expect(await readFile(join(root, "a.txt"), "utf8")).toBe("original-a");
	});

	it("restores a checkpoint only when patched files have not changed afterward", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-patch-"));
		const target = join(root, "file.txt");
		await writeFile(target, "before");
		const result = await applyStructuredPatch(new WorkspaceBoundary(root), [
			{ type: "update", path: "file.txt", content: "after" },
		]);

		await restorePatch(result.snapshots, new WorkspaceBoundary(root));
		expect(await readFile(target, "utf8")).toBe("before");

		const second = await applyStructuredPatch(new WorkspaceBoundary(root), [
			{ type: "update", path: "file.txt", content: "agent-change" },
		]);
		await writeFile(target, "user-change");
		await expect(restorePatch(second.snapshots, new WorkspaceBoundary(root))).rejects.toThrow(
			"changed afterward",
		);
		expect(await readFile(target, "utf8")).toBe("user-change");
	});
});
