# Configuration

## Trusted environment

Night Code deliberately ignores `.env` files in the selected workspace. Repository-controlled
environment values must not redirect provider traffic, grant filesystem roots, or weaken runtime
policy.

Trusted values come from the parent process or one user-owned dotenv file:

1. If the parent process sets `NIGHTCODE_ENV_FILE`, Night Code loads only that resolved file.
2. Otherwise it loads `~/.nightcode/.env` (using `NIGHTCODE_HOME`, `HOME`, or `USERPROFILE` to find
   the user home).

Set `NIGHTCODE_ENV_FILE` before launching Night Code; putting it inside a workspace `.env` has no
effect. A typical user configuration is:

```dotenv
OPENAI_API_KEY=sk-...
NIGHTCODE_PROVIDER=openai
NIGHTCODE_MODEL=gpt-5.6
NIGHTCODE_MODE=BUILD
NIGHTCODE_APPROVAL_MODE=on-risk
NIGHTCODE_MAX_TOKENS=16384
NIGHTCODE_MAX_RETRIES=2
NIGHTCODE_MAX_AGENT_STEPS=20
NIGHTCODE_MAX_TOOL_OUTPUT_CHARS=60000
NIGHTCODE_MAX_TOOL_TIMEOUT_MS=120000
NIGHTCODE_MAX_RUN_DURATION_MS=900000
NIGHTCODE_CONTEXT_BUDGET=16000
NIGHTCODE_REQUIRE_PLAN_FOR_EDITS=true
NIGHTCODE_LOG_LEVEL=info
NIGHTCODE_TELEMETRY=false
```

Additional trusted runtime settings:

| Variable | Purpose |
|---|---|
| `NIGHTCODE_TEMPERATURE` | Model sampling temperature |
| `NIGHTCODE_REASONING_EFFORT` | Provider reasoning-effort hint |
| `NIGHTCODE_AGENT_MODE` | Set `false` for a single model response with no tools |
| `NIGHTCODE_SYSTEM_PROMPT` | User-owned base system prompt |
| `NIGHTCODE_ALLOW_PROJECT_MODEL` | Set `true` to permit a repository to select its `model` |
| `NIGHTCODE_ALLOWED_PATHS` | Additional absolute roots, separated by the platform path delimiter |
| `NIGHTCODE_DISABLED_TOOLS` | Comma-separated built-in or namespaced MCP tool names |
| `NIGHTCODE_DEBUG_STREAM` | Enable additional local stream diagnostics |

## Policy precedence

The effective runtime policy is a trusted user envelope narrowed by repository configuration:

- `PLAN` wins over `BUILD`. A repository may enter PLAN mode but cannot leave user-selected PLAN
  mode.
- `always` can add approval prompts. Repository `never` adds hard denials for high-risk operations
  while preserving any stricter trusted prompt policy; it does not silently turn approval-required
  actions into automatic execution.
- Project token, retry, step, tool-output, tool-timeout, run-duration, and context values may only
  lower their trusted ceiling.
- Project `disabledTools` is additive and cannot disable `updateTaskPlan`.
- Project `requirePlanForEdits: false` is ignored unless trusted configuration has already set
  `NIGHTCODE_REQUIRE_PLAN_FOR_EDITS=false`.
- Project `allowedPaths` is accepted for compatibility but ignored. Grant roots with `/allow` for
  the current runtime or with trusted `NIGHTCODE_ALLOWED_PATHS`.
- Project `model` is ignored unless trusted configuration sets `NIGHTCODE_ALLOW_PROJECT_MODEL=true`.
- A request may further narrow output tokens, approval prompting, and agent mode, but cannot replace
  the trusted system prompt or expand the runtime envelope.

Ignored or capped settings are surfaced as runtime-policy diagnostics instead of failing silently.

## Project policy

`.nightcode/config.yaml` is strictly validated, canonically contained inside the workspace, and
size-bounded. Invalid values are reported in runtime instructions.

| Field | Effective behavior |
|---|---|
| `model` | Used only when trusted `NIGHTCODE_ALLOW_PROJECT_MODEL=true` |
| `mode` | `BUILD` or restrictive `PLAN` |
| `approvalMode` | `always`, `on-risk`, or denial-oriented `never`, combined with trusted policy |
| `maxTokens` | May lower the maximum model output tokens |
| `temperature` | Sampling temperature; trusted environment takes precedence |
| `maxRetries` | May lower the provider retry budget |
| `maxAgentSteps` | May lower the tool-loop step budget |
| `maxToolOutputChars` | May lower the per-tool output bound |
| `maxToolTimeoutMs` | May lower the shell timeout ceiling |
| `maxRunDurationMs` | May lower the complete run deadline |
| `contextBudget` | May lower the repository-map token budget |
| `allowedPaths` | Compatibility field; ignored with a diagnostic |
| `disabledTools` | Additive built-in or namespaced MCP tools to omit |
| `requirePlanForEdits` | May require a live in-progress plan item before mutation |

Example restrictive project policy:

```yaml
mode: BUILD
approvalMode: on-risk
maxTokens: 12000
maxRetries: 2
maxAgentSteps: 20
maxToolOutputChars: 60000
maxToolTimeoutMs: 120000
maxRunDurationMs: 900000
contextBudget: 16000
requirePlanForEdits: true
disabledTools: []
```

Project instructions are combined from `.nightcode/instructions.md`, `AGENTS.md`,
`.github/copilot-instructions.md`, `CLAUDE.md`, `GEMINI.md`, `.codex/instructions.md`, GitHub
instruction fragments, and Cursor rules. Each source is canonically contained and size-bounded,
with a one-megabyte combined instruction budget. They are labeled as untrusted repository
instructions in the prompt; deterministic tool policy still controls their effects.

## PLAN mode

PLAN mode supports inspection and reasoning without repository mutation. Mutation tools are omitted,
project MCP servers are not connected, and shell execution is limited to the narrow low-risk
read-only Git inspection allowlist. Direct sensitive-file reads still require approval or are denied
under non-interactive policy.

## HTTP service

| Variable | Purpose |
|---|---|
| `NIGHTCODE_HOST` | Bind address; defaults to `127.0.0.1` |
| `NIGHTCODE_PORT` or `PORT` | Listen port; defaults to `3000` |
| `NIGHTCODE_API_TOKEN` | Bearer token required on every route when configured; mandatory off loopback |
| `NIGHTCODE_SERVER_WORKSPACE_ROOTS` | Canonical workspace roots separated by the platform path delimiter |
| `NIGHTCODE_SERVER_URL` | Base URL for HTTP-client integrations; the TUI uses the embedded runtime |

The default workspace root is the server startup directory. Authentication is not encryption; use
TLS termination for any non-local deployment. Request bodies are limited to 8 MiB.

## MCP

`.nightcode/mcp.json` accepts a direct server map or a `{ "servers": ... }` wrapper.

```json
{
  "servers": {
    "local-tools": {
      "transport": "stdio",
      "command": "bun",
      "args": ["run", "tools/mcp-server.ts"],
      "env": { "TOOL_MODE": "local" },
      "allowedTools": ["lookup", "diagnose"],
      "requireApproval": true
    },
    "remote-docs": {
      "transport": "http",
      "url": "https://example.com/mcp",
      "allowedTools": ["search"],
      "requireApproval": true
    }
  }
}
```

Project MCP configuration is inert until trusted user configuration either lists the exact canonical
workspace in `NIGHTCODE_TRUSTED_MCP_WORKSPACES` (platform-delimited) or sets
`NIGHTCODE_ENABLE_PROJECT_MCP=true`. The latter trusts MCP configuration in every opened workspace
and should be used only in a tightly controlled environment.

Advertised names become `mcp_<server>_<tool>`, preventing collisions with built-in tools. Remote MCP
requires HTTPS; HTTP is accepted only for loopback. Redirects and embedded URL credentials are
rejected, and literal private, link-local, loopback, and known metadata targets are blocked for
remote URLs. Connection and discovery default to 15 seconds and can be changed with
`NIGHTCODE_MCP_TIMEOUT_MS` from 1,000 to 120,000 milliseconds; close attempts are separately bounded.

The schema accepts `headers` and per-server `env`, but Night Code does not currently provide a
secret store or variable interpolation for this file. Do not commit credentials. MCP hostname checks
also do not eliminate DNS rebinding; use network egress controls for untrusted endpoints. See the
[MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).
