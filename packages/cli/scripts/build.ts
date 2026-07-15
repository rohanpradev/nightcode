import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const modes = ["bundle", "compile", "bytecode"] as const;
type BuildMode = (typeof modes)[number];

const requestedMode = Bun.argv[2] ?? "bundle";
if (!modes.includes(requestedMode as BuildMode)) {
	throw new Error(
		`Unknown build mode ${JSON.stringify(requestedMode)}. Expected: ${modes.join(", ")}`,
	);
}
const mode = requestedMode as BuildMode;

const packageRoot = resolve(import.meta.dir, "..");
const outputDirectory = join(packageRoot, "dist");
const nativeBackends = [
	"@opentui/core-darwin-x64",
	"@opentui/core-darwin-arm64",
	"@opentui/core-linux-x64",
	"@opentui/core-linux-arm64",
	"@opentui/core-linux-x64-musl",
	"@opentui/core-linux-arm64-musl",
	"@opentui/core-win32-x64",
	"@opentui/core-win32-arm64",
] as const;

function isMuslLinux(): boolean {
	if (process.platform !== "linux") return false;

	const result = Bun.spawnSync(["ldd", "--version"]);
	const output = `${result.stdout.toString()}\n${result.stderr.toString()}`.toLowerCase();
	return output.includes("musl");
}

function currentNativeBackend(): (typeof nativeBackends)[number] {
	if (process.arch !== "x64" && process.arch !== "arm64") {
		throw new Error(`OpenTUI builds do not support the ${process.arch} architecture`);
	}

	if (process.platform === "darwin") return `@opentui/core-darwin-${process.arch}`;
	if (process.platform === "win32") return `@opentui/core-win32-${process.arch}`;
	if (process.platform === "linux") {
		return `@opentui/core-linux-${process.arch}${isMuslLinux() ? "-musl" : ""}`;
	}

	throw new Error(`OpenTUI builds do not support the ${process.platform} platform`);
}

await rm(outputDirectory, { recursive: true, force: true });

const currentBackend = currentNativeBackend();
const commonOptions = {
	entrypoints: [join(packageRoot, "src/index.tsx")],
	target: "bun" as const,
	format: "esm" as const,
	external: nativeBackends.filter((backend) => backend !== currentBackend),
	minify: true,
};

if (mode === "bundle") {
	await Bun.build({
		...commonOptions,
		outdir: outputDirectory,
		sourcemap: "external",
	});
} else {
	const executableName = `nightcode${mode === "bytecode" ? "-bytecode" : ""}${
		process.platform === "win32" ? ".exe" : ""
	}`;
	await Bun.build({
		...commonOptions,
		bytecode: mode === "bytecode",
		compile: { outfile: join(outputDirectory, executableName) },
		sourcemap: "linked",
	});
}

console.log(`Built Night Code CLI (${mode}) for ${process.platform}-${process.arch}`);
