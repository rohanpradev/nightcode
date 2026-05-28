import { Database } from "bun:sqlite";
import path from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

// Database Path Resolution
const DB_PATH = process.env.DATABASE_URL
	? process.env.DATABASE_URL.replace("file:", "")
	: path.join(import.meta.dirname, "..", "nightcode.db");

// Native SQLite Connection
const sqlite = new Database(DB_PATH, { create: true, strict: true });

// Performance PRAGMAS
// These are critical for performance - WAL mode alone gives 10x write throughput
sqlite.run("PRAGMA journal_mode = WAL"); // Write-Ahead Logging
sqlite.run("PRAGMA synchronous = NORMAL"); // Faster syncs (safe with WAL)
sqlite.run("PRAGMA cache_size = -64000"); // 64MB page cache
sqlite.run("PRAGMA foreign_keys = ON"); // Enforce FK constraints
sqlite.run("PRAGMA temp_store = MEMORY"); // Temp tables in memory
sqlite.run("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
sqlite.run("PRAGMA page_size = 4096"); // Optimal page size
sqlite.run("PRAGMA busy_timeout = 5000"); // 5s busy retry

// Drizzle Instance
export const db = drizzle({ client: sqlite, schema });

// Direct SQLite Access (for raw performance-critical queries)
export { sqlite };

// Schema Initialization
/**
 * Create all tables if they don't exist (idempotent)
 */
export function initializeDatabase(): void {
	sqlite.run(`
        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            userId TEXT NOT NULL DEFAULT 'local',
            title TEXT NOT NULL,
            createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            updatedAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            messages TEXT NOT NULL DEFAULT '[]'
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS sessions_userId_idx ON sessions(userId)");
	sqlite.run("CREATE INDEX IF NOT EXISTS sessions_createdAt_idx ON sessions(createdAt)");

	sqlite.run(`
        CREATE TABLE IF NOT EXISTS file_index (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            hash TEXT NOT NULL,
            language TEXT NOT NULL DEFAULT 'unknown',
            symbolCount INTEGER NOT NULL DEFAULT 0,
            lastIndexed INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS file_index_path_idx ON file_index(path)");
	sqlite.run("CREATE INDEX IF NOT EXISTS file_index_language_idx ON file_index(language)");

	sqlite.run(`
        CREATE TABLE IF NOT EXISTS code_symbols (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,
            file TEXT NOT NULL,
            startLine INTEGER NOT NULL,
            endLine INTEGER NOT NULL,
            parent TEXT,
            signature TEXT,
            fileIndexId TEXT REFERENCES file_index(id) ON DELETE CASCADE
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS code_symbols_name_idx ON code_symbols(name)");
	sqlite.run("CREATE INDEX IF NOT EXISTS code_symbols_kind_idx ON code_symbols(kind)");
	sqlite.run("CREATE INDEX IF NOT EXISTS code_symbols_file_idx ON code_symbols(file)");

	sqlite.run(`
        CREATE TABLE IF NOT EXISTS embeddings (
            id TEXT PRIMARY KEY,
            filePath TEXT NOT NULL,
            chunk TEXT NOT NULL,
            vector BLOB NOT NULL,
            startLine INTEGER NOT NULL,
            endLine INTEGER NOT NULL,
            model TEXT NOT NULL DEFAULT 'text-embedding-3-small'
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS embeddings_filePath_idx ON embeddings(filePath)");

	sqlite.run(`
        CREATE TABLE IF NOT EXISTS tool_cache (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL UNIQUE,
            toolName TEXT NOT NULL,
            result TEXT NOT NULL,
            createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
            expiresAt INTEGER NOT NULL
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS tool_cache_key_idx ON tool_cache(key)");
	sqlite.run("CREATE INDEX IF NOT EXISTS tool_cache_toolName_idx ON tool_cache(toolName)");
	sqlite.run("CREATE INDEX IF NOT EXISTS tool_cache_expiresAt_idx ON tool_cache(expiresAt)");

	sqlite.run(`
        CREATE TABLE IF NOT EXISTS git_commits (
            id TEXT PRIMARY KEY,
            hash TEXT NOT NULL,
            sessionId TEXT NOT NULL,
            message TEXT NOT NULL,
            files TEXT NOT NULL DEFAULT '[]',
            createdAt INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
    `);
	sqlite.run("CREATE INDEX IF NOT EXISTS git_commits_sessionId_idx ON git_commits(sessionId)");
	sqlite.run("CREATE INDEX IF NOT EXISTS git_commits_hash_idx ON git_commits(hash)");
}

// Auto-initialize on import
initializeDatabase();
