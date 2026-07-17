import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { readContainedProjectFile, resolveContainedProjectDirectory } from "./project-files";

export interface AgentSkill {
	id: string;
	name: string;
	description: string;
	path: string;
	scope: "project" | "global";
}

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_BYTES = 80_000;
const MAX_SKILLS_PER_ROOT = 100;

function homeDir(): string | undefined {
	return process.env.HOME ?? process.env.USERPROFILE;
}

type SkillRoot = { path: string; scope: AgentSkill["scope"]; projectRoot?: string };

function skillRoots(rootDir = process.cwd()): SkillRoot[] {
	const home = homeDir();
	return [
		{ path: join(rootDir, ".nightcode", "skills"), scope: "project", projectRoot: rootDir },
		{ path: join(rootDir, ".agents", "skills"), scope: "project", projectRoot: rootDir },
		{ path: join(rootDir, ".github", "skills"), scope: "project", projectRoot: rootDir },
		...(home
			? [
					{ path: join(home, ".nightcode", "skills"), scope: "global" as const },
					{ path: join(home, ".agents", "skills"), scope: "global" as const },
				]
			: []),
	];
}

function safeRead(path: string, projectRoot?: string): string | null {
	try {
		if (projectRoot) return readContainedProjectFile(projectRoot, path, MAX_SKILL_BYTES);
		const file = Bun.file(path);
		if (file.size > MAX_SKILL_BYTES) {
			return readFileSync(path, "utf8").slice(0, MAX_SKILL_BYTES);
		}
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

function slug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function parseSkill(
	path: string,
	scope: AgentSkill["scope"],
	projectRoot?: string,
): AgentSkill | null {
	const content = safeRead(join(path, SKILL_FILE), projectRoot);
	if (!content) return null;

	const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
	const description =
		content.match(/^description:\s*(.+)$/im)?.[1]?.trim() ??
		content
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line && !line.startsWith("#") && !line.startsWith("---")) ??
		"Reusable agent skill";
	const name = heading ?? basename(path);

	return {
		id: slug(basename(path)) || slug(name),
		name,
		description: description.replace(/^["']|["']$/g, "").slice(0, 240),
		path: resolve(path),
		scope,
	};
}

export function discoverSkills(rootDir = process.cwd()): AgentSkill[] {
	const skills = new Map<string, AgentSkill>();

	for (const root of skillRoots(rootDir)) {
		if (!existsSync(root.path)) continue;

		let directory: string;
		try {
			directory = root.projectRoot
				? resolveContainedProjectDirectory(root.projectRoot, root.path)
				: root.path;
		} catch {
			continue;
		}

		for (const entry of readdirSync(directory).slice(0, MAX_SKILLS_PER_ROOT)) {
			let skillDir = join(directory, entry);
			try {
				if (!statSync(skillDir).isDirectory()) continue;
				if (root.projectRoot) {
					skillDir = resolveContainedProjectDirectory(root.projectRoot, skillDir);
				}
			} catch {
				continue;
			}

			if (!existsSync(join(skillDir, SKILL_FILE))) continue;

			const skill = parseSkill(skillDir, root.scope, root.projectRoot);
			if (!skill) continue;

			const key = skills.has(skill.id) ? `${skill.id}-${skill.scope}` : skill.id;
			skills.set(key, { ...skill, id: key });
		}
	}

	return [...skills.values()].sort((a, b) => {
		if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
		return a.id.localeCompare(b.id);
	});
}

export function formatSkillCatalog(skills = discoverSkills()): string {
	if (skills.length === 0) return "";

	const lines = [
		"Available agent skills are discoverable but not loaded by default.",
		"Use the loadSkill tool before specialized work that matches one of these skills:",
		...skills
			.slice(0, 30)
			.map((skill) => `- ${skill.id} (${skill.scope}): ${skill.name} - ${skill.description}`),
	];

	return lines.join("\n");
}

export function loadSkill(skillId: string, rootDir = process.cwd()): string {
	const skill = discoverSkills(rootDir).find((candidate) => candidate.id === skillId);
	if (!skill) {
		throw new Error(`Skill not found: ${skillId}`);
	}

	const content = safeRead(
		join(skill.path, SKILL_FILE),
		skill.scope === "project" ? rootDir : undefined,
	);
	if (!content) {
		throw new Error(`Unable to read skill: ${skillId}`);
	}

	return `# ${skill.name}\n\n${content}`;
}
