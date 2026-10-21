# Local database

Night Code uses Bun SQLite with Drizzle ORM and Kit pinned together at `1.0.0-rc.4`.
The repository uses the v1 relations API and v3 migration directories. Installing the npm
`latest` tags for these two packages currently selects older incompatible release lines;
see the [dependency review](dependency-review.md).

`createNightcodeDatabase` opens the explicit database path, enables WAL and foreign keys,
sets a five-second busy timeout, and initializes the local session schema in an immediate
transaction. Failed initialization closes the connection. Callers must close successful
connections after use.

CLI sessions are stored under `~/.nightcode/nightcode.db` (or the corresponding
`NIGHTCODE_HOME` location). The CLI supplies that path explicitly. Other callers of the factory
can select a path or use `DATABASE_URL`; the default without that variable is the user database.
The legacy `sessions.json` import preserves the source file and runs transactionally.

Repository migration commands are:

```powershell
bun run db:check
bun run db:generate
bun run db:migrate
```

`db:check` validates migration history without changing the schema. Generate migrations after
intentional schema edits, review the SQL, back up the target database, and run migration against
that target deliberately. The runtime initializer upgrades its local storage tables separately;
it does not replay every application migration on each connection.

The database tests cover fresh migrations, repeat execution, legacy journal upgrades, unique
indexes, transactional schema failures, and session persistence.
