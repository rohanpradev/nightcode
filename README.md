# Night Code

Terminal-first AI coding agent built with Bun workspaces, Hono, and Vercel AI SDK v7.

## Setup

Create a `.env` file in the workspace root:

```bash
OPENAI_API_KEY=sk-...
NIGHTCODE_PROVIDER=openai
NIGHTCODE_MODEL=gpt-5.2
NIGHTCODE_PORT=3000
```

Optional:

```bash
OPENAI_BASE_URL=
OPENAI_ORG_ID=
OPENAI_PROJECT_ID=
NIGHTCODE_MAX_TOKENS=8192
NIGHTCODE_TEMPERATURE=0.2
NIGHTCODE_LOG_LEVEL=info
```

## Commands

```bash
bun install
bun run dev:server
bun run dev:cli
```

Useful checks:

```bash
bun run check
bun run typecheck
bun run build
```

Code quality:

```bash
bun run format:check
bun run lint
bun run check:fix
```

This project uses Bun workspaces, Biome for formatting/linting, and the TypeScript 7 native preview compiler via `@typescript/native-preview`/`tsgo`.

## Backend

The server exports a fully typed Hono `AppType` from `@nightcode/server`, so the CLI can use `hc<AppType>()` for end-to-end route inference.

Routes:

- `GET /health`
- `GET /providers`
- `GET /models?provider=openai`
- `POST /chat` streams newline-delimited `LLMStreamChunk` JSON
- `POST /agents/coding/run`

## CLI workflow

Night Code includes slash commands for fast project work:

- `/plan`, `/fix`, `/review`, `/explain`, `/test` for agent workflow presets
- `/add <file>`, `/context`, `/clear-context` for pinned file context
- `/index`, `/map` for a compact repository symbol map
- `/model <id>`, `/provider <name>`, `/agent`, `/compact` for runtime control
- `/status`, `/stats`, `/cost`, `/doctor` for telemetry and health checks

Shared request and response schemas live in `@nightcode/shared`.

## Packages

- `packages/cli`: OpenTUI terminal interface.
- `packages/server`: Hono backend, LLM service, model router, agent service, logger, file watcher.
- `packages/shared`: Zod schemas, model catalog, shared types.
- `packages/database`: Drizzle/Bun SQLite schema and client.
