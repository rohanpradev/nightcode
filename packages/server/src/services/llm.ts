import { type ModelMessage, stepCountIs, ToolLoopAgent, tool } from "ai";
import "../lib/env";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import {
	type LLMConfig,
	type LLMMessage,
	type LLMStreamChunk,
	llmConfigSchema,
	type SupportedProvider,
	supportedChatModels,
} from "@nightcode/shared";
import { z } from "zod";
import {
	discoverAgentProfiles,
	formatAgentProfileCatalog,
	loadAgentProfile,
} from "../lib/agent-profiles";
import { loadProjectConfig, type ProjectConfig } from "../lib/config-loader";
import { discoverLspServers, formatLspCatalog } from "../lib/lsp-config";
import { discoverSkills, formatSkillCatalog, loadSkill } from "../lib/skills";
import { logger } from "./logger";
import { modelRouter } from "./model-router";

export type { LLMConfig, LLMMessage, LLMStreamChunk, SupportedProvider as LLMProvider };

export interface LLMService {
	readonly workspaceRoot: string;
	readonly config: LLMConfig;
	getTaskPlan(): AgentTaskPlan;
	configure(config: Partial<LLMConfig>): void;
	setWorkspace(path: string): void;
	stream(messages: LLMMessage[], config?: Partial<LLMConfig>): AsyncGenerator<LLMStreamChunk>;
	getAvailableProviders(): Array<{
		provider: SupportedProvider;
		available: boolean;
		reason?: string;
	}>;
	addAllowedPath(path: string): void;
}

const DEFAULT_SYSTEM_PROMPT = [
	"You are Night Code, a terminal-first coding agent.",
	"Operate like a senior pair-programmer inside the user's project.",
	"Start from exact local context: inspect files, search symbols, and read relevant code before changing behavior.",
	"Work in a tight loop: understand the task, make a short plan for non-trivial work, act with tools, verify with focused checks, then report the outcome.",
	"For implementation work, keep edits scoped, preserve existing style, run the most relevant verification, and report what changed plus any remaining risk.",
	"For reviews, lead with concrete findings ordered by severity and include file/line references when possible.",
	"For planning, be brief and actionable; for execution, continue through implementation and verification unless the user asks you to stop.",
	"When tools are available, prefer fast local commands such as rg, targeted file reads, and project scripts over guesses.",
	"Use updateTaskPlan for non-trivial work before editing files, keep exactly one step in progress, and mark verification explicitly.",
	"Do not claim that you ran tests, builds, or commands unless the tool result confirms it.",
	"Before destructive commands or broad rewrites, ask for explicit user confirmation.",
].join("\n");

const MAX_TOOL_OUTPUT_CHARS = 60_000;
const DEFAULT_MAX_AGENT_STEPS = 8;

type AgentStreamPart = {
	type: string;
	[key: string]: unknown;
};

const taskStatusSchema = z.enum(["pending", "in_progress", "completed", "blocked"]);

const taskPlanItemSchema = z.object({
	id: z.string().min(1).max(40),
	title: z.string().min(1).max(160),
	status: taskStatusSchema,
	note: z.string().max(300).optional(),
});

export type AgentTaskPlanItem = z.infer<typeof taskPlanItemSchema>;

export interface AgentTaskPlan {
	summary: string | null;
	items: AgentTaskPlanItem[];
	verification: string[];
	updatedAt: string | null;
}

export type ShellSafetyVerdict = {
	allowed: boolean;
	reason?: string;
};

function trimToolOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
	if (output.length <= limit) return output;
	return `${output.slice(0, limit)}\n\n[truncated ${output.length - limit} chars]`;
}

function resolveConfiguredPath(path: string, rootDir: string): string {
	const expanded = expandHomePath(path);
	return isAbsolute(expanded) ? resolve(expanded) : resolve(rootDir, expanded);
}

function buildSystemPrompt(projectConfig: ProjectConfig, rootDir: string): string {
	const envPrompt = process.env.NIGHTCODE_SYSTEM_PROMPT?.trim();
	if (envPrompt) return envPrompt;

	return [
		DEFAULT_SYSTEM_PROMPT,
		projectConfig.instructions,
		formatAgentProfileCatalog(discoverAgentProfiles(rootDir)),
		formatSkillCatalog(discoverSkills(rootDir)),
		formatLspCatalog(discoverLspServers(rootDir)),
	]
		.filter(Boolean)
		.join("\n\n");
}

function initialConfig(projectConfig: ProjectConfig, rootDir: string): LLMConfig {
	return llmConfigSchema.parse({
		provider: process.env.NIGHTCODE_PROVIDER ?? "openai",
		model: process.env.NIGHTCODE_MODEL ?? projectConfig.config.model ?? "gpt-5.5",
		maxTokens: Number(process.env.NIGHTCODE_MAX_TOKENS ?? projectConfig.config.maxTokens ?? 8192),
		temperature: Number(
			process.env.NIGHTCODE_TEMPERATURE ?? projectConfig.config.temperature ?? 0.2,
		),
		systemPrompt: buildSystemPrompt(projectConfig, rootDir),
		agentMode: process.env.NIGHTCODE_AGENT_MODE
			? process.env.NIGHTCODE_AGENT_MODE !== "false"
			: true,
	});
}

function configuredMaxAgentSteps(projectConfig: ProjectConfig): number {
	const raw = Number(
		process.env.NIGHTCODE_MAX_AGENT_STEPS ??
			projectConfig.config.maxAgentSteps ??
			DEFAULT_MAX_AGENT_STEPS,
	);

	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_AGENT_STEPS;
}

function allowDangerousShell(projectConfig: ProjectConfig): boolean {
	return (
		process.env.NIGHTCODE_ALLOW_DANGEROUS_SHELL === "true" ||
		projectConfig.config.allowDangerousShell === true
	);
}

function requirePlanForEdits(projectConfig: ProjectConfig): boolean {
	return projectConfig.config.requirePlanForEdits !== false;
}

function evaluateShellSafety(command: string): ShellSafetyVerdict {
	const normalized = command.replace(/\s+/g, " ").trim();
	const checks: Array<[RegExp, string]> = [
		[/\brm\s+[^;&|]*-[^\s;&|]*[rf][^\s;&|]*/i, "recursive/force rm"],
		[/\brmdir\s+[^;&|]*(\/s|-r|--recursive)/i, "recursive directory removal"],
		[/\bdel\s+[^;&|]*(\/s|\*)/i, "recursive or wildcard delete"],
		[/\bRemove-Item\b[^;&|]*(-Recurse|-r)\b/i, "recursive PowerShell removal"],
		[/\bgit\s+reset\s+--hard\b/i, "hard git reset"],
		[/\bgit\s+clean\s+-[^\s;&|]*f/i, "force git clean"],
		[/\bgit\s+checkout\s+--\s/i, "git checkout path revert"],
		[/\bgit\s+restore\b[^;&|]*\s--source\b/i, "git restore from another source"],
		[/\b(format|mkfs|diskpart)\b/i, "disk formatting command"],
		[/>\s*(\/dev\/sd[a-z]|\\\\\.\\PhysicalDrive\d+)/i, "raw disk write"],
		[/\bSet-ExecutionPolicy\s+Unrestricted\b/i, "unrestricted execution policy"],
	];

	for (const [pattern, reason] of checks) {
		if (pattern.test(normalized)) {
			return { allowed: false, reason };
		}
	}

	return { allowed: true };
}

export function evaluateShellCommandSafety(command: string): ShellSafetyVerdict {
	return evaluateShellSafety(command);
}

function formatTaskPlan(plan: AgentTaskPlan): string {
	if (plan.items.length === 0) return "No active task plan.";

	const lines = [
		plan.summary ? `Summary: ${plan.summary}` : "Summary: n/a",
		...plan.items.map((item) => {
			const note = item.note ? ` - ${item.note}` : "";
			return `- [${item.status}] ${item.id}: ${item.title}${note}`;
		}),
	];

	if (plan.verification.length > 0) {
		lines.push("Verification:", ...plan.verification.map((entry) => `- ${entry}`));
	}

	if (plan.updatedAt) {
		lines.push(`Updated: ${plan.updatedAt}`);
	}

	return lines.join("\n");
}

function toModelMessages(messages: LLMMessage[]): ModelMessage[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
	}));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined;
}

function textDelta(part: AgentStreamPart): string {
	for (const key of ["text", "delta", "textDelta"] as const) {
		const value = part[key];
		if (typeof value === "string") return value;
	}
	return "";
}

function normalizeForPathCheck(path: string): string {
	const resolved = resolve(path);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function expandHomePath(path: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home || (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\"))) {
		return path;
	}
	return path === "~" ? home : `${home}${path.slice(1)}`;
}

function isInsideAllowedPath(filePath: string, allowedPaths: Set<string>): boolean {
	const target = normalizeForPathCheck(filePath);
	for (const allowedPath of allowedPaths) {
		const root = normalizeForPathCheck(allowedPath);
		if (target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)) {
			return true;
		}
	}
	return false;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
}

async function readTextFile(filePath: string): Promise<string> {
	const file = Bun.file(filePath);
	if (!(await file.exists())) {
		throw new Error(`File not found: ${filePath}`);
	}
	return await file.text();
}

function shellCommand(command: string): string[] {
	if (process.platform === "win32") {
		return ["powershell", "-NoLogo", "-NoProfile", "-Command", command];
	}
	return ["sh", "-lc", command];
}

function normalizeGlobPath(path: string): string {
	return path.replace(/\\/g, "/");
}

class NightcodeLLMService implements LLMService {
	#workspaceRoot = resolve(process.cwd());
	#projectConfig = loadProjectConfig(this.#workspaceRoot);
	#config = initialConfig(this.#projectConfig, this.#workspaceRoot);
	#allowedPaths = new Set<string>();
	#disabledTools = new Set<string>();
	#taskPlan: AgentTaskPlan = {
		summary: null,
		items: [],
		verification: [],
		updatedAt: null,
	};

	constructor() {
		this.#applyProjectPolicy();
	}

	get workspaceRoot(): string {
		return this.#workspaceRoot;
	}

	get config(): LLMConfig {
		return this.#config;
	}

	getTaskPlan(): AgentTaskPlan {
		return {
			summary: this.#taskPlan.summary,
			items: this.#taskPlan.items.map((item) => ({ ...item })),
			verification: [...this.#taskPlan.verification],
			updatedAt: this.#taskPlan.updatedAt,
		};
	}

	configure(config: Partial<LLMConfig>): void {
		this.#config = llmConfigSchema.parse({ ...this.#config, ...config });
	}

	setWorkspace(path: string): void {
		const root = resolve(expandHomePath(path));
		this.#workspaceRoot = root;
		this.#projectConfig = loadProjectConfig(root);
		this.#taskPlan = {
			summary: null,
			items: [],
			verification: [],
			updatedAt: null,
		};
		this.#applyProjectPolicy();
		this.configure({
			model: process.env.NIGHTCODE_MODEL ?? this.#projectConfig.config.model ?? this.#config.model,
			maxTokens: Number(
				process.env.NIGHTCODE_MAX_TOKENS ??
					this.#projectConfig.config.maxTokens ??
					this.#config.maxTokens,
			),
			temperature: Number(
				process.env.NIGHTCODE_TEMPERATURE ??
					this.#projectConfig.config.temperature ??
					this.#config.temperature,
			),
			systemPrompt: buildSystemPrompt(this.#projectConfig, root),
		});
	}

	addAllowedPath(path: string): void {
		this.#allowedPaths.add(resolveConfiguredPath(path, this.#workspaceRoot));
	}

	#applyProjectPolicy(): void {
		this.#allowedPaths = new Set([
			this.#workspaceRoot,
			...(this.#projectConfig.config.allowedPaths ?? []).map((path) =>
				resolveConfiguredPath(path, this.#workspaceRoot),
			),
		]);
		this.#disabledTools = new Set(this.#projectConfig.config.disabledTools ?? []);
	}

	getAvailableProviders(): Array<{
		provider: SupportedProvider;
		available: boolean;
		reason?: string;
	}> {
		return modelRouter.getAvailableProviders();
	}

	async *stream(
		messages: LLMMessage[],
		config?: Partial<LLMConfig>,
	): AsyncGenerator<LLMStreamChunk> {
		const effectiveConfig = config
			? llmConfigSchema.parse({ ...this.#config, ...config })
			: this.#config;
		const agent = this.#createAgent(effectiveConfig);
		const result = await agent.stream({
			messages: toModelMessages(messages),
			onStepFinish({ usage, performance, finishReason }) {
				if (process.env.NIGHTCODE_DEBUG_STREAM === "true") {
					logger.debug("agent step", {
						finishReason,
						inputTokens: usage.inputTokens,
						outputTokens: usage.outputTokens,
						timeToFirstOutputMs: performance.timeToFirstOutputMs,
						outputTokensPerSecond: performance.outputTokensPerSecond,
					});
				}
			},
		});

		for await (const part of result.stream) {
			const chunk = this.#toChunk(part);
			if (chunk) yield chunk;
		}
	}

	#getModel(config: LLMConfig) {
		return modelRouter.resolve(config);
	}

	#createAgent(config: LLMConfig) {
		return new ToolLoopAgent({
			id: "nightcode-coding-agent",
			model: this.#getModel(config),
			instructions: config.systemPrompt,
			allowSystemInMessages: true,
			maxOutputTokens: config.maxTokens,
			temperature: config.temperature,
			stopWhen: config.agentMode
				? stepCountIs(configuredMaxAgentSteps(this.#projectConfig))
				: stepCountIs(1),
			tools: config.agentMode ? this.#tools() : {},
			maxRetries: this.#projectConfig.config.maxRetries ?? 2,
			prepareStep: () => ({
				instructions: this.#instructionsWithCurrentPlan(config.systemPrompt),
			}),
			onToolExecutionStart({ toolCall }) {
				logger.debug("tool call start", { toolName: toolCall.toolName });
			},
			onToolExecutionEnd(event) {
				const failed = event.toolOutput.type === "tool-error";
				const context = {
					durationMs: event.toolExecutionMs,
					toolName: event.toolCall.toolName,
					...(failed && "error" in event.toolOutput
						? { error: errorMessage(event.toolOutput.error) }
						: {}),
				};
				if (failed) {
					logger.warn("tool call failed", context);
				} else {
					logger.debug("tool call finish", context);
				}
			},
		});
	}

	#instructionsWithCurrentPlan(baseInstructions: string | undefined): string | undefined {
		if (!baseInstructions || this.#taskPlan.items.length === 0) return baseInstructions;

		return `${baseInstructions}\n\nCurrent task plan:\n${formatTaskPlan(this.#taskPlan)}`;
	}

	#tools() {
		const ensureAllowed = (path: string) => {
			if (!isInsideAllowedPath(path, this.#allowedPaths)) {
				throw new Error(`Path is outside allowed roots: ${path}`);
			}
		};
		const ensurePlannedMutation = () => {
			if (!requirePlanForEdits(this.#projectConfig)) return;
			if (this.#taskPlan.items.length > 0) return;
			throw new Error(
				"File mutation blocked: call updateTaskPlan with a concrete plan before writing or editing files.",
			);
		};

		const tools = {
			updateTaskPlan: tool({
				description:
					"Create or update the current task plan. Use before non-trivial edits and keep exactly one active in_progress step.",
				inputSchema: z.object({
					summary: z.string().min(1).max(240).optional(),
					items: z.array(taskPlanItemSchema).min(1).max(12),
					verification: z.array(z.string().min(1).max(160)).max(8).default([]),
				}),
				execute: async ({ summary, items, verification }) => {
					const inProgress = items.filter((item) => item.status === "in_progress");
					if (inProgress.length > 1) {
						throw new Error("Task plan can have at most one in_progress step.");
					}

					this.#taskPlan = {
						summary: summary ?? this.#taskPlan.summary,
						items,
						verification,
						updatedAt: new Date().toISOString(),
					};
					return formatTaskPlan(this.#taskPlan);
				},
			}),
			getTaskPlan: tool({
				description: "Read the current task plan and verification checklist.",
				inputSchema: z.object({}),
				execute: async () => formatTaskPlan(this.#taskPlan),
			}),
			shell: tool({
				description:
					"Run a shell command in an allowed working directory. Use for project checks, builds, tests, and fast local inspection.",
				inputSchema: z.object({
					command: z.string().min(1),
					cwd: z.string().default("."),
					timeoutMs: z.number().int().positive().max(120_000).default(30_000),
				}),
				execute: async ({ command, cwd, timeoutMs }) => {
					const cwdPath = resolve(cwd);
					ensureAllowed(cwdPath);
					if (!allowDangerousShell(this.#projectConfig)) {
						const verdict = evaluateShellSafety(command);
						if (!verdict.allowed) {
							throw new Error(
								`Shell command blocked by guardrail (${verdict.reason}). Ask the user for an explicit manual action or set allowDangerousShell/NIGHTCODE_ALLOW_DANGEROUS_SHELL only if this is intentional.`,
							);
						}
					}
					const proc = Bun.spawn(shellCommand(command), {
						cwd: cwdPath,
						stdout: "pipe",
						stderr: "pipe",
						timeout: timeoutMs,
					});
					const [stdout, stderr, exitCode] = await Promise.all([
						proc.stdout.text(),
						proc.stderr.text(),
						proc.exited,
					]);
					return trimToolOutput(
						[
							`exitCode: ${exitCode}`,
							stdout ? `stdout:\n${stdout.trimEnd()}` : "",
							stderr ? `stderr:\n${stderr.trimEnd()}` : "",
						]
							.filter(Boolean)
							.join("\n\n"),
					);
				},
			}),
			readFile: tool({
				description: "Read a UTF-8 text file from an allowed path.",
				inputSchema: z.object({ path: z.string() }),
				execute: async ({ path }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					return trimToolOutput(await readTextFile(filePath));
				},
			}),
			readLines: tool({
				description: "Read a specific inclusive line range from a UTF-8 text file.",
				inputSchema: z.object({
					path: z.string(),
					startLine: z.number().int().positive(),
					endLine: z.number().int().positive(),
				}),
				execute: async ({ path, startLine, endLine }) => {
					if (endLine < startLine) {
						throw new Error("endLine must be greater than or equal to startLine");
					}
					const filePath = resolve(path);
					ensureAllowed(filePath);
					const lines = (await readTextFile(filePath)).split(/\r?\n/);
					return trimToolOutput(
						lines
							.slice(startLine - 1, endLine)
							.map((line, index) => `${startLine + index}: ${line}`)
							.join("\n"),
					);
				},
			}),
			writeFile: tool({
				description: "Write a UTF-8 text file under an allowed path.",
				inputSchema: z.object({ path: z.string(), content: z.string() }),
				execute: async ({ path, content }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					ensurePlannedMutation();
					await ensureParentDirectory(filePath);
					await Bun.write(filePath, content);
					return `wrote ${filePath}`;
				},
			}),
			editFile: tool({
				description:
					"Replace exactly one occurrence of text in a UTF-8 file. Fails if the old text is missing or ambiguous.",
				inputSchema: z.object({
					path: z.string(),
					oldText: z.string().min(1),
					newText: z.string(),
				}),
				execute: async ({ path, oldText, newText }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					ensurePlannedMutation();
					const content = await readTextFile(filePath);
					const occurrences = content.split(oldText).length - 1;
					if (occurrences === 0) {
						throw new Error(`oldText not found in ${filePath}`);
					}
					if (occurrences > 1) {
						throw new Error(`oldText matched ${occurrences} times in ${filePath}`);
					}
					await Bun.write(filePath, content.replace(oldText, newText));
					return `edited ${filePath}`;
				},
			}),
			multiEdit: tool({
				description: "Apply multiple exact text replacements to one UTF-8 file in order.",
				inputSchema: z.object({
					path: z.string(),
					edits: z
						.array(
							z.object({
								oldText: z.string().min(1),
								newText: z.string(),
							}),
						)
						.min(1),
				}),
				execute: async ({ path, edits }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					ensurePlannedMutation();
					let content = await readTextFile(filePath);
					for (const edit of edits) {
						const occurrences = content.split(edit.oldText).length - 1;
						if (occurrences === 0) {
							throw new Error(`oldText not found in ${filePath}`);
						}
						if (occurrences > 1) {
							throw new Error(`oldText matched ${occurrences} times in ${filePath}`);
						}
						content = content.replace(edit.oldText, edit.newText);
					}
					await Bun.write(filePath, content);
					return `applied ${edits.length} edits to ${filePath}`;
				},
			}),
			listFiles: tool({
				description: "List files and directories in an allowed directory.",
				inputSchema: z.object({ path: z.string().default(".") }),
				execute: async ({ path }) => {
					const dirPath = resolve(path);
					ensureAllowed(dirPath);
					const entries = await readdir(dirPath, { withFileTypes: true });
					const rows = await Promise.all(
						entries
							.sort((a, b) => a.name.localeCompare(b.name))
							.map(async (entry) => {
								const entryPath = resolve(dirPath, entry.name);
								const info = await stat(entryPath);
								const type = entry.isDirectory() ? "dir " : "file";
								return `${type} ${String(info.size).padStart(10)} ${entry.name}`;
							}),
					);
					return trimToolOutput(rows.join("\n"));
				},
			}),
			fileInfo: tool({
				description: "Get basic metadata for a file or directory.",
				inputSchema: z.object({ path: z.string() }),
				execute: async ({ path }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					const file = Bun.file(filePath);
					if (!(await file.exists())) {
						throw new Error(`Path not found: ${filePath}`);
					}
					return {
						path: filePath,
						size: file.size,
						type: file.type,
						modifiedAt: new Date(file.lastModified).toISOString(),
					};
				},
			}),
			listAgentProfiles: tool({
				description: "List available project and global custom agent profiles.",
				inputSchema: z.object({}),
				execute: async () => discoverAgentProfiles(this.#workspaceRoot),
			}),
			loadAgentProfile: tool({
				description:
					"Load a custom agent profile's full instructions. Use this before specialized work that matches a listed profile.",
				inputSchema: z.object({ profileId: z.string().min(1) }),
				execute: async ({ profileId }) =>
					trimToolOutput(loadAgentProfile(profileId, this.#workspaceRoot), 30_000),
			}),
			listSkills: tool({
				description: "List available project and global agent skills.",
				inputSchema: z.object({}),
				execute: async () => discoverSkills(this.#workspaceRoot),
			}),
			loadSkill: tool({
				description:
					"Load a skill's full SKILL.md instructions. Use this before specialized work that matches a listed skill.",
				inputSchema: z.object({ skillId: z.string().min(1) }),
				execute: async ({ skillId }) =>
					trimToolOutput(loadSkill(skillId, this.#workspaceRoot), 30_000),
			}),
			listLspServers: tool({
				description:
					"List configured Language Server Protocol servers discovered from project and user config.",
				inputSchema: z.object({}),
				execute: async () => discoverLspServers(this.#workspaceRoot),
			}),
			glob: tool({
				description: "Find files under an allowed directory with a Bun glob pattern.",
				inputSchema: z.object({
					pattern: z.string().min(1),
					cwd: z.string().default("."),
					limit: z.number().int().positive().max(1000).default(200),
				}),
				execute: async ({ pattern, cwd, limit }) => {
					const cwdPath = resolve(cwd);
					ensureAllowed(cwdPath);
					const glob = new Bun.Glob(pattern);
					const matches: string[] = [];
					for await (const match of glob.scan({
						cwd: cwdPath,
						onlyFiles: true,
						absolute: false,
					})) {
						matches.push(normalizeGlobPath(match));
						if (matches.length >= limit) break;
					}
					return matches.join("\n");
				},
			}),
			grep: tool({
				description:
					"Search UTF-8 files with a JavaScript regular expression. Returns path:line:content matches.",
				inputSchema: z.object({
					pattern: z.string().min(1),
					cwd: z.string().default("."),
					include: z.string().default("**/*.{ts,tsx,js,jsx,json,md,css,html}"),
					limit: z.number().int().positive().max(1000).default(200),
				}),
				execute: async ({ pattern, cwd, include, limit }) => {
					const cwdPath = resolve(cwd);
					ensureAllowed(cwdPath);
					const regex = new RegExp(pattern, "i");
					const glob = new Bun.Glob(include);
					const results: string[] = [];
					for await (const match of glob.scan({
						cwd: cwdPath,
						onlyFiles: true,
						absolute: false,
					})) {
						const filePath = resolve(cwdPath, match);
						ensureAllowed(filePath);
						const file = Bun.file(filePath);
						if (file.size > 1_000_000) continue;
						const lines = (await file.text()).split(/\r?\n/);
						for (let index = 0; index < lines.length; index++) {
							const line = lines[index] ?? "";
							if (regex.test(line)) {
								results.push(`${normalizeGlobPath(match)}:${index + 1}:${line}`);
								if (results.length >= limit) {
									return trimToolOutput(results.join("\n"));
								}
							}
						}
					}
					return trimToolOutput(results.join("\n"));
				},
			}),
		};

		if (this.#disabledTools.size === 0) return tools;

		return Object.fromEntries(
			Object.entries(tools).filter(([toolName]) => !this.#disabledTools.has(toolName)),
		);
	}

	#toChunk(part: AgentStreamPart): LLMStreamChunk | null {
		switch (part.type) {
			case "text-delta":
				return { type: "text", text: textDelta(part) };
			case "tool-call":
				return {
					type: "tool-call",
					toolCall: {
						name: typeof part.toolName === "string" ? part.toolName : "unknown",
						args: isRecord(part.input) ? part.input : {},
					},
				};
			case "tool-result":
				return {
					type: "tool-result",
					toolResult: {
						name: typeof part.toolName === "string" ? part.toolName : "unknown",
						result:
							typeof part.output === "string" ? part.output : JSON.stringify(part.output ?? null),
					},
				};
			case "finish":
				return {
					type: "done",
					usage: isRecord(part.totalUsage)
						? {
								inputTokens: optionalNumber(part.totalUsage.inputTokens),
								outputTokens: optionalNumber(part.totalUsage.outputTokens),
							}
						: undefined,
				};
			case "error":
				return { type: "error", error: errorMessage(part.error ?? part.errorText) };
			default:
				return null;
		}
	}
}

export const llm = new NightcodeLLMService();

export const modelCatalog = supportedChatModels;
