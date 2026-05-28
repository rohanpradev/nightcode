import { blob, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Sessions
export const sessions = sqliteTable(
	"sessions",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		userId: text().notNull().default("local"),
		createdAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		title: text().notNull(),
		updatedAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdateFn(() => new Date()),
		messages: text().notNull().default("[]"),
	},
	(table) => [
		index("sessions_userId_idx").on(table.userId),
		index("sessions_createdAt_idx").on(table.createdAt),
	],
);

// File Index
export const fileIndex = sqliteTable(
	"file_index",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		path: text().notNull().unique(),
		hash: text().notNull(),
		language: text().notNull().default("unknown"),
		symbolCount: integer().notNull().default(0),
		lastIndexed: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("file_index_path_idx").on(table.path),
		index("file_index_language_idx").on(table.language),
	],
);

// Code Symbols
export const codeSymbols = sqliteTable(
	"code_symbols",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		name: text().notNull(),
		kind: text().notNull(), // function, class, type, interface, variable, method
		file: text().notNull(),
		startLine: integer().notNull(),
		endLine: integer().notNull(),
		parent: text(),
		signature: text(),
		fileIndexId: text().references(() => fileIndex.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("code_symbols_name_idx").on(table.name),
		index("code_symbols_kind_idx").on(table.kind),
		index("code_symbols_file_idx").on(table.file),
	],
);

// Embeddings
export const embeddings = sqliteTable(
	"embeddings",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		filePath: text().notNull(),
		chunk: text().notNull(),
		vector: blob({ mode: "buffer" }).notNull(),
		startLine: integer().notNull(),
		endLine: integer().notNull(),
		model: text().notNull().default("text-embedding-3-small"),
	},
	(table) => [index("embeddings_filePath_idx").on(table.filePath)],
);

// Tool Cache
export const toolCacheTable = sqliteTable(
	"tool_cache",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		key: text().notNull().unique(),
		toolName: text().notNull(),
		result: text().notNull(),
		createdAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
	},
	(table) => [
		index("tool_cache_key_idx").on(table.key),
		index("tool_cache_toolName_idx").on(table.toolName),
		index("tool_cache_expiresAt_idx").on(table.expiresAt),
	],
);

// Git Commits
export const gitCommits = sqliteTable(
	"git_commits",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => generateId()),
		hash: text().notNull(),
		sessionId: text().notNull(),
		message: text().notNull(),
		files: text().notNull().default("[]"),
		createdAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		index("git_commits_sessionId_idx").on(table.sessionId),
		index("git_commits_hash_idx").on(table.hash),
	],
);

// ID Generation
/**
 * Fast CUID-like ID generation using Bun's native crypto.
 * Format: timestamp(8) + random(16) = 24 chars, k-sortable.
 */
function generateId(): string {
	const timestamp = Date.now().toString(36).padStart(8, "0");
	const random = crypto.getRandomValues(new Uint8Array(8));
	const randomStr = Array.from(random, (b) => b.toString(36).padStart(2, "0")).join("");
	return `${timestamp}${randomStr}`.slice(0, 24);
}

export { generateId };
