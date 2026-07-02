import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export interface NightcodeConfig {
	/** Default model to use */
	model?: string;

	/** Default mode (BUILD or PLAN) */
	mode?: "BUILD" | "PLAN";

	/** Max tokens for responses */
	maxTokens?: number;

	/** Temperature for LLM */
	temperature?: number;

	/** Auto-commit after successful changes */
	autoCommit?: boolean;

	/** Auto-run typecheck after edits */
	autoTypecheck?: boolean;

	/** Auto-run lint after edits */
	autoLint?: boolean;

	/** Max self-correction attempts */
	maxRetries?: number;

	/** Max agent loop steps before stopping */
	maxAgentSteps?: number;

	/** Custom allowed paths */
	allowedPaths?: string[];

	/** Disabled tools */
	disabledTools?: string[];

	/** Allow dangerous shell commands without guardrail blocking */
	allowDangerousShell?: boolean;

	/** Require the agent to create/update a task plan before writing files */
	requirePlanForEdits?: boolean;

	/** Context window token budget */
	contextBudget?: number;

	/** Provider preference order */
	providers?: string[];
}

export interface ProjectConfig {
	config: NightcodeConfig;
	instructions: string | null;
	mcpServers: Record<string, MCPServerConfig> | null;
}

interface MCPServerConfig {
	command?: string;
	args?: string[];
	transport: "stdio" | "http";
	url?: string;
	env?: Record<string, string>;
}

const CONFIG_DIR = ".nightcode";
const CONFIG_FILE = "config.yaml";
const INSTRUCTIONS_FILE = "instructions.md";
const MCP_FILE = "mcp.json";
const ROOT_INSTRUCTION_FILES = [
	"AGENTS.md",
	"CLAUDE.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
	".codex/instructions.md",
];

const nightcodeConfigSchema = z.object({
	model: z.string().min(1).optional(),
	mode: z.enum(["BUILD", "PLAN"]).optional(),
	maxTokens: z.number().int().positive().optional(),
	temperature: z.number().min(0).max(2).optional(),
	autoCommit: z.boolean().optional(),
	autoTypecheck: z.boolean().optional(),
	autoLint: z.boolean().optional(),
	maxRetries: z.number().int().nonnegative().optional(),
	maxAgentSteps: z.number().int().positive().optional(),
	allowedPaths: z.array(z.string().min(1)).optional(),
	disabledTools: z.array(z.string().min(1)).optional(),
	allowDangerousShell: z.boolean().optional(),
	requirePlanForEdits: z.boolean().optional(),
	contextBudget: z.number().int().positive().optional(),
	providers: z.array(z.string().min(1)).optional(),
});

const mcpServerConfigSchema = z.object({
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	transport: z.enum(["stdio", "http"]),
	url: z.string().optional(),
	env: z.record(z.string(), z.string()).optional(),
});

const mcpServersConfigSchema = z.record(z.string(), mcpServerConfigSchema);

/** Load project configuration from .nightcode/ directory */
export function loadProjectConfig(rootDir?: string): ProjectConfig {
	const root = rootDir ?? process.cwd();
	const configDir = join(root, CONFIG_DIR);

	return {
		config: loadConfig(configDir),
		instructions: loadInstructions(root, configDir),
		mcpServers: loadMcpConfig(configDir),
	};
}

function loadConfig(configDir: string): NightcodeConfig {
	const configPath = join(configDir, CONFIG_FILE);
	if (!existsSync(configPath)) return {};

	try {
		const content = readFileSync(configPath, "utf8");
		// Simple YAML parser for flat config (avoid heavy yaml dependency)
		const parsed = nightcodeConfigSchema.safeParse(parseSimpleYaml(content));
		return parsed.success ? parsed.data : {};
	} catch {
		return {};
	}
}

function loadInstructions(root: string, configDir: string): string | null {
	const instructionPaths = [
		join(configDir, INSTRUCTIONS_FILE),
		...ROOT_INSTRUCTION_FILES.map((file) => join(root, file)),
		...loadGitHubInstructionFiles(root),
		...loadCursorRuleFiles(root),
	];

	const sections: string[] = [];
	for (const instructionPath of instructionPaths) {
		if (!existsSync(instructionPath)) continue;

		try {
			const content = readFileSync(instructionPath, "utf8").trim();
			if (content) {
				sections.push(`# ${instructionPath}\n\n${content}`);
			}
		} catch {}
	}

	return sections.length > 0 ? sections.join("\n\n") : null;
}

function loadGitHubInstructionFiles(root: string): string[] {
	const instructionsDir = join(root, ".github", "instructions");
	if (!existsSync(instructionsDir)) return [];

	try {
		return readdirSync(instructionsDir)
			.filter((file) => file.endsWith(".instructions.md"))
			.sort()
			.map((file) => join(instructionsDir, file));
	} catch {
		return [];
	}
}

function loadCursorRuleFiles(root: string): string[] {
	const rulesDir = join(root, ".cursor", "rules");
	if (!existsSync(rulesDir)) return [];

	try {
		return readdirSync(rulesDir)
			.filter((file) => file.endsWith(".mdc") || file.endsWith(".md"))
			.sort()
			.map((file) => join(rulesDir, file));
	} catch {
		return [];
	}
}

function loadMcpConfig(configDir: string): Record<string, MCPServerConfig> | null {
	const mcpPath = join(configDir, MCP_FILE);
	if (!existsSync(mcpPath)) return null;

	try {
		const content = readFileSync(mcpPath, "utf8");
		const parsed = JSON.parse(content);
		const serverConfig =
			parsed && typeof parsed === "object" && "servers" in parsed
				? (parsed as { servers: unknown }).servers
				: parsed;
		const result = mcpServersConfigSchema.safeParse(serverConfig);
		return result.success ? result.data : null;
	} catch {
		return null;
	}
}

/** Parse simple flat YAML (key: value pairs, no nesting beyond arrays) */
function parseSimpleYaml(content: string): Record<string, unknown> {
	const config: Record<string, unknown> = {};
	const lines = content.split("\n");

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed || trimmed.startsWith("#")) continue;

		const colonIdx = trimmed.indexOf(":");

		if (colonIdx === -1) continue;

		const key = trimmed.slice(0, colonIdx).trim();
		const value = trimmed.slice(colonIdx + 1).trim();

		if (!value) continue;

		config[key] = parseSimpleYamlValue(value);
	}

	return config;
}

function parseSimpleYamlValue(value: string): unknown {
	if (value === "true") return true;
	if (value === "false") return false;
	if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
	if (/^\d+\.\d+$/.test(value)) return Number.parseFloat(value);

	if (value.startsWith("[") && value.endsWith("]")) {
		const inner = value.slice(1, -1).trim();
		if (!inner) return [];

		return inner.split(",").map((item) => stripYamlString(item.trim()));
	}

	return stripYamlString(value);
}

function stripYamlString(value: string): string {
	return value.replace(/^["']|["']$/g, "");
}
