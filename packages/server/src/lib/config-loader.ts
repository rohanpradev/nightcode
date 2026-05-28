import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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

	/** Custom allowed paths */
	allowedPaths?: string[];

	/** Disabled tools */
	disabledTools?: string[];

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

/** Load project configuration from .nightcode/ directory */
export function loadProjectConfig(rootDir?: string): ProjectConfig {
	const root = rootDir ?? process.cwd();
	const configDir = join(root, CONFIG_DIR);

	return {
		config: loadConfig(configDir),
		instructions: loadInstructions(configDir),
		mcpServers: loadMcpConfig(configDir),
	};
}

function loadConfig(configDir: string): NightcodeConfig {
	const configPath = join(configDir, CONFIG_FILE);
	if (!existsSync(configPath)) return {};

	try {
		const content = readFileSync(configPath, "utf8");
		// Simple YAML parser for flat config (avoid heavy yaml dependency)
		return parseSimpleYaml(content);
	} catch {
		return {};
	}
}

function loadInstructions(configDir: string): string | null {
	const instructionsPath = join(configDir, INSTRUCTIONS_FILE);
	if (!existsSync(instructionsPath)) return null;

	try {
		return readFileSync(instructionsPath, "utf8");
	} catch {
		return null;
	}
}

function loadMcpConfig(configDir: string): Record<string, MCPServerConfig> | null {
	const mcpPath = join(configDir, MCP_FILE);
	if (!existsSync(mcpPath)) return null;

	try {
		const content = readFileSync(mcpPath, "utf8");
		const parsed = JSON.parse(content);

		if (parsed && typeof parsed === "object" && "servers" in parsed) {
			return parsed.servers as Record<string, MCPServerConfig>;
		}

		return parsed as Record<string, MCPServerConfig>;
	} catch {
		return null;
	}
}

/** Parse simple flat YAML (key: value pairs, no nesting beyond arrays) */
function parseSimpleYaml(content: string): NightcodeConfig {
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

		// Parse value types
		if (value === "true") {
			config[key] = true;
		} else if (value === "false") {
			config[key] = false;
		} else if (/^\d+$/.test(value)) {
			config[key] = Number.parseInt(value, 10);
		} else if (/^\d+\.\d+$/.test(value)) {
			config[key] = Number.parseFloat(value);
		} else if (value.startsWith("[") && value.endsWith("]")) {
			// Simple array: [item1, item2]
			config[key] = value
				.slice(1, -1)
				.split(",")
				.map((s) => s.trim().replace(/^["']|["']$/g, ""));
		} else {
			// String value
			config[key] = value.replace(/^["']|["']$/g, "");
		}
	}

	return config as NightcodeConfig;
}
