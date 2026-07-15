import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export function defaultDatabasePath(): string {
	if (process.env.DATABASE_URL) return resolve(process.env.DATABASE_URL.replace(/^file:/, ""));
	const home =
		process.env.NIGHTCODE_HOME ?? process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
	return join(home, ".nightcode", "nightcode.db");
}

export function createNightcodeDatabase(path = defaultDatabasePath()) {
	mkdirSync(dirname(path), { recursive: true });
	const sqlite = new Database(path, { create: true, strict: true });
	configureDatabase(sqlite);
	initializeDatabase(sqlite);
	return {
		path,
		sqlite,
		db: drizzle({ client: sqlite, schema }),
		close: () => sqlite.close(),
	};
}

function configureDatabase(sqlite: Database): void {
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA synchronous = NORMAL");
	sqlite.run("PRAGMA cache_size = -64000");
	sqlite.run("PRAGMA foreign_keys = ON");
	sqlite.run("PRAGMA temp_store = MEMORY");
	sqlite.run("PRAGMA mmap_size = 268435456");
	sqlite.run("PRAGMA busy_timeout = 5000");
}

/** Creates and forward-migrates the local runtime schema. */
export function initializeDatabase(sqlite: Database): void {
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS sessions (
			id TEXT PRIMARY KEY,
			userId TEXT NOT NULL DEFAULT 'local',
			workspace TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			updatedAt INTEGER NOT NULL,
			messages TEXT NOT NULL DEFAULT '[]',
			fileContext TEXT NOT NULL DEFAULT '[]',
			version INTEGER NOT NULL DEFAULT 1
		)
	`);
	ensureColumn(sqlite, "sessions", "workspace", "TEXT NOT NULL DEFAULT ''");
	ensureColumn(sqlite, "sessions", "fileContext", "TEXT NOT NULL DEFAULT '[]'");
	ensureColumn(sqlite, "sessions", "version", "INTEGER NOT NULL DEFAULT 1");
	sqlite.run("CREATE INDEX IF NOT EXISTS sessions_userId_idx ON sessions(userId)");
	sqlite.run("CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions(workspace)");
	sqlite.run("CREATE INDEX IF NOT EXISTS sessions_updatedAt_idx ON sessions(updatedAt)");

	sqlite.run(`
		CREATE TABLE IF NOT EXISTS run_events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			sessionId TEXT NOT NULL,
			runId TEXT,
			sequence INTEGER NOT NULL,
			type TEXT NOT NULL,
			payload TEXT NOT NULL,
			createdAt INTEGER NOT NULL,
			UNIQUE(runId, sequence)
		)
	`);
	sqlite.run(
		"CREATE INDEX IF NOT EXISTS run_events_session_idx ON run_events(sessionId, createdAt)",
	);
	sqlite.run(`
		CREATE TABLE IF NOT EXISTS metadata (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)
	`);
}

function ensureColumn(sqlite: Database, table: string, column: string, definition: string): void {
	const rows = sqlite.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	if (!rows.some((row) => row.name === column)) {
		sqlite.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
	}
}
