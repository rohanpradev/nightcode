# Harness improvement plan

The October 20, 2026 implementation review is in [harness review](harness-review.md). The next
improvements should be selected from measured failures, with one change evaluated at a time.

## 1. Representative outcome evaluation

Build a versioned task set for localized fixes, multi-file changes, interruptions, and adversarial
repository content. Grade final workspace state with hidden tests. Record exact model, harness
revision, tool set, approvals, token/step/time limits, and cost per solve. Compare Astra and
GPT-6.1 Sol under identical budgets before changing defaults based on presumed quality.

The existing [live Gateway suite](live-gateway-tests-2026-10-07.md) verifies wiring and approvals;
it is not a representative coding benchmark. Follow the [evaluation strategy](evaluation.md).

## 2. Recoverable run journal

Persist ordered tool and approval events with idempotency keys and workspace revisions. Replay
must distinguish completed, running, and unknown external side effects. Add subprocess crash
tests before advertising resumable approvals or recovery of an interrupted tool execution.
The present SQLite conversation persistence does not provide those guarantees.

## 3. Evidence-preserving memory

Measure whether whole-exchange omission loses task constraints or verification evidence on long
runs. If it does, add explicit structured handoffs containing the objective, completed work,
changed paths, evidence references, unresolved errors, and pending tests. Keep them subordinate
to current user instructions and validate recovery on changed workspaces.

## 4. Execution isolation

Offer an OS-backed sandbox for shell and external tools, with explicit writable roots and network
policy. Canonical path checks and shell approval rules are useful but cannot confine arbitrary
approved programs. Test process-tree cancellation and real platform isolation independently on
Windows and Linux.

## 5. Selective parallel workers

Only add autonomous workers after outcome traces identify work that benefits from parallelism.
Use isolated workspaces, bounded budgets, structured results, and independent final-state
verification. Compare success rate, merge conflicts, latency, and total cost against the existing
single-session loop before making orchestration the default.
