import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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

const HIGH_RISK_PATTERNS: Array<[RegExp, string]> = [
	[/\brm\b|\brmdir\b|\bdel\b|\berase\b|\bRemove-Item\b|\brd\s+\/s\b/i, "deletion command"],
	[/\bgit\b[^\r\n;&|]*\s(?:reset|clean|restore|checkout)\b/i, "working-tree rewrite"],
	[
		/\bgit\s+(?:push|commit|merge|rebase|tag)\b/i,
		"externally visible or history-changing git command",
	],
	[/\b(?:format|mkfs|diskpart|dd)\b/i, "disk operation"],
	[/\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|ssh|scp|ftp)\b/i, "network command"],
	[
		/\b(?:eval|Invoke-Expression)\b|\b(?:node|bun|python|python3|ruby|perl)\s+(?:-e|-c)\b/i,
		"dynamic code execution",
	],
	[/\bSet-ExecutionPolicy\b|\bStart-Process\b/i, "process or execution-policy change"],
	[/>\s*(?:\/dev\/|\\\\\.\\PhysicalDrive)/i, "raw device write"],
];

const MEDIUM_RISK_PATTERNS: Array<[RegExp, string]> = [
	[/[>|;&]|\|\||&&/, "shell composition or redirection"],
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
	return [
		/^\s*git\s+(?:status|diff|log|show|grep|branch)(?:\s|$)/i,
		/^\s*rg(?:\s|$)/i,
		/^\s*(?:Get-ChildItem|Select-String|Get-Content)(?:\s|$)/i,
	].some((pattern) => pattern.test(command));
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
		allowed: true,
		risk,
		reason,
		requiresApproval: approvalMode === "always" || (approvalMode === "on-risk" && risk !== "low"),
	};
}

/** Provider credentials and arbitrary host variables never reach model-generated subprocesses. */
export async function createToolEnvironment(
	workspaceRoot: string,
): Promise<Record<string, string>> {
	const sandboxHome = resolve(workspaceRoot, ".nightcode", "sandbox-home");
	const sandboxTemp = resolve(workspaceRoot, ".nightcode", "tmp");
	await Promise.all([
		mkdir(sandboxHome, { recursive: true }),
		mkdir(sandboxTemp, { recursive: true }),
	]);

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
