# Harness review — October 20, 2026

This review combines current upstream documentation, engineering reports, direct package-registry
checks, and the public Vercel Gateway model catalog. Decisions below distinguish implementation
correctness from model outcome quality. No comparative coding benchmark establishes that this is
the best harness, and a documentation review cannot establish that claim.

## Design decisions

| Source reviewed | Applied decision | Verification |
| --- | --- | --- |
| [AI SDK loop control](https://ai-sdk.dev/docs/agents/loop-control) | Use the existing agent loop's `prepareStep` and stop conditions for bounded context and progress detection. | Mock-model integration tests and direct helper regressions. |
| [OpenAI model migration](https://developers.openai.com/api/docs/guides/latest-model) | Add the verified GPT-6 family, default new OpenAI sessions to Astra, retain explicit legacy choices, and adapt reasoning/sampling options. | Model metadata, Gateway routing and request-option tests. |
| [OpenAI memory and compaction](https://developers.openai.com/cookbook/examples/agents_sdk/building_reliable_agents_memory_compaction) | Keep context management explicit and preserve the user objective; do not claim omission is a semantic summary. | Conversation selection and protocol-preserving compaction tests. |
| [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Favor bounded repository navigation and targeted file reads; include truncation markers in the actual budget. | Repository-map and pinned-context regressions. |
| [Anthropic long-running harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Keep changes evidence-driven, record remaining work, and evaluate actual artifacts instead of the agent's confidence. | Deterministic harness checks plus opt-in live integration suites. |
| [Claude Sonnet 5.5 migration](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide) | Freeze instructions and preserve signed history across tool and approval continuations. | Multi-step and approval-continuation model fixtures. |
| [MCP security practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) and [Bun fetch](https://bun.com/docs/runtime/networking/fetch#connecting-to-a-specific-address) | Enforce transport boundaries using native DNS pinning while preserving TLS identity and cancellation. | Sensitive-path, shell-hook, HTTP streaming, and real TLS regressions. |

## What changed

- Dependencies were refreshed to the current stable AI SDK and MCP patches. Existing Bun,
  OpenTUI, React, Hono, TypeScript, and Biome versions were already current; the matching
  Drizzle release-candidate pair remains on its compatible channel. See the
  [dependency review](dependency-review.md) for exact versions and registry checks.
- The bundled model catalog now includes GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna
  with verified standard context/output limits and base token prices. The live catalog remains
  the model discovery source. CLI cost estimates exclude long-context and service-tier premiums.
- Anthropic sessions default to Sonnet 5.5, with Opus 5.5 also available. Signed reasoning chains
  preserve their system instructions and tool definitions through approval pauses; completed
  historical approvals may compact atomically in models that permit local history edits.
- Exact live Gateway context/output limits are retained for models outside the bundled catalog,
  with five-minute caching, cancellable discovery, bounded output, and offline fallback. Optional
  repository maps shrink when necessary to leave room for actual conversation.
- The runtime detects repeated inspection/failure loops and reports step exhaustion distinctly
  from a completed answer. Successful mutations and unknown external tools do not count as
  stagnant solely because they return identical acknowledgements.
- Model history is budgeted separately from the repository-map allowance. Compaction removes
  complete old exchanges, keeps user messages and recent work, and preserves tool/approval
  relationships. Irreducible input fails explicitly rather than silently cutting tool arguments
  or user instructions.
- Repository context pins resolve from the workspace, are deduplicated by canonical path, and
  cannot bypass containment or sensitive-file checks. Indexed paths are authorized again before
  reading. File prefixes and repository-map headers/separators count toward their budgets.
- Local compact mode ignores presentation notices before selecting recent conversation. CLI
  file attachments read bounded prefixes instead of loading the entire file before truncation.
- Credential-directory checks take precedence over template-file exemptions. Git inspection
  avoids repository hook execution, and MCP networking validates destinations at the transport
  boundary. See [security](security.md) for the threat model and limits.

## Validation and limits

The starting workspace passed 187 tests with host permissions. The restricted execution sandbox
could not exercise loopback networking and certain file replacement/link operations; those checks
must run with the relevant OS permissions. No tests were weakened to hide that restriction.

Final verification passed 261 tests, 783 randomized test executions, all package builds, coverage
gates, and source/bundle/standalone/bytecode terminal startup checks. Detailed results are in
[evaluation](evaluation.md). All automated model tests
use deterministic mocks. Paid inference, account-specific GPT-6 access, and Linux CI execution
are separate checks. Model catalog availability is not a live inference result.

Context token counts are estimates with reserved headroom, not provider tokenization guarantees.
Removing complete exchanges can still discard useful evidence; the runtime says so and can
re-read current files. Durable cross-process tool continuations and representative hidden-test
coding evaluations remain work described in the [improvement plan](improvement-plan.md).
