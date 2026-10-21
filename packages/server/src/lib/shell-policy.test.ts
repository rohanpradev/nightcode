import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessShellCommand, createToolEnvironment, runShellCommand } from "./shell-policy";

describe("shell policy", () => {
	it("never treats a command after a newline as read-only inspection", () => {
		for (const separator of ["\n", "\r\n", "\r", "\0", "\u2028", "\u2029"]) {
			const command = `git status${separator}some-program`;
			expect(assessShellCommand(command, "on-risk")).toMatchObject({ requiresApproval: true });
			expect(assessShellCommand(command, "never")).toMatchObject({ allowed: false });
		}
	});

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
			"git branch --list -df feature",
			"git branch --list --create-reflog feature",
			"git branch --list --edit-description feature",
			"git status --verbose",
			"git status -v",
			"git status --unknown-future-option",
		]) {
			expect(assessShellCommand(command, "on-risk")).toMatchObject({
				requiresApproval: true,
			});
		}
	});

	it("disables repository fsmonitor hooks for unattended Git inspection", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-git-hook-"));
		const env = await createToolEnvironment(root);
		const init = Bun.spawnSync(["git", "init", "--quiet", root], { env });
		expect(init.exitCode).toBe(0);
		const hook = join(root, ".git", "hooks", "fsmonitor-test");
		const marker = join(root, "hook-ran.txt");
		await writeFile(hook, "#!/bin/sh\nprintf compromised > hook-ran.txt\nprintf '\\0'\n");
		if (process.platform !== "win32") await chmod(hook, 0o755);
		const config = Bun.spawnSync(["git", "config", "core.fsmonitor", ".git/hooks/fsmonitor-test"], {
			cwd: root,
			env,
		});
		expect(config.exitCode).toBe(0);
		const output = await runShellCommand({
			command: "git status --short",
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 10_000,
			maxOutputChars: 2_000,
		});
		expect(output).toContain("exitCode: 0");
		await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		// Establish that the configured hook is executable on this host; otherwise
		// a missing marker would not exercise the regression.
		Bun.spawnSync(["git", "status", "--short"], { cwd: root, env });
		expect(await readFile(marker, "utf8")).toBe("compromised");
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
