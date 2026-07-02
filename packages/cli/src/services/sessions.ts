import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type LLMMessage, llmMessageSchema } from "@nightcode/shared";
import { z } from "zod";

const sessionFileContextEntrySchema = z.object({
	path: z.string(),
	content: z.string(),
});

const storedSessionSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	cwd: z.string().min(1),
	createdAt: z.number().int().nonnegative(),
	updatedAt: z.number().int().nonnegative(),
	messages: z.array(llmMessageSchema),
	fileContext: z.array(sessionFileContextEntrySchema).default([]),
});

export type SessionFileContext = z.infer<typeof storedSessionSchema>["fileContext"];
export type StoredSession = z.infer<typeof storedSessionSchema>;

const SESSION_LIMIT = 100;

function homeDir(): string {
	if (process.env.NIGHTCODE_HOME?.trim()) return process.env.NIGHTCODE_HOME.trim();
	return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

function sessionFilePath(): string {
	return join(homeDir(), ".nightcode", "sessions.json");
}

function normalizePath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string): boolean {
	return normalizePath(left) === normalizePath(right);
}

function parseStoredSessions(value: unknown): StoredSession[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((entry) => {
		const result = storedSessionSchema.safeParse(entry);
		return result.success ? [result.data] : [];
	});
}

export function createSessionId(): string {
	const timestamp = Date.now().toString(36);
	const random = crypto.getRandomValues(new Uint8Array(6));
	const suffix = Array.from(random, (byte) => byte.toString(36).padStart(2, "0")).join("");
	return `${timestamp}-${suffix}`.slice(0, 24);
}

export function titleFromMessages(messages: LLMMessage[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user")?.content;
	if (!firstUserMessage) return "Untitled session";

	return firstUserMessage.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled session";
}

async function readSessions(): Promise<StoredSession[]> {
	try {
		const parsed = JSON.parse(await readFile(sessionFilePath(), "utf8"));
		return parseStoredSessions(parsed);
	} catch {
		return [];
	}
}

async function writeSessions(sessions: StoredSession[]): Promise<void> {
	const target = sessionFilePath();
	await mkdir(dirname(target), { recursive: true });
	const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temp, `${JSON.stringify(sessions, null, 2)}\n`);
	await rename(temp, target);
}

export type ListStoredSessionsOptions = {
	limit?: number;
	cwd?: string;
};

export async function listStoredSessions(
	options: number | ListStoredSessionsOptions = {},
): Promise<StoredSession[]> {
	const limit = typeof options === "number" ? options : (options.limit ?? 20);
	const cwd = typeof options === "number" ? undefined : options.cwd;
	const sessions = await readSessions();
	const filtered = cwd ? sessions.filter((session) => samePath(session.cwd, cwd)) : sessions;
	return filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

export async function loadStoredSession(id: string): Promise<StoredSession | null> {
	const normalizedId = id.trim();
	if (!normalizedId) return null;

	const sessions = await readSessions();
	const exact = sessions.find((session) => session.id === normalizedId);
	if (exact) return exact;

	const prefixMatches = sessions.filter((session) => session.id.startsWith(normalizedId));
	return prefixMatches.length === 1 ? (prefixMatches[0] ?? null) : null;
}

export async function loadLatestStoredSession(cwd?: string): Promise<StoredSession | null> {
	const [session] = await listStoredSessions({ cwd, limit: 1 });
	return session ?? null;
}

export async function saveStoredSession(session: StoredSession): Promise<void> {
	const sessions = await readSessions();
	const normalizedSession = storedSessionSchema.parse({ ...session, cwd: resolve(session.cwd) });
	const filtered = sessions.filter((candidate) => candidate.id !== normalizedSession.id);
	const next = [normalizedSession, ...filtered]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, SESSION_LIMIT);
	await writeSessions(next);
}
