import { rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dir, "..");
const buildDirectories = [
	"packages/cli/dist",
	"packages/server/dist",
	"packages/database/dist",
	"packages/shared/dist",
] as const;

for (const directory of buildDirectories) {
	const absolutePath = resolve(workspaceRoot, directory);
	const workspaceRelativePath = relative(workspaceRoot, absolutePath);

	if (workspaceRelativePath.startsWith("..") || workspaceRelativePath === "") {
		throw new Error(`Refusing to remove a path outside the workspace: ${absolutePath}`);
	}

	await rm(absolutePath, { recursive: true, force: true });
	console.log(`Removed ${directory}`);
}
