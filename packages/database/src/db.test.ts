import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createNightcodeDatabase, initializeDatabase } from "./db";
import { sessions } from "./schema";

const migrationsFolder = resolve(import.meta.dir, "../drizzle");

describe("Drizzle v1 database", () => {
	it("supports typed inserts and the v2 relational query API", () => {
		const database = createNightcodeDatabase(":memory:");
		try {
			const [inserted] = database.db
				.insert(sessions)
				.values({ title: "RC smoke test" })
				.returning()
				.all();
			expect(inserted?.id).toBeTruthy();
			expect(inserted?.createdAt).toBeInstanceOf(Date);
			const row = database.db.query.sessions.findFirst({ where: { id: inserted?.id } }).sync();
			expect(row?.title).toBe("RC smoke test");
			expect(row?.workspace).toBe("");
		} finally {
			database.close();
		}
	});

	it("applies the v3 migration chain on a fresh database and can rerun it", () => {
		const sqlite = new Database(":memory:");
		try {
			const db = drizzle({ client: sqlite });
			migrate(db, { migrationsFolder });
			migrate(db, { migrationsFolder });
			initializeDatabase(sqlite);
			expect(
				sqlite
					.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_events'")
					.get(),
			).toBeTruthy();
			// Column-level .unique() changed representation in v1. These existing
			// unique indexes must survive conversion rather than being dropped.
			const indexes = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'index'").all();
			expect(indexes).toContainEqual({ name: "file_index_path_unique" });
			expect(indexes).toContainEqual({ name: "tool_cache_key_unique" });
			sqlite.run(
				"INSERT INTO file_index (id, path, hash, lastIndexed) VALUES ('one', 'a.ts', 'a', 1)",
			);
			expect(() =>
				sqlite.run(
					"INSERT INTO file_index (id, path, hash, lastIndexed) VALUES ('two', 'a.ts', 'b', 2)",
				),
			).toThrow();
		} finally {
			sqlite.close();
		}
	});

	it("preserves existing data while upgrading a v0 migration journal", () => {
		const sqlite = new Database(":memory:");
		try {
			const initial = readMigrationFiles({ migrationsFolder })[0];
			if (!initial) throw new Error("Missing initial migration");
			for (const sql of initial.sql) sqlite.run(sql);
			sqlite.run(
				"INSERT INTO sessions (id, title, createdAt, updatedAt) VALUES ('saved', 'Keep me', 1, 2)",
			);
			sqlite.run(
				"CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)",
			);
			const originalSql = readFileSync(
				resolve(migrationsFolder, initial.name, "migration.sql"),
				"utf8",
			);
			const hash = new Bun.CryptoHasher("sha256").update(originalSql).digest("hex");
			sqlite.run("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", [
				hash,
				1779980062315,
			]);
			migrate(drizzle({ client: sqlite }), { migrationsFolder });
			expect(
				sqlite.query("SELECT id, title, workspace, fileContext, version FROM sessions").get(),
			).toEqual({
				id: "saved",
				title: "Keep me",
				workspace: "",
				fileContext: "[]",
				version: 1,
			});
		} finally {
			sqlite.close();
		}
	});

	it("rolls back a failed runtime schema upgrade", () => {
		const sqlite = new Database(":memory:");
		try {
			// An incompatible existing table makes index creation fail late in the upgrade.
			sqlite.run("CREATE TABLE run_events (id INTEGER PRIMARY KEY)");
			expect(() => initializeDatabase(sqlite)).toThrow();
			expect(
				sqlite.query("SELECT name FROM sqlite_master WHERE name = 'sessions'").get(),
			).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
