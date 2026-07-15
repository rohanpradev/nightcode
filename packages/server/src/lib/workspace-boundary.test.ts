import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceBoundary, WorkspaceBoundaryError } from "./workspace-boundary";

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
});
