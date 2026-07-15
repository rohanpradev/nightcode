import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { evaluateShellCommandSafety, resolveWorkspacePath } from "./llm";

describe("LLM service tool safety", () => {
	it("resolves relative tool paths from the active workspace root", () => {
		const workspaceRoot = resolve("fixtures", "project");

		expect(resolveWorkspacePath("src/index.ts", workspaceRoot)).toBe(
			resolve(workspaceRoot, "src/index.ts"),
		);
		expect(resolveWorkspacePath(".", workspaceRoot)).toBe(workspaceRoot);
	});

	it("preserves absolute tool paths", () => {
		const workspaceRoot = resolve("fixtures", "project");
		const absolutePath = resolve("outside", "file.txt");

		expect(resolveWorkspacePath(absolutePath, workspaceRoot)).toBe(absolutePath);
	});

	it("expands home-prefixed tool paths before resolving", () => {
		const workspaceRoot = resolve("fixtures", "project");

		expect(resolveWorkspacePath("~/notes.txt", workspaceRoot)).toBe(
			resolve(homedir(), "notes.txt"),
		);
	});

	it("blocks known destructive shell command patterns", () => {
		expect(evaluateShellCommandSafety("git reset --hard").allowed).toBe(false);
		expect(evaluateShellCommandSafety("rm -rf dist").allowed).toBe(false);
		expect(evaluateShellCommandSafety("bun test").allowed).toBe(true);
	});
});
