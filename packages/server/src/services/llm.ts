import { type ModelMessage, stepCountIs, type TextStreamPart, ToolLoopAgent, tool } from "ai";
import { $ } from "bun";
import "../lib/env";
import { dirname, resolve } from "node:path";
import {
	type LLMConfig,
	type LLMMessage,
	type LLMStreamChunk,
	llmConfigSchema,
	type SupportedProvider,
	supportedChatModels,
} from "@nightcode/shared";
import { z } from "zod";
import { loadProjectConfig } from "../lib/config-loader";
import { logger } from "./logger";
import { modelRouter } from "./model-router";

export type { LLMConfig, LLMMessage, LLMStreamChunk, SupportedProvider as LLMProvider };

export interface LLMService {
	readonly config: LLMConfig;
	configure(config: Partial<LLMConfig>): void;
	stream(messages: LLMMessage[], config?: Partial<LLMConfig>): AsyncGenerator<LLMStreamChunk>;
	getAvailableProviders(): Array<{
		provider: SupportedProvider;
		available: boolean;
	}>;
	addAllowedPath(path: string): void;
}

const DEFAULT_SYSTEM_PROMPT = [
	"You are Night Code, a terminal-first coding agent.",
	"Operate like a senior pair-programmer inside the user's project.",
	"Start from exact local context: inspect files, search symbols, and read relevant code before changing behavior.",
	"For implementation work, keep edits scoped, preserve existing style, run the most relevant verification, and report what changed plus any remaining risk.",
	"For reviews, lead with concrete findings ordered by severity and include file/line references when possible.",
	"For planning, be brief and actionable; for execution, continue through implementation and verification unless the user asks you to stop.",
	"When tools are available, prefer fast local commands such as rg, targeted file reads, and project scripts over guesses.",
].join("\n");

const MAX_TOOL_OUTPUT_CHARS = 60_000;

function trimToolOutput(output: string, limit = MAX_TOOL_OUTPUT_CHARS): string {
	if (output.length <= limit) return output;
	return `${output.slice(0, limit)}\n\n[truncated ${output.length - limit} chars]`;
}

function initialConfig(): LLMConfig {
	const project = loadProjectConfig();
	return llmConfigSchema.parse({
		provider: process.env.NIGHTCODE_PROVIDER ?? "openai",
		model: process.env.NIGHTCODE_MODEL ?? project.config.model ?? "gpt-5.2",
		maxTokens: Number(process.env.NIGHTCODE_MAX_TOKENS ?? project.config.maxTokens ?? 8192),
		temperature: Number(process.env.NIGHTCODE_TEMPERATURE ?? project.config.temperature ?? 0.2),
		systemPrompt:
			process.env.NIGHTCODE_SYSTEM_PROMPT ?? project.instructions ?? DEFAULT_SYSTEM_PROMPT,
		agentMode: process.env.NIGHTCODE_AGENT_MODE
			? process.env.NIGHTCODE_AGENT_MODE !== "false"
			: true,
	});
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

function isInsideAllowedPath(filePath: string, allowedPaths: Set<string>): boolean {
	const target = resolve(filePath);
	for (const allowedPath of allowedPaths) {
		const root = resolve(allowedPath);
		if (target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)) {
			return true;
		}
	}
	return false;
}

async function ensureParentDirectory(filePath: string): Promise<void> {
	await $`mkdir -p ${dirname(filePath)}`.quiet();
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
	#config = initialConfig();
	#allowedPaths = new Set([process.cwd()]);

	get config(): LLMConfig {
		return this.#config;
	}

	configure(config: Partial<LLMConfig>): void {
		this.#config = llmConfigSchema.parse({ ...this.#config, ...config });
	}

	addAllowedPath(path: string): void {
		this.#allowedPaths.add(resolve(path));
	}

	getAvailableProviders(): Array<{
		provider: SupportedProvider;
		available: boolean;
	}> {
		return [
			{ provider: "openai", available: Boolean(process.env.OPENAI_API_KEY?.trim()) },
			{
				provider: "anthropic",
				available: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
			},
			{ provider: "azure", available: Boolean(process.env.AZURE_API_KEY?.trim()) },
		];
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
						timeToFirstOutputTokenMs: performance.timeToFirstOutputTokenMs,
						outputTokensPerSecond: performance.outputTokensPerSecond,
					});
				}
			},
		});

		for await (const part of result.fullStream) {
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
			stopWhen: config.agentMode ? stepCountIs(8) : stepCountIs(1),
			tools: config.agentMode ? this.#tools() : {},
		});
	}

	#tools() {
		const ensureAllowed = (path: string) => {
			if (!isInsideAllowedPath(path, this.#allowedPaths)) {
				throw new Error(`Path is outside allowed roots: ${path}`);
			}
		};

		return {
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
					await ensureParentDirectory(filePath);
					await Bun.write(filePath, content);
					return `wrote ${filePath}`;
				},
			}),
			editFile: tool({
				description:
					"Replace exactly one occurrence of text in a UTF-8 file. Fails if the old text is missing.",
				inputSchema: z.object({
					path: z.string(),
					oldText: z.string().min(1),
					newText: z.string(),
				}),
				execute: async ({ path, oldText, newText }) => {
					const filePath = resolve(path);
					ensureAllowed(filePath);
					const content = await readTextFile(filePath);
					if (!content.includes(oldText)) {
						throw new Error(`oldText not found in ${filePath}`);
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
					let content = await readTextFile(filePath);
					for (const edit of edits) {
						if (!content.includes(edit.oldText)) {
							throw new Error(`oldText not found in ${filePath}`);
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
					const output = await $`ls -la ${dirPath}`.text();
					return trimToolOutput(output);
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
	}

	#toChunk(part: TextStreamPart<Record<string, never>>): LLMStreamChunk | null {
		switch (part.type) {
			case "text-delta":
				return { type: "text", text: part.text };
			case "tool-call":
				return {
					type: "tool-call",
					toolCall: {
						name: part.toolName,
						args:
							"input" in part && part.input && typeof part.input === "object"
								? (part.input as Record<string, unknown>)
								: {},
					},
				};
			case "tool-result":
				return {
					type: "tool-result",
					toolResult: {
						name: part.toolName,
						result:
							"output" in part && typeof part.output === "string"
								? part.output
								: JSON.stringify("output" in part ? part.output : null),
					},
				};
			case "finish":
				return { type: "done", usage: part.totalUsage };
			case "error":
				throw new Error(errorMessage(part.error));
			default:
				return null;
		}
	}
}

export const llm = new NightcodeLLMService();

export const modelCatalog = supportedChatModels;
