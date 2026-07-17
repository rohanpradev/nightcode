import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ApprovalMode } from "@nightcode/shared";

export type CommandRisk = "low" | "medium" | "high";

export interface CommandAssessment {
	allowed: boolean;
	risk: CommandRisk;
	reason: string;
	requiresApproval: boolean;
}

const SECRET_NAME =
	/(?:API[_-]?KEY|AUTH[_-]?TOKEN|PASSWORD|SECRET|PRIVATE[_-]?KEY|ACCESS[_-]?TOKEN|OPENAI|ANTHROPIC|AZURE)/i;

let toolSandboxBasePromise: Promise<string> | undefined;

function toolSandboxBase(): Promise<string> {
	toolSandboxBasePromise ??= mkdtemp(join(tmpdir(), "nightcode-sandboxes-")).then(async (path) => {
		if (process.platform !== "win32") await chmod(path, 0o700);
		return realpath(path);
	});
	return toolSandboxBasePromise;
}

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
	[/\brm\b|\brmdir\b|\bdel\b|\berase\b|\bRemove-Item\b|\brd\s+\/s\b/i, "deletion command"],
	[/\bgit\b[^\r\n;&|]*\s(?:reset|clean|restore|checkout)\b/i, "working-tree rewrite"],
	[
		/\bgit\s+(?:push|commit|merge|rebase|tag|clone|fetch|pull)\b/i,
		"externally visible or history-changing git command",
	],
	[/\b(?:format|mkfs|diskpart|dd)\b/i, "disk operation"],
	[/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|ftp)\b/i, "network command"],
	[
		/\b(?:eval|Invoke-Expression)\b|\b(?:node|bun|python|python3|ruby|perl)\s+(?:-e|-c)\b|\b(?:sh|bash|zsh|cmd|powershell|pwsh)\b[^\r\n]*(?:-c|-Command)\b/i,
		"dynamic code execution",
	],
	[/\bSet-ExecutionPolicy\b|\bStart-Process\b/i, "process or execution-policy change"],
	[/>\s*(?:\/dev\/|\\\\\.\\PhysicalDrive)/i, "raw device write"],
];

const MEDIUM_RISK_PATTERNS: Array<[RegExp, string]> = [
	[/[<>|;&`]|\$\(|\|\||&&/, "shell composition, substitution, or redirection"],
	[
		/\b(?:Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|touch|mkdir|mv|cp)\b/i,
		"filesystem mutation",
	],
	[
		/\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|remove|update|upgrade|publish)\b/i,
		"dependency or registry mutation",
	],
	[
		/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|test|check|lint|typecheck)\b/i,
		"project code execution",
	],
	[/\b(?:cargo|go|dotnet|mvn|gradle)\s+(?:test|build|run)\b/i, "project code execution"],
	[/\b(?:node|bun|python|python3|ruby|perl)\b/i, "general-purpose interpreter"],
];

function hasExternalPathSyntax(command: string): boolean {
	return (
		/(?:^|\s)\.\.(?:[\\/]|\s|$)/.test(command) ||
		/(?:^|\s)~[\\/]/.test(command) ||
		/\b[A-Za-z]:[\\/]/.test(command) ||
		/(?:^|\s)\/(?:etc|home|root|Users|var|opt|tmp)\b/.test(command) ||
		/--no-index\b/.test(command)
	);
}

function isReadOnlyInspection(command: string): boolean {
	if (hasExternalPathSyntax(command)) return false;
	if (
		/--(?:ext-diff|textconv|open-files-in-pager|output)(?:\b|=)/i.test(command) ||
		/\s--paginate\b/i.test(command)
	) {
		return false;
	}
	if (/^\s*git\s+status(?:\s|$)/i.test(command)) return true;

	const branch = command.match(/^\s*git\s+branch(?:\s+(.*))?$/i);
	if (!branch) return false;
	const args = branch[1]?.trim() ?? "";
	if (!args || args === "--show-current") return true;
	if (!/(?:^|\s)--list(?:\s|=|$)/i.test(args)) return false;
	return !/(?:^|\s)(?:-[dDmMcCuUf]|--(?:delete|move|copy|create-reflog|edit-description|set-upstream-to|unset-upstream|track|no-track|force))(?:\s|=|$)/i.test(
		args,
	);
}

export function assessShellCommand(
	command: string,
	approvalMode: ApprovalMode = "on-risk",
): CommandAssessment {
	const normalized = command.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return {
			allowed: false,
			risk: "high",
			reason: "empty command",
			requiresApproval: true,
		};
	}

	for (const [pattern, reason] of HIGH_RISK_PATTERNS) {
		if (pattern.test(normalized)) {
			return {
				allowed: approvalMode !== "never",
				risk: "high",
				reason,
				requiresApproval: approvalMode !== "never",
			};
		}
	}

	if (
		hasExternalPathSyntax(normalized) &&
		/\b(?:Set-Content|Add-Content|Out-File|Move-Item|Copy-Item|New-Item|Remove-Item|touch|mkdir|mv|cp|rm|del|erase)\b/i.test(
			normalized,
		)
	) {
		return {
			allowed: approvalMode !== "never",
			risk: "high",
			reason: "filesystem mutation outside the workspace",
			requiresApproval: approvalMode !== "never",
		};
	}

	let risk: CommandRisk = isReadOnlyInspection(normalized) ? "low" : "medium";
	let reason = risk === "low" ? "read-only workspace inspection" : "general shell execution";
	for (const [pattern, matchReason] of MEDIUM_RISK_PATTERNS) {
		if (pattern.test(normalized)) {
			risk = "medium";
			reason = matchReason;
			break;
		}
	}

	return {
		allowed: approvalMode !== "never" || risk === "low",
		risk,
		reason,
		requiresApproval:
			approvalMode !== "never" &&
			(approvalMode === "always" || (approvalMode === "on-risk" && risk !== "low")),
	};
}

/** Provider credentials and arbitrary host variables never reach model-generated subprocesses. */
export async function createToolEnvironment(
	workspaceRoot: string,
): Promise<Record<string, string>> {
	const canonicalBase = await toolSandboxBase();
	const canonicalWorkspace = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot));
	const workspaceKey = new Bun.CryptoHasher("sha256")
		.update(process.platform === "win32" ? canonicalWorkspace.toLowerCase() : canonicalWorkspace)
		.digest("hex")
		.slice(0, 32);
	const requestedSandbox = join(canonicalBase, workspaceKey);
	await mkdir(requestedSandbox, { recursive: true });
	const canonicalSandbox = await realpath(requestedSandbox);
	assertContained(canonicalBase, canonicalSandbox);
	const sandboxHome = join(canonicalSandbox, "home");
	const sandboxTemp = join(canonicalSandbox, "tmp");
	await Promise.all([
		mkdir(sandboxHome, { recursive: true }),
		mkdir(sandboxTemp, { recursive: true }),
	]);
	assertContained(canonicalSandbox, await realpath(sandboxHome));
	assertContained(canonicalSandbox, await realpath(sandboxTemp));

	const allowedNames = new Set([
		"PATH",
		"PATHEXT",
		"SYSTEMROOT",
		"WINDIR",
		"COMSPEC",
		"TERM",
		"COLORTERM",
		"NO_COLOR",
		"CI",
	]);
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (!value || !allowedNames.has(name.toUpperCase()) || SECRET_NAME.test(name)) continue;
		env[name] = value;
	}

	env.HOME = sandboxHome;
	env.USERPROFILE = sandboxHome;
	env.TMP = sandboxTemp;
	env.TEMP = sandboxTemp;
	env.NIGHTCODE_SANDBOX = "1";
	return env;
}

function assertContained(root: string, candidate: string): void {
	const fromRoot = relative(root, candidate);
	if (
		fromRoot === "" ||
		(!isAbsolute(fromRoot) &&
			fromRoot !== ".." &&
			!fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
	) {
		return;
	}
	throw new Error(`Tool sandbox path escapes trusted temporary root: ${candidate}`);
}

async function readLimited(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<{ text: string; discarded: number }> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let discarded = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		const chunk = decoder.decode(value, { stream: true });
		const remaining = Math.max(0, limit - text.length);
		text += chunk.slice(0, remaining);
		discarded += Math.max(0, chunk.length - remaining);
	}
	text += decoder.decode();
	return { text, discarded };
}

function shellCommand(command: string): string[] {
	return process.platform === "win32"
		? ["powershell", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
		: ["sh", "-lc", command];
}

export interface RunShellOptions {
	command: string;
	cwd: string;
	workspaceRoot: string;
	timeoutMs: number;
	maxOutputChars: number;
	abortSignal?: AbortSignal;
}

export async function runShellCommand(options: RunShellOptions): Promise<string> {
	if (options.abortSignal?.aborted) {
		throw options.abortSignal.reason ?? new Error("shell command aborted before start");
	}
	const controller = new AbortController();
	const abort = () => controller.abort(options.abortSignal?.reason ?? "aborted");
	options.abortSignal?.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(
		() => controller.abort(`timeout after ${options.timeoutMs}ms`),
		options.timeoutMs,
	);

	try {
		const proc = Bun.spawn(shellCommand(options.command), {
			cwd: options.cwd,
			env: await createToolEnvironment(options.workspaceRoot),
			stdout: "pipe",
			stderr: "pipe",
			signal: controller.signal,
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			readLimited(proc.stdout, options.maxOutputChars),
			readLimited(proc.stderr, options.maxOutputChars),
			proc.exited,
		]);
		const truncated = stdout.discarded + stderr.discarded;
		return [
			`exitCode: ${exitCode}`,
			stdout.text ? `stdout:\n${stdout.text.trimEnd()}` : "",
			stderr.text ? `stderr:\n${stderr.text.trimEnd()}` : "",
			truncated > 0 ? `[truncated ${truncated} chars]` : "",
		]
			.filter(Boolean)
			.join("\n\n");
	} finally {
		clearTimeout(timeout);
		options.abortSignal?.removeEventListener("abort", abort);
	}
}
