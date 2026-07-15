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

Run all gates with:

```powershell
bun run verify
```

Use `bun run test:stress` to repeat every test three times in randomized order, and `bun run eval:harness` for the deterministic agent-runtime and tool-policy subset.

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

Useful references are [OpenAI's evaluation reporting guidance](https://openai.com/index/trustworthy-third-party-evaluations-foundations/), [Anthropic's agent eval guide](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [SWE-bench](https://www.swebench.com/), and the [SWE-agent ACI paper](https://arxiv.org/abs/2405.15793).
