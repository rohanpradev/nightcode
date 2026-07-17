import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessShellCommand, createToolEnvironment } from "./shell-policy";

describe("shell policy", () => {
	it("catches common indirection and external-write bypasses", () => {
		expect(assessShellCommand("git -C . reset --hard", "on-risk")).toMatchObject({
			risk: "high",
			requiresApproval: true,
		});
		expect(assessShellCommand("Set-Content C:\\outside.txt value", "on-risk")).toMatchObject({
			risk: "high",
			requiresApproval: true,
		});
		expect(assessShellCommand("python cleanup.py", "on-risk")).toMatchObject({
			risk: "medium",
			requiresApproval: true,
		});
	});

	it("allows read-only workspace inspection without approval", () => {
		expect(assessShellCommand("git status --short", "on-risk")).toMatchObject({
			allowed: true,
			risk: "low",
			requiresApproval: false,
		});
		expect(assessShellCommand("git branch --list 'codex/*'", "on-risk")).toMatchObject({
			risk: "low",
			requiresApproval: false,
		});
	});

	it("gates content-producing git commands that can expose sensitive files", () => {
		for (const command of ["git diff", "git show HEAD:.env", "git grep TOKEN", "git log -p"]) {
			expect(assessShellCommand(command, "on-risk")).toMatchObject({
				risk: "medium",
				requiresApproval: true,
			});
		}
	});

	it("denies generic shell execution in non-interactive never mode", () => {
		expect(assessShellCommand("Get-Content .env", "never")).toMatchObject({
			allowed: false,
			risk: "medium",
			requiresApproval: false,
		});
		expect(assessShellCommand("git status --short", "never")).toMatchObject({
			allowed: true,
			risk: "low",
		});
	});

	it("does not misclassify write-capable git flags or shell substitution as inspection", () => {
		for (const command of [
			"git branch feature",
			"git branch -D feature",
			"git diff --output=patch.txt",
			"git log --output history.txt",
			"git show $(touch injected.txt)",
		]) {
			expect(assessShellCommand(command, "on-risk")).toMatchObject({
				requiresApproval: true,
			});
		}
	});

	it("does not pass provider credentials to child processes", async () => {
		const previous = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "must-not-leak";
		try {
			const root = await mkdtemp(join(tmpdir(), "nightcode-env-"));
			const env = await createToolEnvironment(root);
			expect(env.OPENAI_API_KEY).toBeUndefined();
			expect(env.HOME?.startsWith(root)).toBe(false);
			expect(env.HOME).toContain("nightcode-sandboxes");
		} finally {
			if (previous == null) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = previous;
		}
	});
});
