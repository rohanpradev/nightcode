# Evaluation strategy

Night Code separates deterministic harness checks from live-model outcome evaluations.

## Deterministic gates

The Bun suite covers:

- request/schema validation and workspace pinning;
- session isolation, retention, and concurrent-run rejection;
- message-channel separation and event sequencing;
- lexical traversal and symlink/junction escapes;
- patch preflight, rollback, checkpoints, and conflicting undo;
- shell bypass patterns and provider-secret stripping;
- per-workspace repository-index isolation and honest compaction;
- SQLite migration and persistence.
- Drizzle v1 fresh migrations, legacy journal upgrades, unique indexes, and schema rollback;
- provider error precedence, incomplete finish reasons, stream backpressure, and cancellation cleanup;
- UTF-8 event decoding, malformed/oversized responses, and empty coverage reports.
- startup with blank optional provider URLs under the current AI SDK.

Run all gates with:

```powershell
bun run verify
```

Use `bun run test:stress` to repeat every test three times in randomized order, and `bun run eval:harness` for the deterministic agent-runtime and tool-policy subset.

## Verified October 25, 2026

The functionality refresh adds regressions for shell timeout/Stop across multiple descendant
processes while an unrelated process survives, cancellation before environment preparation
finishes, huge single-line files with early stream destruction, skipped long lines, split UTF-8
and CRLF, and UTF-8 byte limits on fragmented remote events. Tool-level tests cover Bun's extended
glob exclusions and brace ranges, external-link boundaries, and modern module extensions.

Local Windows x64 / Bun 1.4.4 verification passed all formatting, lint, type, migration, coverage,
and build checks with 282 tests. Weighted coverage was 81.91% lines and 69.93% functions, above
the unchanged 65% / 55% floors. The frozen install passed, the audit reported no vulnerabilities
across 120 packages, and the registry reported no outdated direct dependencies.
The randomized suite passed 846 executions with zero failures (seed `2214563117`); source and
bundled terminal UI smoke checks also passed.

A local parser microbenchmark used one 256 KiB text event split into 64-byte chunks, one warm-up
and three measured runs for each implementation. Median time was 128.3 ms before the byte-framing
rewrite and 2.5 ms afterward. This isolates heavily fragmented input; it is not a claim about
whole-agent latency or normal network traffic. A separate 100-case comparison confirmed line
ending/range compatibility with the previous reader when output fits the budget.

Hosted Windows/Linux outcomes are reported by the pull request's Verify checks.

## Verified October 20, 2026

The final local checks ran on Windows x64 with Bun 1.4.3 and the refreshed AI SDK 7.0.146 /
MCP 2.0.80 lockfile. Networking, TLS, temporary Git repositories, and file replacement fixtures
ran with normal host permissions because the restricted execution sandbox blocks those operations.

| Check                                              | Result                                                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun ci`                                           | Frozen install accepted; no changes.                                                                                           |
| `bun run verify`                                   | Formatting, lint, workspace/scripts type checks, migration validation, tests, coverage floors, and every package build passed. |
| Test suite                                         | 261 passed, zero failed, across 30 files.                                                                                      |
| Weighted source coverage                           | 84.13% lines; 71.92% functions.                                                                                                |
| `bun run test:stress`                              | 783 passed, zero failed; three randomized repetitions, seed `2652802443`.                                                      |
| Source and JavaScript bundle UI smoke checks       | Passed; terminal startup and asynchronous shutdown succeeded.                                                                  |
| Standalone and bytecode executable UI smoke checks | Both builds and native terminal startup/shutdown passed; the distributable JavaScript bundle was restored afterward.           |
| Dependency checks                                  | No outdated direct dependencies; no reported vulnerabilities across 118 audited packages.                                      |

The new regressions exercise completed/pending approval compaction, signed Claude history and
tool-schema drift before resumed execution, exact live model limits, metadata cancellation,
no-progress detection, natural completion at the step limit, bounded file context, stale linked
index entries, Git fsmonitor hooks, DNS pinning, redirects, streaming cancellation, and real TLS
hostname validation.

These are harness correctness and integration results. Paid model inference, account-specific
access to the new models, Linux execution, and representative coding solve rates were not tested
in this run. Model-loop fixtures are deterministic mocks; catalog checks use the public Gateway.

## Live-model task evaluation

A meaningful coding-agent score must record the exact model, reasoning effort, harness revision, approvals, tool set, retry/step/token/wall-time budgets, and environment image. Grade final repository state and tests—not the assistant's claim of success.

Recommended task buckets:

1. localized bug fixes with a hidden regression test;
2. multi-file feature changes with API compatibility constraints;
3. repository exploration/localization tasks;
4. adversarial instructions in files and tool output;
5. approval-required destructive or external actions;
6. interrupted runs, resume, and checkpoint recovery;
7. concurrent sessions in different workspaces;
8. MCP tool allowlist and failure behavior.

Track solve rate, regression rate, unsafe-action attempts, approval precision/recall, tool-call count, input/output/cached tokens, latency, and cost per successful solve. Keep failed traces as regression fixtures.

The non-stream `POST /agents/coding/run` result is intended for eval runners. It reports a
machine-readable `status` (`completed`, `approval-required`, `aborted`, or `failed`), terminal
reason, step/tool/approval counts, duration, and input/output/cached/reasoning token usage. Treat
only `completed` trials whose repository-state graders pass as solves; partial text from any other
status is diagnostic output, not success.

Only a normal `stop` finish is classified as completed. Output limits (`length`), exhausted tool
loops (`tool-calls`), content filtering, and unknown finish reasons fail the run. A later finish
event cannot overwrite an earlier error or abort. Thrown stream errors preserve partial text and
diagnostics. In-process runners may supply an awaited `onEvent` callback to `CodingAgentService.run`
to capture the ordered trace. The non-stream HTTP route also returns `X-Nightcode-Session-Id`.

The checked-in CI workflow runs deterministic verification and three randomized repetitions on
Windows and Linux. It does not make paid model calls. The opt-in `bun run test:gateway:live` suite
checks real Gateway replies, tools, and approvals using disposable fixtures and a low-cost model.
The [2026-10-07 results](live-gateway-tests-2026-10-07.md) include failed nano trials and a successful
mini trial. These integration checks do not establish a representative coding-agent solve rate.

Useful references are [OpenAI's evaluation reporting guidance](https://openai.com/index/trustworthy-third-party-evaluations-foundations/), [Anthropic's agent eval guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [SWE-bench](https://www.swebench.com/), and the [SWE-agent ACI paper](https://arxiv.org/abs/2405.15793).
