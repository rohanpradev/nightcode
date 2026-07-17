import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export class ProjectFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProjectFileError";
	}
}

function normalizeCase(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathWithin(root: string, candidate: string): boolean {
	const path = relative(normalizeCase(root), normalizeCase(candidate));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/** Resolve an existing project path and reject symlink/junction escapes. */
export function resolveContainedProjectPath(root: string, candidate: string): string {
	let canonicalRoot: string;
	let canonicalCandidate: string;
	try {
		canonicalRoot = realpathSync(resolve(root));
		canonicalCandidate = realpathSync(resolve(candidate));
	} catch (error) {
		throw new ProjectFileError(
			`Unable to resolve project path ${candidate}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (!isPathWithin(canonicalRoot, canonicalCandidate)) {
		throw new ProjectFileError(`Project path escapes the workspace through a link: ${candidate}`);
	}
	return canonicalCandidate;
}

export function readContainedProjectFile(
	root: string,
	candidate: string,
	maxBytes: number,
): string {
	const path = resolveContainedProjectPath(root, candidate);
	const info = statSync(path);
	if (!info.isFile()) throw new ProjectFileError(`Not a regular project file: ${candidate}`);
	if (info.size > maxBytes) {
		throw new ProjectFileError(
			`Project file is too large (${info.size.toLocaleString()} bytes; limit ${maxBytes.toLocaleString()}): ${candidate}`,
		);
	}
	return readFileSync(path, "utf8");
}

export function resolveContainedProjectDirectory(root: string, candidate: string): string {
	const path = resolveContainedProjectPath(root, candidate);
	if (!statSync(path).isDirectory()) {
		throw new ProjectFileError(`Not a project directory: ${candidate}`);
	}
	return path;
}
