import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyStructuredPatch, restorePatch } from "./patch-engine";
import { WorkspaceBoundary } from "./workspace-boundary";

describe("structured patch engine", () => {
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

		await restorePatch(result.snapshots);
		expect(await readFile(target, "utf8")).toBe("before");

		const second = await applyStructuredPatch(new WorkspaceBoundary(root), [
			{ type: "update", path: "file.txt", content: "agent-change" },
		]);
		await writeFile(target, "user-change");
		await expect(restorePatch(second.snapshots)).rejects.toThrow("changed afterward");
		expect(await readFile(target, "utf8")).toBe("user-change");
	});
});
