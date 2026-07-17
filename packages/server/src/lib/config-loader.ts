import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { approvalModeSchema } from "@nightcode/shared";
import { z } from "zod";
import { readContainedProjectFile, resolveContainedProjectDirectory } from "./project-files";

export interface NightcodeConfig {
	model?: string;
	mode?: "BUILD" | "PLAN";
	maxTokens?: number;
	temperature?: number;
	maxRetries?: number;
	maxAgentSteps?: number;
	maxToolOutputChars?: number;
	maxToolTimeoutMs?: number;
	maxRunDurationMs?: number;
	allowedPaths?: string[];
	disabledTools?: string[];
	requirePlanForEdits?: boolean;
	contextBudget?: number;
	approvalMode?: "always" | "on-risk" | "never";
	/** @deprecated Prefer approvalMode. Kept as an explicit compatibility escape hatch. */
	allowDangerousShell?: boolean;
}

export interface MCPServerConfig {
	command?: string;
	args?: string[];
	transport: "stdio" | "http";
	url?: string;
	env?: Record<string, string>;
	headers?: Record<string, string>;
	allowedTools?: string[];
	requireApproval?: boolean;
}

export interface ConfigDiagnostic {
	file: string;
	message: string;
	severity: "error" | "warning";
}

export interface ProjectConfig {
	config: NightcodeConfig;
	instructions: string | null;
	mcpServers: Record<string, MCPServerConfig> | null;
	diagnostics: ConfigDiagnostic[];
}

const CONFIG_DIR = ".nightcode";
const CONFIG_FILE = "config.yaml";
const INSTRUCTIONS_FILE = "instructions.md";
const MCP_FILE = "mcp.json";
const MAX_CONFIG_BYTES = 256_000;
const MAX_INSTRUCTION_BYTES = 256_000;
const MAX_TOTAL_INSTRUCTION_BYTES = 1_000_000;
const ROOT_INSTRUCTION_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
	".codex/instructions.md",
];

const nightcodeConfigSchema = z
	.object({
		model: z.string().min(1).optional(),
		mode: z.enum(["BUILD", "PLAN"]).optional(),
		maxTokens: z.number().int().positive().max(128_000).optional(),
		temperature: z.number().min(0).max(2).optional(),
		maxRetries: z.number().int().nonnegative().max(10).optional(),
		maxAgentSteps: z.number().int().positive().max(200).optional(),
		maxToolOutputChars: z.number().int().min(1_000).max(1_000_000).optional(),
		maxToolTimeoutMs: z.number().int().min(1_000).max(600_000).optional(),
		maxRunDurationMs: z.number().int().min(10_000).max(3_600_000).optional(),
		allowedPaths: z.array(z.string().min(1)).max(100).optional(),
		disabledTools: z.array(z.string().min(1)).max(100).optional(),
		requirePlanForEdits: z.boolean().optional(),
		contextBudget: z.number().int().min(1_000).max(1_000_000).optional(),
		approvalMode: approvalModeSchema.optional(),
		allowDangerousShell: z.boolean().optional(),
	})
	.strict();

const mcpServerConfigSchema = z
	.object({
		command: z.string().min(1).max(2_000).optional(),
		args: z.array(z.string().max(10_000)).max(100).optional(),
		transport: z.enum(["stdio", "http"]),
		url: z.url().optional(),
		env: z.record(z.string().max(200), z.string().max(20_000)).optional(),
		headers: z.record(z.string().max(200), z.string().max(20_000)).optional(),
		allowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
		requireApproval: z.boolean().default(true),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.transport === "stdio" && !value.command) {
			ctx.addIssue({
				code: "custom",
				path: ["command"],
				message: "stdio transport requires command",
			});
		}
		if (value.transport === "http" && !value.url) {
			ctx.addIssue({ code: "custom", path: ["url"], message: "http transport requires url" });
		}
	});

const mcpServersConfigSchema = z
	.record(z.string().min(1).max(80), mcpServerConfigSchema)
	.superRefine((servers, ctx) => {
		if (Object.keys(servers).length > 20) {
			ctx.addIssue({ code: "custom", message: "at most 20 MCP servers may be configured" });
		}
	});

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "config"}: ${issue.message}`)
		.join("; ");
}

/** Load and validate all project configuration without silently discarding errors. */
export function loadProjectConfig(rootDir?: string): ProjectConfig {
	const root = rootDir ?? process.cwd();
	const configDir = join(root, CONFIG_DIR);
	const diagnostics: ConfigDiagnostic[] = [];

	return {
		config: loadConfig(root, configDir, diagnostics),
		instructions: loadInstructions(root, configDir, diagnostics),
		mcpServers: loadMcpConfig(root, configDir, diagnostics),
		diagnostics,
	};
}

function loadConfig(
	root: string,
	configDir: string,
	diagnostics: ConfigDiagnostic[],
): NightcodeConfig {
	const configPath = join(configDir, CONFIG_FILE);
	if (!existsSync(configPath)) return {};

	try {
		const value = Bun.YAML.parse(readContainedProjectFile(root, configPath, MAX_CONFIG_BYTES));
		const parsed = nightcodeConfigSchema.safeParse(value ?? {});
		if (parsed.success) return parsed.data;
		diagnostics.push({ file: configPath, severity: "error", message: formatIssues(parsed.error) });
	} catch (error) {
		diagnostics.push({
			file: configPath,
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	return {};
}

function loadInstructions(
	root: string,
	configDir: string,
	diagnostics: ConfigDiagnostic[],
): string | null {
	const instructionPaths = [
		join(configDir, INSTRUCTIONS_FILE),
		...ROOT_INSTRUCTION_FILES.map((file) => join(root, file)),
		...loadGitHubInstructionFiles(root, diagnostics),
		...loadCursorRuleFiles(root, diagnostics),
	];

	const sections: string[] = [];
	let totalBytes = 0;
	for (const instructionPath of instructionPaths) {
		if (!existsSync(instructionPath)) continue;
		try {
			const content = readContainedProjectFile(root, instructionPath, MAX_INSTRUCTION_BYTES).trim();
			if (!content) continue;
			const bytes = Buffer.byteLength(content);
			if (totalBytes + bytes > MAX_TOTAL_INSTRUCTION_BYTES) {
				diagnostics.push({
					file: instructionPath,
					severity: "warning",
					message: `instruction budget exceeded (${MAX_TOTAL_INSTRUCTION_BYTES.toLocaleString()} bytes total)`,
				});
				continue;
			}
			totalBytes += bytes;
			sections.push(`# ${instructionPath}\n\n${content}`);
		} catch (error) {
			diagnostics.push({
				file: instructionPath,
				severity: "warning",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return sections.length > 0 ? sections.join("\n\n") : null;
}

function loadGitHubInstructionFiles(root: string, diagnostics: ConfigDiagnostic[]): string[] {
	const instructionsDir = join(root, ".github", "instructions");
	if (!existsSync(instructionsDir)) return [];
	try {
		const directory = resolveContainedProjectDirectory(root, instructionsDir);
		return readdirSync(directory)
			.filter((file) => file.endsWith(".instructions.md"))
			.sort()
			.map((file) => join(directory, file));
	} catch (error) {
		diagnostics.push({
			file: instructionsDir,
			severity: "warning",
			message: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

function loadCursorRuleFiles(root: string, diagnostics: ConfigDiagnostic[]): string[] {
	const rulesDir = join(root, ".cursor", "rules");
	if (!existsSync(rulesDir)) return [];
	try {
		const directory = resolveContainedProjectDirectory(root, rulesDir);
		return readdirSync(directory)
			.filter((file) => file.endsWith(".mdc") || file.endsWith(".md"))
			.sort()
			.map((file) => join(directory, file));
	} catch (error) {
		diagnostics.push({
			file: rulesDir,
			severity: "warning",
			message: error instanceof Error ? error.message : String(error),
		});
		return [];
	}
}

function loadMcpConfig(
	root: string,
	configDir: string,
	diagnostics: ConfigDiagnostic[],
): Record<string, MCPServerConfig> | null {
	const mcpPath = join(configDir, MCP_FILE);
	if (!existsSync(mcpPath)) return null;

	try {
		const parsed = JSON.parse(readContainedProjectFile(root, mcpPath, MAX_CONFIG_BYTES));
		const serverConfig =
			parsed && typeof parsed === "object" && "servers" in parsed
				? (parsed as { servers: unknown }).servers
				: parsed;
		const result = mcpServersConfigSchema.safeParse(serverConfig);
		if (result.success) return result.data;
		diagnostics.push({ file: mcpPath, severity: "error", message: formatIssues(result.error) });
	} catch (error) {
		diagnostics.push({
			file: mcpPath,
			severity: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	return null;
}
