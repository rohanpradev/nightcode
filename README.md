# Night Code

Night Code is a terminal-first coding-agent harness for Bun and TypeScript. It combines a scoped agent runtime, canonical workspace boundaries, approval-gated tools, transactional patches, durable local sessions, MCP tools, repository context, and a typed streaming API.

The default OpenAI model is `gpt-5.6`. Anthropic and Azure OpenAI are also supported.

## Quick start

```powershell
bun install
New-Item -ItemType Directory -Force "$HOME\.nightcode"
Copy-Item .env.example "$HOME\.nightcode\.env"
bun run dev:cli -- --workspace C:\path\to\project
```

Night Code deliberately does not load `.env` from the selected workspace. Set at least one
provider credential in `~/.nightcode/.env`, in the parent process, or in an explicit file selected
by the parent-process `NIGHTCODE_ENV_FILE` variable:

```dotenv
OPENAI_API_KEY=sk-...
NIGHTCODE_PROVIDER=openai
NIGHTCODE_MODEL=gpt-5.6
```

To run the HTTP service separately:

```powershell
bun run dev:server
```

## What is implemented

- One stateful runtime per session and workspace; concurrent runs in one session are rejected.
- Filesystem mutations from different sessions sharing one workspace are serialized through an
  abort-aware FIFO coordinator.
- Versioned NDJSON events with run, sequence, step, tool-call, approval, usage, abort, error, and completion metadata.
- Presentation-only `notice` messages that are persisted by the CLI but never sent to a model.
- Canonical path authorization that resolves symlinks and junctions before containment checks.
- Structured, multi-file patching with preflight validation, atomic writes, rollback, SHA-256 preconditions, checkpoints, and conflict-safe undo.
- A trusted runtime-policy envelope for approval, BUILD/PLAN mode, model output, retry/step,
  tool output/timeout, run-duration, context, and filesystem-root budgets. Repository policy may
  narrow this envelope but cannot weaken it.
- PLAN mode exposes inspection tools only, does not connect project MCP servers, and permits only
  the narrow low-risk shell inspection allowlist.
- Risk-classified shell execution with approval modes, time/output bounds, cancellation, a minimal child environment, and provider-secret stripping.
- Sensitive-file reads require approval (or are denied by non-interactive policy); repository maps
  and literal search skip conventional credential and private-key paths.
- Session/workspace-pinned HTTP routes, loopback-only default binding, optional bearer
  authentication on every route, bounded request/runtime retention, cancellation propagation, and
  structured stream errors.
- SQLite session storage with WAL, legacy `sessions.json` import, atomic upserts, and a 100-session retention limit.
- Workspace-isolated repository maps that refresh before runs, remove stale entries, rank against
  the latest user query, use relative normalized paths, and enforce file/count/token bounds.
- Canonically contained and size-bounded `.nightcode` configuration with surfaced diagnostics instead of silent fallback.
- MCP over HTTPS or local stdio, explicit workspace trust, namespaced tools, allowlists, redacted
  inherited environments, connection/discovery timeouts, URL checks, and approval by default.
- Atomic, idempotent approval resolution so a repeated response cannot execute a tool twice.
- CLI startup validation, truthful pending/succeeded/failed tool traces, detailed approval cards,
  and a save-before-exit lifecycle.
- TypeScript 7.0.2's production native compiler, AI SDK 7, Biome, Bun tests, and focused harness/security regression suites.

## Agent controls

Useful CLI commands:

- `/plan`, `/fix`, `/review`, `/test` — common engineering workflows.
- `/workspace <dir>`, `/allow <dir>` — select the primary workspace or explicitly add another root.
- `/add <file>`, `/context`, `/clear-context`, `/index`, `/map` — manage code context.
- `/approvals`, `/approve <id>`, `/deny <id>` — inspect and resolve gated tool actions.
- `/stop` — abort the active model/tool run.
- `/undo` — restore the last Night Code patch if no later change conflicts.
- `/sessions`, `/continue`, `/resume <id>` — restore durable local conversations.
- `/todo`, `/status`, `/stats`, `/cost`, `/doctor` — inspect agent and runtime state.

Use `nightcode --help` for startup options and `nightcode --version` for the exact build version.
Unknown options fail with usage guidance. In the TUI, Ctrl+C aborts an active run; when idle, it
saves the current session and exits.

## Configuration

Project policy lives in `.nightcode/config.yaml`:

```yaml
mode: BUILD
approvalMode: on-risk
maxAgentSteps: 20
maxRetries: 2
maxToolOutputChars: 60000
maxToolTimeoutMs: 120000
maxRunDurationMs: 900000
contextBudget: 16000
requirePlanForEdits: true
disabledTools: []
```

Provider/model selection and additional filesystem roots are trusted user settings. A project
`model` is ignored unless trusted configuration explicitly sets `NIGHTCODE_ALLOW_PROJECT_MODEL=true`,
and project `allowedPaths` never grants access.

See [configuration](docs/configuration.md), [architecture](docs/architecture.md), [security](docs/security.md), and [evaluation](docs/evaluation.md).

## API

- `GET /health`
- `GET /providers`
- `GET /models?provider=openai`
- `POST /chat`
- `POST /approvals`
- `GET /sessions/:sessionId/approvals`
- `DELETE /sessions/:sessionId`
- `POST /agents/coding/run`

`POST /chat` and `POST /approvals` stream one validated `LLMStreamChunk` JSON object per line. The response also carries `X-Nightcode-Session-Id`.

The server listens on `127.0.0.1` by default. `NIGHTCODE_API_TOKEN`, when set, protects every route
with bearer authentication and is mandatory when `NIGHTCODE_HOST` is not loopback. Authentication
does not provide TLS; terminate TLS in front of any remote deployment.

The server accepts workspaces only below `NIGHTCODE_SERVER_WORKSPACE_ROOTS` (the process working directory by default). Separate multiple roots with the platform path delimiter. Request bodies are limited to 8 MiB, and active or approval-pending sessions cannot be deleted.

## Quality gates

```powershell
bun run verify
```

`verify` runs formatting, linting, workspace-parallel TypeScript checks, tests with source-only text and LCOV coverage, enforced coverage floors, and dependency-ordered production builds. Useful focused commands are:

```powershell
bun run test:watch
bun run test:stress
bun run eval:harness
bun run build:cli:compile
bun run build:cli:bytecode
bun run deps:check
bun run clean
```

CI should install exact lockfile versions with `bun ci` before `bun run verify`. Local package binaries run with `bunx --no-install`, so a missing development dependency fails instead of being downloaded implicitly.

The bytecode CLI is an ESM standalone executable tied to the Bun version that built it. The regular bundle and compiled executable remain available for development and distribution respectively.

The repository uses TypeScript 7's native `tsc` with eight parallel checkers. No TypeScript compiler API compatibility package is needed because this project does not use the compiler API or typescript-eslint.

## Packages

- `packages/cli` — OpenTUI client and durable session repository.
- `packages/server` — agent runtime, tools, policy, MCP adapter, HTTP API, and model routing.
- `packages/shared` — versioned Zod contracts and model catalog.
- `packages/database` — Bun SQLite/Drizzle schema and explicit database factory.
