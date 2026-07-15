# Night Code

Night Code is a terminal-first coding-agent harness for Bun and TypeScript. It combines a scoped agent runtime, canonical workspace boundaries, approval-gated tools, transactional patches, durable local sessions, MCP tools, repository context, and a typed streaming API.

The default OpenAI model is `gpt-5.6`. Anthropic and Azure OpenAI are also supported.

## Quick start

```powershell
bun install
Copy-Item .env.example .env
bun run dev:cli -- --workspace C:\path\to\project
```

Set at least one provider credential in `.env`:

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
- Versioned NDJSON events with run, sequence, step, tool-call, approval, usage, abort, error, and completion metadata.
- Presentation-only `notice` messages that are persisted by the CLI but never sent to a model.
- Canonical path authorization that resolves symlinks and junctions before containment checks.
- Structured, multi-file patching with preflight validation, atomic writes, rollback, SHA-256 preconditions, checkpoints, and conflict-safe undo.
- Risk-classified shell execution with approval modes, time/output bounds, cancellation, a minimal child environment, and provider-secret stripping.
- Session/workspace-pinned HTTP routes, bounded runtime retention, cancellation propagation, and structured stream errors.
- SQLite session storage with WAL, legacy `sessions.json` import, atomic upserts, and a 100-session retention limit.
- Workspace-isolated, incrementally refreshed repository maps.
- Validated `.nightcode` configuration with surfaced diagnostics instead of silent fallback.
- MCP over HTTP or local stdio, namespaced tools, allowlists, redacted inherited environments, and approval by default.
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

## Configuration

Project policy lives in `.nightcode/config.yaml`:

```yaml
model: gpt-5.6
mode: BUILD
approvalMode: on-risk
maxAgentSteps: 20
maxRetries: 2
maxToolOutputChars: 60000
maxToolTimeoutMs: 120000
contextBudget: 16000
requirePlanForEdits: true
allowedPaths: []
disabledTools: []
```

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

The server accepts workspaces only below `NIGHTCODE_SERVER_WORKSPACE_ROOTS` (the process working directory by default). Separate multiple roots with the platform path delimiter.

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
