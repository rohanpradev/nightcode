import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createNightcodeDatabase } from "@nightcode/database";
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

const sessionRowSchema = z.object({
	id: z.string(),
	title: z.string(),
	workspace: z.string(),
	createdAt: z.number(),
	updatedAt: z.number(),
	messages: z.string(),
	fileContext: z.string(),
});

export type SessionFileContext = z.infer<typeof storedSessionSchema>["fileContext"];
export type StoredSession = z.infer<typeof storedSessionSchema>;

const SESSION_LIMIT = 100;

function homeDir(): string {
	if (process.env.NIGHTCODE_HOME?.trim()) return process.env.NIGHTCODE_HOME.trim();
	return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
}

function legacySessionFilePath(): string {
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

function parseSessionRow(value: unknown): StoredSession | null {
	const row = sessionRowSchema.safeParse(value);
	if (!row.success) return null;
	try {
		return storedSessionSchema.parse({
			id: row.data.id,
			title: row.data.title,
			cwd: row.data.workspace,
			createdAt: row.data.createdAt,
			updatedAt: row.data.updatedAt,
			messages: JSON.parse(row.data.messages),
			fileContext: JSON.parse(row.data.fileContext),
		});
	} catch {
		return null;
	}
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

async function withSessionDatabase<T>(
	operation: (sqlite: ReturnType<typeof createNightcodeDatabase>["sqlite"]) => T,
): Promise<T> {
	const database = createNightcodeDatabase(join(homeDir(), ".nightcode", "nightcode.db"));
	try {
		await importLegacySessions(database.sqlite);
		return operation(database.sqlite);
	} finally {
		database.close();
	}
}

async function importLegacySessions(
	sqlite: ReturnType<typeof createNightcodeDatabase>["sqlite"],
): Promise<void> {
	const marker = sqlite
		.query("SELECT value FROM metadata WHERE key = 'legacy_sessions_imported'")
		.get() as { value: string } | null;
	if (marker) return;

	let sessions: StoredSession[] = [];
	try {
		sessions = parseStoredSessions(JSON.parse(await readFile(legacySessionFilePath(), "utf8")));
	} catch {}

	const insert = sqlite.prepare(`
		INSERT INTO sessions (id, workspace, title, createdAt, updatedAt, messages, fileContext, version)
		VALUES (?, ?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT(id) DO NOTHING
	`);
	const migrate = sqlite.transaction(() => {
		for (const session of sessions) {
			insert.run(
				session.id,
				resolve(session.cwd),
				session.title,
				session.createdAt,
				session.updatedAt,
				JSON.stringify(session.messages),
				JSON.stringify(session.fileContext),
			);
		}
		sqlite.run(
			"INSERT OR REPLACE INTO metadata (key, value) VALUES ('legacy_sessions_imported', ?)",
			[String(Date.now())],
		);
	});
	migrate();
}

function readAllSessions(
	sqlite: ReturnType<typeof createNightcodeDatabase>["sqlite"],
): StoredSession[] {
	const rows = sqlite
		.query("SELECT id, title, workspace, createdAt, updatedAt, messages, fileContext FROM sessions")
		.all();
	return rows.flatMap((row) => {
		const parsed = parseSessionRow(row);
		return parsed ? [parsed] : [];
	});
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
	return withSessionDatabase((sqlite) => {
		const sessions = readAllSessions(sqlite);
		const filtered = cwd ? sessions.filter((session) => samePath(session.cwd, cwd)) : sessions;
		return filtered.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
	});
}

export async function loadStoredSession(id: string): Promise<StoredSession | null> {
	const normalizedId = id.trim();
	if (!normalizedId) return null;
	return withSessionDatabase((sqlite) => {
		const sessions = readAllSessions(sqlite);
		const exact = sessions.find((session) => session.id === normalizedId);
		if (exact) return exact;
		const prefixMatches = sessions.filter((session) => session.id.startsWith(normalizedId));
		return prefixMatches.length === 1 ? (prefixMatches[0] ?? null) : null;
	});
}

export async function loadLatestStoredSession(cwd?: string): Promise<StoredSession | null> {
	const [session] = await listStoredSessions({ cwd, limit: 1 });
	return session ?? null;
}

export async function saveStoredSession(session: StoredSession): Promise<void> {
	const normalized = storedSessionSchema.parse({ ...session, cwd: resolve(session.cwd) });
	await withSessionDatabase((sqlite) => {
		sqlite.run(
			`INSERT INTO sessions (id, workspace, title, createdAt, updatedAt, messages, fileContext, version)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
			 ON CONFLICT(id) DO UPDATE SET
				workspace = excluded.workspace,
				title = excluded.title,
				updatedAt = excluded.updatedAt,
				messages = excluded.messages,
				fileContext = excluded.fileContext,
				version = excluded.version`,
			[
				normalized.id,
				normalized.cwd,
				normalized.title,
				normalized.createdAt,
				normalized.updatedAt,
				JSON.stringify(normalized.messages),
				JSON.stringify(normalized.fileContext),
			],
		);
		sqlite.run(
			"DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY updatedAt DESC LIMIT ?)",
			[SESSION_LIMIT],
		);
	});
}
