import { resolve } from "node:path";

export type ParsedSlashCommand = {
	name: string;
	arg: string;
	raw: string;
};

const QUOTE_PAIRS: Record<string, string> = {
	'"': '"',
	"'": "'",
};

export function parseSlashCommand(value: string): ParsedSlashCommand | null {
	const raw = value.trim();
	if (!raw.startsWith("/")) return null;

	const match = raw.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
	if (!match?.[1]) return null;

	return {
		name: match[1].toLowerCase(),
		arg: (match[2] ?? "").trim(),
		raw,
	};
}

export function stripEnclosingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) return trimmed;

	const first = trimmed[0];
	const last = trimmed[trimmed.length - 1];

	return first && last === QUOTE_PAIRS[first] ? trimmed.slice(1, -1) : trimmed;
}

export function expandHomePath(value: string): string {
	const normalized = stripEnclosingQuotes(value);
	const home = process.env.HOME ?? process.env.USERPROFILE;

	if (
		!home ||
		(normalized !== "~" && !normalized.startsWith("~/") && !normalized.startsWith("~\\"))
	) {
		return normalized;
	}

	return normalized === "~" ? home : `${home}${normalized.slice(1)}`;
}

export function resolveUserPath(value: string): string {
	return resolve(expandHomePath(value));
}
