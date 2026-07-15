import { lstat, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type WorkspaceAccess = "read" | "write" | "delete" | "directory";

export interface AuthorizedPath {
	requestedPath: string;
	resolvedPath: string;
	canonicalPath: string;
	root: string;
	external: boolean;
	exists: boolean;
}

export class WorkspaceBoundaryError extends Error {
	readonly code = "WORKSPACE_BOUNDARY";

	constructor(message: string) {
		super(message);
		this.name = "WorkspaceBoundaryError";
	}
}

function normalizeCase(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isWithin(root: string, target: string): boolean {
	const rel = relative(normalizeCase(root), normalizeCase(target));
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function expandHome(path: string): string {
	const home = process.env.HOME ?? process.env.USERPROFILE;
	if (!home || (path !== "~" && !path.startsWith("~/") && !path.startsWith("~\\"))) {
		return path;
	}
	return path === "~" ? home : `${home}${path.slice(1)}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}

/** Resolve a missing target through its nearest existing ancestor. */
async function canonicalize(path: string): Promise<{ path: string; exists: boolean }> {
	if (await exists(path)) return { path: await realpath(path), exists: true };

	const suffix: string[] = [];
	let cursor = path;
	while (!(await exists(cursor))) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new WorkspaceBoundaryError(`No existing ancestor for ${path}`);
		suffix.unshift(relative(parent, cursor));
		cursor = parent;
	}

	return { path: resolve(await realpath(cursor), ...suffix), exists: false };
}

/**
 * Canonical authorization boundary for every filesystem-facing tool.
 * Existing symlinks/junctions are resolved before the containment check; new
 * paths are resolved through their nearest existing ancestor.
 */
export class WorkspaceBoundary {
	readonly workspaceRoot: string;
	#configuredRoots: string[];

	constructor(workspaceRoot: string, additionalRoots: string[] = []) {
		this.workspaceRoot = resolve(expandHome(workspaceRoot));
		this.#configuredRoots = [
			this.workspaceRoot,
			...additionalRoots.map((path) =>
				isAbsolute(expandHome(path))
					? resolve(expandHome(path))
					: resolve(this.workspaceRoot, expandHome(path)),
			),
		];
	}

	addRoot(path: string): void {
		const expanded = expandHome(path);
		this.#configuredRoots.push(
			isAbsolute(expanded) ? resolve(expanded) : resolve(this.workspaceRoot, expanded),
		);
	}

	resolve(path: string): string {
		const expanded = expandHome(path);
		return isAbsolute(expanded) ? resolve(expanded) : resolve(this.workspaceRoot, expanded);
	}

	async authorize(path: string, access: WorkspaceAccess = "read"): Promise<AuthorizedPath> {
		const resolvedPath = this.resolve(path);
		const target = await canonicalize(resolvedPath);
		const roots = await Promise.all(this.#configuredRoots.map((root) => canonicalize(root)));
		const rootIndex = roots.findIndex((root) => isWithin(root.path, target.path));

		if (rootIndex < 0) {
			throw new WorkspaceBoundaryError(`Path is outside allowed roots: ${resolvedPath}`);
		}

		if (access === "read" && !target.exists) {
			throw new WorkspaceBoundaryError(`Path does not exist: ${resolvedPath}`);
		}

		if (access === "directory") {
			if (!target.exists || !(await stat(target.path)).isDirectory()) {
				throw new WorkspaceBoundaryError(`Not a directory: ${resolvedPath}`);
			}
		}

		return {
			requestedPath: path,
			resolvedPath,
			canonicalPath: target.path,
			root: roots[rootIndex]?.path ?? this.workspaceRoot,
			external: rootIndex > 0,
			exists: target.exists,
		};
	}
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const suffix = `${process.pid}.${Date.now()}.${crypto.randomUUID()}`;
	const temp = `${path}.${suffix}.tmp`;
	const backup = `${path}.${suffix}.bak`;
	const hadTarget = await exists(path);

	await writeFile(temp, content, { encoding: "utf8", flag: "wx" });
	try {
		if (hadTarget) await rename(path, backup);
		await rename(temp, path);
		if (hadTarget) await rm(backup, { force: true });
	} catch (error) {
		await rm(temp, { force: true }).catch(() => undefined);
		if (hadTarget && (await exists(backup)) && !(await exists(path))) {
			await rename(backup, path).catch(() => undefined);
		}
		throw error;
	}
}

export function sha256(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
