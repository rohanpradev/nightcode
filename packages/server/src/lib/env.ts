import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "../../../..", ".env");
const cwdEnv = resolve(process.cwd(), ".env");

config({ path: repoRootEnv, quiet: true });
if (cwdEnv !== repoRootEnv) {
	config({ path: cwdEnv, override: true, quiet: true });
}

export function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}
