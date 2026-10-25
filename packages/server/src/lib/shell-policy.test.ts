import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessShellCommand, createToolEnvironment, runShellCommand } from "./shell-policy";

function scriptCommand(path: string): string {
	const quote = (value: string) =>
		process.platform === "win32"
			? `'${value.replaceAll("'", "''")}'`
			: `'${value.replaceAll("'", "'\\''")}'`;
	return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(path)}`;
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error("shell cancellation did not finish")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

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

	it.each(["timeout", "abort"] as const)(
		"stops descendants and releases their output pipes on %s",
		async (mode) => {
			const root = await mkdtemp(join(tmpdir(), "nightcode-shell-tree-"));
			const parentPidFile = join(root, "parent.pid");
			const childPidFile = join(root, "child.pid");
			const parentScript = join(root, "parent.ts");
			const childScript = join(root, "child.ts");
			await writeFile(
				childScript,
				`import { rename } from "node:fs/promises";
console.log("child-ready");
await Bun.write(${JSON.stringify(`${childPidFile}.tmp`)}, String(process.pid));
await rename(${JSON.stringify(`${childPidFile}.tmp`)}, ${JSON.stringify(childPidFile)});
await Bun.sleep(30_000);`,
			);
			await writeFile(
				parentScript,
				`await Bun.write(${JSON.stringify(parentPidFile)}, String(process.pid));
const child = Bun.spawn([process.execPath, ${JSON.stringify(childScript)}], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit"
});
await child.exited;`,
			);
			const unrelated = Bun.spawn([process.execPath, "-e", "await Bun.sleep(30_000)"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			const controller = new AbortController();
			const result = runShellCommand({
				command: scriptCommand(parentScript),
				cwd: root,
				workspaceRoot: root,
				timeoutMs: mode === "timeout" ? 4000 : 10_000,
				maxOutputChars: 1000,
				abortSignal: controller.signal,
			});
			void result.catch(() => {});
			const pids: number[] = [];
			try {
				const readyDeadline = Date.now() + 3500;
				while (!(await Bun.file(childPidFile).exists())) {
					if (Date.now() >= readyDeadline) throw new Error("shell descendant did not start");
					await Bun.sleep(20);
				}
				for (const path of [parentPidFile, childPidFile]) {
					const pid = Number(await readFile(path, "utf8"));
					expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
					pids.push(pid);
				}
				if (mode === "abort") controller.abort(new Error("test stop"));
				const output = await within(result, mode === "timeout" ? 5000 : 3000);
				expect(output).toContain("child-ready");
				expect(output).not.toContain("exitCode: 0");
				const exitDeadline = Date.now() + 1000;
				while (pids.some(processExists) && Date.now() < exitDeadline) await Bun.sleep(20);
				for (const pid of pids) expect(processExists(pid)).toBe(false);
				expect(unrelated.exitCode).toBeNull();
			} finally {
				controller.abort();
				// These PIDs belong only to this test's disposable fixture processes.
				for (const pid of pids.reverse()) {
					if (processExists(pid)) process.kill(pid, "SIGKILL");
				}
				unrelated.kill("SIGKILL");
				await unrelated.exited;
				await within(
					result.catch(() => {}),
					2000,
				);
			}
		},
		12_000,
	);

	it("does not launch a command aborted while its environment is being prepared", async () => {
		const root = await mkdtemp(join(tmpdir(), "nightcode-shell-early-abort-"));
		const script = join(root, "must-not-run.ts");
		const marker = join(root, "started.txt");
		await writeFile(script, `await Bun.write(${JSON.stringify(marker)}, "started");`);
		const controller = new AbortController();
		const reason = new Error("cancelled during preparation");
		const result = runShellCommand({
			command: scriptCommand(script),
			cwd: root,
			workspaceRoot: root,
			timeoutMs: 5000,
			maxOutputChars: 100,
			abortSignal: controller.signal,
		});
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(await Bun.file(marker).exists()).toBe(false);
	});
});
