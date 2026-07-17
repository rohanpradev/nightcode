import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { readContainedProjectFile, resolveContainedProjectDirectory } from "./project-files";

export interface AgentProfile {
	id: string;
	name: string;
	description: string;
	path: string;
	scope: "project" | "global";
}

const PROJECT_AGENT_DIRS = [".github/agents", ".nightcode/agents", ".agents"];
const GLOBAL_AGENT_DIRS = [".nightcode/agents", ".agents"];
const MAX_PROFILE_BYTES = 80_000;
const MAX_PROFILES_PER_DIRECTORY = 100;

function homeDir(): string | null {
	return process.env.HOME ?? process.env.USERPROFILE ?? null;
}

function normalizeId(value: string): string {
	return value
		.replace(/\.agent\.md$/i, "")
		.replace(/\.md$/i, "")
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function firstMeaningfulLine(content: string): string | null {
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "---") continue;
		if (trimmed.includes(":") && /^[a-zA-Z_-]+:/.test(trimmed)) continue;
		return trimmed.replace(/^#+\s*/, "");
	}
	return null;
}

function parseFrontmatter(content: string): Record<string, string> {
	if (!content.startsWith("---")) return {};
	const end = content.indexOf("\n---", 3);
	if (end === -1) return {};

	const frontmatter = content.slice(3, end).trim();
	const parsed: Record<string, string> = {};
	for (const line of frontmatter.split(/\r?\n/)) {
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line
			.slice(colon + 1)
			.trim()
			.replace(/^["']|["']$/g, "");
		if (key && value) parsed[key] = value;
	}
	return parsed;
}

function readProfile(
	path: string,
	scope: AgentProfile["scope"],
	projectRoot?: string,
): AgentProfile | null {
	try {
		const content = projectRoot
			? readContainedProjectFile(projectRoot, path, MAX_PROFILE_BYTES)
			: statSync(path).size <= MAX_PROFILE_BYTES
				? readFileSync(path, "utf8")
				: null;
		if (content === null) return null;
		const frontmatter = parseFrontmatter(content);
		const fallbackName = firstMeaningfulLine(content) ?? basename(path);
		const name = (frontmatter.name ?? fallbackName).slice(0, 160);
		const id = normalizeId(frontmatter.name ?? basename(path)).slice(0, 80);

		return {
			id,
			name,
			description: (
				frontmatter.description ??
				firstMeaningfulLine(content) ??
				"Custom agent profile"
			).slice(0, 400),
			path,
			scope,
		};
	} catch {
		return null;
	}
}

function discoverInDirectory(
	dir: string,
	scope: AgentProfile["scope"],
	projectRoot?: string,
): AgentProfile[] {
	if (!existsSync(dir)) return [];

	try {
		const directory = projectRoot ? resolveContainedProjectDirectory(projectRoot, dir) : dir;
		return readdirSync(directory)
			.filter((file) => file.endsWith(".md"))
			.sort()
			.slice(0, MAX_PROFILES_PER_DIRECTORY)
			.map((file) => readProfile(join(directory, file), scope, projectRoot))
			.filter((profile): profile is AgentProfile => profile !== null);
	} catch {
		return [];
	}
}

export function discoverAgentProfiles(rootDir = process.cwd()): AgentProfile[] {
	const profiles = PROJECT_AGENT_DIRS.flatMap((dir) =>
		discoverInDirectory(join(rootDir, dir), "project", rootDir),
	);
	const home = homeDir();
	if (home) {
		profiles.push(
			...GLOBAL_AGENT_DIRS.flatMap((dir) => discoverInDirectory(join(home, dir), "global")),
		);
	}

	const seen = new Set<string>();
	return profiles.filter((profile) => {
		const key = `${profile.scope}:${profile.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function formatAgentProfileCatalog(profiles = discoverAgentProfiles()): string {
	if (profiles.length === 0) return "";

	return [
		"Available custom agent profiles:",
		...profiles.map(
			(profile) => `- ${profile.id} (${profile.scope}): ${profile.name} - ${profile.description}`,
		),
		"Use loadAgentProfile before specialized work that matches one of these profiles.",
	].join("\n");
}

export function loadAgentProfile(profileId: string, rootDir = process.cwd()): string {
	const profile = discoverAgentProfiles(rootDir).find((candidate) => candidate.id === profileId);
	if (!profile) {
		throw new Error(`Agent profile not found: ${profileId}`);
	}

	const content =
		profile.scope === "project"
			? readContainedProjectFile(rootDir, profile.path, MAX_PROFILE_BYTES)
			: statSync(profile.path).size <= MAX_PROFILE_BYTES
				? readFileSync(profile.path, "utf8")
				: null;
	if (content === null) throw new Error(`Agent profile is too large: ${profileId}`);
	return content;
}
