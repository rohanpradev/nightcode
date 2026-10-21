import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	listStoredSessions,
	loadLatestStoredSession,
	loadStoredSession,
	type StoredSession,
	saveStoredSession,
} from "./sessions";

const originalNightcodeHome = process.env.NIGHTCODE_HOME;

function session(overrides: Partial<StoredSession>): StoredSession {
	const now = Date.now();
	return {
		id: "session-id",
		title: "Test session",
		cwd: process.cwd(),
		createdAt: now,
		updatedAt: now,
		messages: [{ role: "user", content: "hello" }],
		fileContext: [],
		...overrides,
	};
}

function nightcodeHome(): string {
	const home = process.env.NIGHTCODE_HOME;
	if (!home) throw new Error("NIGHTCODE_HOME is not set");
	return home;
}

function sessionStorePath(): string {
	return join(nightcodeHome(), ".nightcode", "sessions.json");
}

describe("stored sessions", () => {
	beforeEach(async () => {
		process.env.NIGHTCODE_HOME = await mkdtemp(join(tmpdir(), "nightcode-sessions-"));
	});

	afterEach(() => {
		if (originalNightcodeHome == null) {
			delete process.env.NIGHTCODE_HOME;
		} else {
			process.env.NIGHTCODE_HOME = originalNightcodeHome;
		}
	});

	it("filters sessions by cwd and resolves unique id prefixes", async () => {
		const first = session({
			id: "abc123-first",
			title: "First",
			cwd: "C:/projects/one",
			updatedAt: 1,
		});
		const second = session({
			id: "def456-second",
			title: "Second",
			cwd: "C:/projects/two",
			updatedAt: 2,
		});
		const third = session({
			id: "abc999-third",
			title: "Third",
			cwd: "C:/projects/one",
			updatedAt: 3,
		});

		await saveStoredSession(first);
		await saveStoredSession(second);
		await saveStoredSession(third);

		const projectOne = await listStoredSessions({ cwd: "C:/projects/one" });
		expect(projectOne.map((stored) => stored.id)).toEqual(["abc999-third", "abc123-first"]);

		await expect(loadStoredSession("def456")).resolves.toMatchObject({ id: "def456-second" });
		await expect(loadStoredSession("abc")).resolves.toBeNull();
		await expect(loadLatestStoredSession("C:/projects/one")).resolves.toMatchObject({
			id: "abc999-third",
		});
	});

	it("keeps valid sessions when stored records are malformed", async () => {
		const target = sessionStorePath();
		await mkdir(join(nightcodeHome(), ".nightcode"), { recursive: true });
		await writeFile(
			target,
			JSON.stringify([
				{ id: "", title: "bad" },
				session({ id: "valid-session", title: "Valid", updatedAt: 10 }),
			]),
		);

		await expect(listStoredSessions()).resolves.toMatchObject([{ id: "valid-session" }]);
	});

	it("persists sessions in SQLite without leaving temporary files behind", async () => {
		await saveStoredSession(session({ id: "persisted-session" }));

		const entries = await readdir(join(nightcodeHome(), ".nightcode"));
		expect(entries).toContain("nightcode.db");
		expect(entries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
		await expect(loadStoredSession("persisted-session")).resolves.toMatchObject({
			id: "persisted-session",
		});
	});

	it("retries a failed legacy import after the source is repaired", async () => {
		await mkdir(join(nightcodeHome(), ".nightcode"), { recursive: true });
		await writeFile(sessionStorePath(), "{broken");
		await expect(listStoredSessions()).rejects.toThrow("Could not import legacy sessions");
		await writeFile(sessionStorePath(), JSON.stringify([session({ id: "recovered" })]));
		await expect(loadStoredSession("recovered")).resolves.toMatchObject({ id: "recovered" });
	});

	it("does not overwrite newer history with a delayed stale save", async () => {
		await saveStoredSession(session({ id: "newer", updatedAt: 20, title: "Latest" }));
		await saveStoredSession(session({ id: "newer", updatedAt: 10, title: "Stale" }));
		await expect(loadStoredSession("newer")).resolves.toMatchObject({
			updatedAt: 20,
			title: "Latest",
		});
	});

	it("rolls back a save when retention fails", async () => {
		await saveStoredSession(session({ id: "existing", updatedAt: 1 }));
		const { Database } = await import("bun:sqlite");
		const sqlite = new Database(join(nightcodeHome(), ".nightcode", "nightcode.db"));
		try {
			// Inject a real SQLite failure after the upsert, inside retention.
			sqlite.run(
				"CREATE TRIGGER reject_retention BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'retention failed'); END",
			);
			const insert = sqlite.prepare(
				"INSERT INTO sessions (id, title, createdAt, updatedAt) VALUES (?, '', 0, 0)",
			);
			for (let i = 0; i < 99; i++) insert.run(`filler-${i}`);
			await expect(
				saveStoredSession(session({ id: "must-rollback", updatedAt: 100 })),
			).rejects.toThrow("retention failed");
			expect(sqlite.query("SELECT id FROM sessions WHERE id = 'must-rollback'").get()).toBeNull();
		} finally {
			sqlite.close();
		}
	});
});
