# Configuration

## Environment

Core settings:

```dotenv
NIGHTCODE_PROVIDER=openai
NIGHTCODE_MODEL=gpt-5.6
NIGHTCODE_MAX_TOKENS=16384
NIGHTCODE_TEMPERATURE=0.2
NIGHTCODE_REASONING_EFFORT=high
NIGHTCODE_APPROVAL_MODE=on-risk
NIGHTCODE_MAX_AGENT_STEPS=20
NIGHTCODE_LOG_LEVEL=info
NIGHTCODE_TELEMETRY=false
```

Provider credentials and endpoint settings are documented in `.env.example`.

For the HTTP server, set `NIGHTCODE_SERVER_WORKSPACE_ROOTS` to a platform-delimited list of roots. The default is the server's startup directory.

## Project policy

`.nightcode/config.yaml` is strictly validated. Invalid values are reported in runtime instructions instead of being silently ignored.

| Field | Purpose |
|---|---|
| `model` | Provider model/deployment ID |
| `mode` | `BUILD` or `PLAN` |
| `approvalMode` | `always`, `on-risk`, or `never` |
| `maxTokens` | Maximum model output tokens |
| `maxRetries` | Provider retry budget |
| `maxAgentSteps` | Tool-loop step budget |
| `maxToolOutputChars` | Per-tool output bound |
| `maxToolTimeoutMs` | Maximum shell timeout |
| `contextBudget` | Repository-map token budget |
| `allowedPaths` | Additional explicit filesystem roots |
| `disabledTools` | Built-in or namespaced MCP tools to omit |
| `requirePlanForEdits` | Require exactly one in-progress plan item before mutation |

Project instructions are combined from `.nightcode/instructions.md`, `AGENTS.md`, `.github/copilot-instructions.md`, `CLAUDE.md`, `GEMINI.md`, `.codex/instructions.md`, GitHub instruction fragments, and Cursor rules.

## MCP

`.nightcode/mcp.json` accepts a direct server map or `{ "servers": ... }` wrapper.

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
      "headers": { "Authorization": "Bearer replace-me" },
      "requireApproval": true
    }
  }
}
```

Advertised names become `mcp_<server>_<tool>`, preventing collisions with built-in tools. HTTP is recommended for production; stdio is intended for local servers. Do not commit secrets in this file—inject them through a deployment-specific configuration mechanism.
