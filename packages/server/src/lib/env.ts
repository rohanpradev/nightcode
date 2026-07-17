import { join, resolve } from "node:path";
import { config } from "dotenv";

export interface TrustedEnvPathOptions {
	home?: string;
	explicitPath?: string;
}

/**
 * Workspace .env files are deliberately excluded. Repository-controlled env
 * values must never be able to redirect provider traffic or weaken policy.
 */
export function trustedEnvPaths(options: TrustedEnvPathOptions = {}): string[] {
	const explicitPath = options.explicitPath ?? process.env.NIGHTCODE_ENV_FILE?.trim();
	if (explicitPath) return [resolve(explicitPath)];

	const home =
		options.home ??
		process.env.NIGHTCODE_HOME?.trim() ??
		process.env.HOME ??
		process.env.USERPROFILE;
	const paths = home ? [join(home, ".nightcode", ".env")] : [];
	return [...new Set(paths.map((path) => resolve(path)))];
}

for (const path of trustedEnvPaths()) {
	config({ path, quiet: true });
}

export function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}
