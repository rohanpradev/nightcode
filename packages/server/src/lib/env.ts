import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRootEnv = resolve(here, "../../../..", ".env");
const cwdEnv = resolve(process.cwd(), ".env");

config({ path: repoRootEnv });
if (cwdEnv !== repoRootEnv) {
	config({ path: cwdEnv, override: true });
}

export function optionalEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}
