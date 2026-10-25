# Night Code

Night Code is a terminal-first coding-agent harness for Bun and TypeScript. It combines a scoped agent runtime, canonical workspace boundaries, approval-gated tools, transactional patches, durable local sessions, MCP tools, repository context, and a typed streaming API.

Models from OpenAI and Anthropic are routed through Vercel AI Gateway. Only a Gateway credential
is required; provider API keys are not used.

## Quick start

Install [Bun 1.4.4](https://bun.com/blog/bun-v1.4.4) or newer (`bun upgrade` updates an existing install).

```powershell
bun install
New-Item -ItemType Directory -Force "$HOME\.nightcode"
Copy-Item .env.example "$HOME\.nightcode\.env"
bun run dev:cli -- --workspace C:\path\to\project
```

Night Code deliberately does not load `.env` from the selected workspace. Set a Vercel AI Gateway
credential in `~/.nightcode/.env`, in the parent process, or in an explicit file selected
by the parent-process `NIGHTCODE_ENV_FILE` variable:

```dotenv
AI_GATEWAY_API_KEY=your-vercel-ai-gateway-key
NIGHTCODE_PROVIDER=openai
NIGHTCODE_MODEL=gpt-6-astra
```

On Vercel, the runtime can authenticate with `VERCEL_OIDC_TOKEN` instead. Gateway model IDs use
the form `provider/model`; Night Code adds the provider prefix when you select a known short ID.

New OpenAI sessions default to GPT-6 Astra. GPT-6.1 Sol is available for a lower-cost option,
and GPT-6 Luna for focused tasks. Existing explicit model selections remain available.
GPT-6 tool calls use Responses through Gateway; reasoning requests omit unsupported sampling
parameters. Token costs shown in the CLI estimate base rates and may differ from Gateway billing.
Anthropic sessions default to Claude Sonnet 5.5, with Opus 5.5 also available. Their signed
reasoning history remains append-only across tools and approval continuations.

To run the HTTP service separately:

```powershell
bun run dev:server
```

`bun dev` starts both the terminal UI and HTTP service in watch mode. The HTTP service
listens on `http://127.0.0.1:3000` by default; set `PORT` or `NIGHTCODE_PORT` to use another
port. If that port is already occupied by another process, stop that process or choose
a different port.

To check the complete local API and AI editing workflow, configure your Gateway credential
as above, then run `bun run test:server:live`. This opt-in check makes a real model request
and verifies that the agent improves a temporary README using file tools. It prints the
result path under `tmp/server-live-*` and may incur provider charges. The regular `bun test`
suite does not require a live model.

For the broader low-cost live suite (streaming, README edits, literal replacements, approved undo,
duplicate approval protection, and denied deletion), run `bun run test:gateway:live`. It defaults to
GPT-4.1 mini with zero retries, ten steps per run, and 768 output tokens per step. If your trusted
Gateway key is in this repository's root `.env`, explicitly select it for the test:

```powershell
$env:NIGHTCODE_ENV_FILE = Join-Path (Get-Location) '.env'
bun run test:gateway:live
```

Reports and disposable fixtures are saved under `tmp/gateway-live-*`; no key is written to reports.
See the [live test results](docs/live-gateway-tests-2026-10-07.md) for costs and the nano/mini comparison.

## What is implemented

- One stateful runtime per session and workspace; concurrent runs in one session are rejected.
- Filesystem mutations from sessions with overlapping workspaces or allowed roots are serialized
  through an abort-aware FIFO coordinator.
- Versioned NDJSON events with run, sequence, step, tool-call, approval, usage, abort, error, and completion metadata.
- Presentation-only `notice` messages that are persisted by the CLI but never sent to a model.
- Canonical path authorization that resolves symlinks and junctions before containment checks.
- Structured, multi-file patching with preflight validation, atomic writes, rollback, SHA-256 preconditions, checkpoints, and conflict-safe undo.
- A trusted runtime-policy envelope for approval, BUILD/PLAN mode, model output, retry/step,
  tool output/timeout, run-duration, context, and filesystem-root budgets. Repository policy may
  narrow this envelope but cannot weaken it.
- PLAN mode exposes inspection tools only, does not connect project MCP servers, and permits only
  the narrow low-risk shell inspection allowlist.
- Risk-classified shell execution with approval modes, time/output bounds, process-tree cancellation, a minimal child environment, and provider-secret stripping.
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
- Bun 1.4.4's built-in formatter and TypeScript checker, Drizzle ORM/Kit 1.0.0-rc.4,
  AI SDK 7.0.153 with MCP 2.0.84, OpenTUI 0.6.8, React 19.3.1, Hono 4.13.14, Biome 2.6.3 for linting, and focused regression suites.
- Demand-driven HTTP streaming with cancellation cleanup, client events bounded by UTF-8 bytes, and
  failure-preserving run outcomes.
- Streaming line reads that return a bounded prefix of oversized lines, and repository search/indexing
  across `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, and `.cjs` sources. Glob tools accept Bun's
  extended patterns such as `**/!(*.test).ts` and `shard-{1..3}.json`.

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

See [configuration](docs/configuration.md), [architecture](docs/architecture.md),
[security](docs/security.md), [evaluation](docs/evaluation.md), and the
[source-backed improvement plan](docs/improvement-plan.md). The [dependency review](docs/dependency-review.md)
records the official documentation, selected versions, compatibility changes, and validation
results for dependency upgrades, including the October 25, 2026 refresh. The [harness review](docs/harness-review.md) connects
the current engineering research to implemented behavior and remaining evaluation work.

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

The `/models` command and `GET /models` read Vercel AI Gateway's live model catalog, cached for
five minutes. If Gateway is unreachable, the CLI uses its bundled catalog as a fallback.

The server listens on `127.0.0.1` by default. `NIGHTCODE_API_TOKEN`, when set, protects every route
with bearer authentication and is mandatory when `NIGHTCODE_HOST` is not loopback. Authentication
does not provide TLS; terminate TLS in front of any remote deployment.

The server accepts workspaces only below `NIGHTCODE_SERVER_WORKSPACE_ROOTS` (the process working directory by default). Separate multiple roots with the platform path delimiter. Request bodies are limited to 8 MiB, and active or approval-pending sessions cannot be deleted.

## Quality gates

```powershell
bun run verify
```

`verify` runs formatting, linting, workspace-parallel and build-script TypeScript checks,
Drizzle migration checks, tests with source-only text and LCOV coverage, enforced coverage floors,
and dependency-ordered production builds. Empty coverage reports fail the gate. Useful focused commands are:

```powershell
bun run test:watch
bun run test:stress
bun run format
bun run format:check
bun fmt --changed
bun run eval:harness
bun run build:cli:compile
bun run build:cli:bytecode
bun run test:cli:bundle
bun run deps:check
bun run db:check
bun run clean
```

The GitHub Actions workflow runs `bun ci`, `bun run verify`, and randomized repeat tests on
Windows and Linux with Bun 1.4.4. Actions are pinned to commit hashes and coverage is retained
for 14 days. Local package binaries run with `bunx --no-install`, so a missing development
dependency fails instead of being downloaded implicitly.

CI smoke-tests both the source and built JavaScript terminal UI. Ship the bundle together with
all emitted assets in `packages/cli/dist`; native-library paths resolve relative to the bundle.

The bytecode CLI is an ESM standalone executable tied to the Bun version that built it. The regular bundle and compiled executable remain available for development and distribution respectively.

Project Bun configuration disables automatic `.env` loading. Standalone executables also disable
automatic `.env` and `bunfig.toml` loading at build time. To launch a source entry or JS bundle
from another directory, use `bun --no-env-file <entry>` so configuration comes from the trusted
user settings described above.

Formatting uses Bun's built-in `bun fmt`. The `[fmt]` section in `bunfig.toml` defines the shared
style; `bun run format` writes changes and `bun run format:check` checks without writing.
Use `bun fmt --changed` to format files that differ from the default branch. Biome handles linting
only, so formatter output is enforced by a single tool.

Workspace type checks use `bun check`; build scripts use `--check` or `Bun.build({ check: true })`.
The root build-script check uses `bun check --no-script --project scripts/tsconfig.json` because
the root `check` script is the combined quality gate. Bun 1.4.4's `--no-script` selects the built-in
checker even when a package defines a `check` script. TypeScript 7.0.2 remains installed for editor
support. No compiler API compatibility package is needed.

OpenTUI 0.6 restores the terminal asynchronously. CLI shutdown waits for `renderer.closed`
before exiting, including the UI smoke test.

Drizzle ORM and Kit are pinned to the same v1 release candidate. Migration history uses the v3
folder format and the database factory uses `defineRelations`. See the
[database upgrade notes](docs/database.md) for migration commands and compatibility checks.

## Packages

- `packages/cli` — OpenTUI client and durable session repository.
- `packages/server` — agent runtime, tools, policy, MCP adapter, HTTP API, and model routing.
- `packages/shared` — versioned Zod contracts and model catalog.
- `packages/database` — Bun SQLite/Drizzle schema and explicit database factory.
