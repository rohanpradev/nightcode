# Live Vercel Gateway tests — 2026-10-07

Used the user-authorized Vercel AI Gateway key from the root `.env`, loaded explicitly through
`NIGHTCODE_ENV_FILE`. The key was neither displayed nor copied into reports. Each trial started
the actual HTTP server with bearer authentication, a fresh fixture workspace, the real Gateway
provider, and the production runtime and file tools. No mock models were used.

## Outcome

**GPT-4.1 mini passed all seven checks.** GPT-4.1 nano passed the transport and approval checks but
failed the README preservation task. This is a small integration sample, not a model benchmark.

| Check | Mini outcome |
| --- | --- |
| HTTP authentication and workspace boundary | Unauthenticated calls returned 401; outside-workspace requests returned 403 |
| Streaming reply and usage | Exact requested text, validated event stream, nonzero token counts |
| Non-stream README task | Real agent completed with file tools; original content and requested additions verified |
| Literal file edit | Dollar replacement tokens, UTF-8 BOM, and CRLF preserved in saved bytes |
| Approved undo and duplicate decision | No mutation before approval; original restored afterward; replay executed no tool |
| Denied deletion | Fixture remained unchanged before and after denial |
| Session cleanup | Completed sessions were released; approval-pending session deletion had returned 409 |

## Trials and estimated spending

Prices were fetched from the [live Gateway model catalog](https://ai-gateway.vercel.sh/v1/models).
Estimates use reported input/output tokens at standard catalog rates, without cache discounts;
they are not a billing receipt. Failed model runs are included.

| Trial | Result | Input tokens | Output tokens | Estimated USD |
| --- | --- | ---: | ---: | ---: |
| Nano, 6-step limit | 4/7 checks; README exhausted steps; BOM check had a test-reader bug, blocking undo test | 21,399 | 776 | 0.0024503 |
| Nano, 10-step limit | 6/7 checks; README introduction was lost despite a success response | 28,005 | 944 | 0.0031781 |
| Mini, 10-step limit | 7/7 checks passed | 23,559 | 1,115 | 0.0112076 |
| **Total** | | **72,963** | **2,835** | **0.0168360** |

The BOM false failure came from `Bun.file().text()` stripping a BOM during test verification.
Byte inspection showed that the production edit had preserved it. The grader now uses Node's
UTF-8 file reader, which retains the BOM. The nano README failures were not waived or reclassified
as successes. The second trial's content grader caught loss of the original introduction even
though the model said the work was complete.

## Reproduction and evidence

```powershell
$env:NIGHTCODE_ENV_FILE = Join-Path (Get-Location) '.env'
bun run test:gateway:live
```

The suite now defaults to `openai/gpt-4.1-mini`. Set `NIGHTCODE_LIVE_MODEL` to
`openai/gpt-4.1-nano` for a deliberate comparison. Only those two models are accepted; live catalog
prices must be no higher than $0.40/M input and $1.60/M output. Each model run permits ten steps,
768 output tokens per step, zero retries, and 45 seconds. The whole server has a four-minute limit.
These are resource limits, not an exact dollar spending cap.

Local reports, including stream events and non-stream results:

- `tmp/gateway-live-9vR4xH/report.json` — initial nano trial.
- `tmp/gateway-live-Bh8DjK/report.json` — corrected nano trial.
- `tmp/gateway-live-asHzDV/report.json` — successful mini trial.

Fixtures and reports are ignored by Git and contain no real project source or credentials.
Shell execution and project MCP servers were not used. The server workspace grant was restricted
to the disposable fixture. The normal application model configuration was not changed.

Formatting, lint, and package/script typechecks also passed. Long-running recovery, arbitrary
coding tasks, real MCP services, production database upgrades, and cross-platform live runs remain
outside this test. Mini's one successful trial is evidence of this workflow, not a reliability guarantee.
