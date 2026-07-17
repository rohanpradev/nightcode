import { normalize } from "node:path";

const SAFE_ENV_EXAMPLES = /(?:^|\.)env\.(?:example|sample|template)$/i;
const SENSITIVE_FILE_NAMES = new Set([
	".env",
	".git-credentials",
	".netrc",
	".npmrc",
	".pypirc",
	"credentials",
	"credentials.json",
	"id_dsa",
	"id_ecdsa",
	"id_ed25519",
	"id_rsa",
	"known_hosts",
]);
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".aws", ".azure", ".kube"]);
const SENSITIVE_EXTENSIONS = new Set([".key", ".p12", ".pfx", ".pem"]);

/** Classify paths whose contents commonly contain credentials or private keys. */
export function isSensitivePath(path: string): boolean {
	const normalized = normalize(path);
	const segments = normalized.split(/[\\/]+/).filter(Boolean);
	const fileName = (segments.at(-1) ?? normalized).toLowerCase().replace(/:.+$/, "");
	if (SAFE_ENV_EXAMPLES.test(fileName)) return false;
	if (fileName === ".env" || fileName.startsWith(".env.")) return true;
	if (SENSITIVE_FILE_NAMES.has(fileName)) return true;
	if (segments.some((segment) => SENSITIVE_DIRECTORIES.has(segment.toLowerCase()))) return true;
	const extensionIndex = fileName.lastIndexOf(".");
	return extensionIndex >= 0 && SENSITIVE_EXTENSIONS.has(fileName.slice(extensionIndex));
}
