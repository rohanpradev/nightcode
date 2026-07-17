import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, WorkspaceBoundary, WorkspaceBoundaryError } from "./workspace-boundary";

describe("WorkspaceBoundary", () => {
	it("authorizes contained files and rejects lexical traversal", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-boundary-"));
		await writeFile(join(root, "inside.txt"), "safe");
		const boundary = new WorkspaceBoundary(root);

		await expect(boundary.authorize("inside.txt")).resolves.toMatchObject({
			exists: true,
			external: false,
		});
		await expect(boundary.authorize("../outside.txt", "write")).rejects.toBeInstanceOf(
			WorkspaceBoundaryError,
		);
	});

	it("resolves directory junctions before authorizing paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-boundary-root-"));
		const outside = await mkdtemp(join(tmpdir(), "nightcode-boundary-outside-"));
		await writeFile(join(outside, "secret.txt"), "secret");
		await mkdir(join(root, "links"));
		try {
			await symlink(outside, join(root, "links", "escape"), "junction");
		} catch {
			return; // Junction creation can be disabled by the host OS policy.
		}

		const boundary = new WorkspaceBoundary(root);
		await expect(boundary.authorize("links/escape/secret.txt")).rejects.toBeInstanceOf(
			WorkspaceBoundaryError,
		);
		await expect(boundary.authorize("links/escape/new.txt", "write")).rejects.toBeInstanceOf(
			WorkspaceBoundaryError,
		);
	});

	it("preserves executable file mode across atomic replacement", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "nightcode-atomic-mode-"));
		const path = join(root, "script.sh");
		await writeFile(path, "old\n");
		await chmod(path, 0o755);

		await atomicWriteFile(path, "new\n");

		expect((await stat(path)).mode & 0o777).toBe(0o755);
	});
});
