import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readContainedProjectFile } from "./project-files";

export interface LspServerConfig {
	id: string;
	scope: "project" | "global";
	source: string;
	command?: string;
	args?: string[];
	fileExtensions?: Record<string, string>;
}

const PROJECT_LSP_FILES = [".github/lsp.json", ".nightcode/lsp.json"];
const GLOBAL_LSP_FILES = [".copilot/lsp-config.json", ".nightcode/lsp.json"];
const MAX_LSP_CONFIG_BYTES = 256_000;

function homeDir(): string | null {
	return process.env.HOME ?? process.env.USERPROFILE ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
	if (!isRecord(value)) return undefined;
	const entries = Object.entries(value);
	if (!entries.every(([, entry]) => typeof entry === "string")) return undefined;
	return Object.fromEntries(entries) as Record<string, string>;
}

function readLspFile(
	source: string,
	scope: LspServerConfig["scope"],
	projectRoot?: string,
): LspServerConfig[] {
	if (!existsSync(source)) return [];

	try {
		const content = projectRoot
			? readContainedProjectFile(projectRoot, source, MAX_LSP_CONFIG_BYTES)
			: statSync(source).size <= MAX_LSP_CONFIG_BYTES
				? readFileSync(source, "utf8")
				: null;
		if (content === null) return [];
		const parsed = JSON.parse(content);
		const rawServers = isRecord(parsed) && isRecord(parsed.lspServers) ? parsed.lspServers : parsed;
		if (!isRecord(rawServers)) return [];

		return Object.entries(rawServers)
			.map(([id, config]) => {
				if (!isRecord(config)) {
					return { id, scope, source } satisfies LspServerConfig;
				}

				return {
					id,
					scope,
					source,
					command: typeof config.command === "string" ? config.command : undefined,
					args: stringArray(config.args),
					fileExtensions: stringRecord(config.fileExtensions),
				} satisfies LspServerConfig;
			})
			.sort((a, b) => a.id.localeCompare(b.id));
	} catch {
		return [];
	}
}

export function discoverLspServers(rootDir = process.cwd()): LspServerConfig[] {
	const servers = PROJECT_LSP_FILES.flatMap((file) =>
		readLspFile(join(rootDir, file), "project", rootDir),
	);
	const home = homeDir();
	if (home) {
		servers.push(...GLOBAL_LSP_FILES.flatMap((file) => readLspFile(join(home, file), "global")));
	}

	const seen = new Set<string>();
	return servers.filter((server) => {
		const key = `${server.scope}:${server.id}:${server.source}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function formatLspCatalog(servers = discoverLspServers()): string {
	if (servers.length === 0) return "";

	return [
		"Configured LSP servers:",
		...servers.map((server) => {
			const extensions = server.fileExtensions
				? ` [${Object.keys(server.fileExtensions).join(", ")}]`
				: "";
			const command = server.command ? ` -> ${server.command}` : "";
			return `- ${server.id} (${server.scope})${extensions}${command}`;
		}),
		"Use listLspServers to inspect code-intelligence integrations before language-aware work.",
	].join("\n");
}
