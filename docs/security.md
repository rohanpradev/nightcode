# Security model

Night Code assumes model output, repository contents and instructions, tool results, MCP
descriptions, and fetched content can be adversarial. It applies deterministic controls outside the
prompt, but it is a host-user process rather than a complete isolation boundary.

## Trust hierarchy

Workspace `.env` files are never loaded. Provider routing, the base system prompt, additional
filesystem roots, and the upper runtime-policy envelope come from the parent process,
`NIGHTCODE_ENV_FILE`, or `~/.nightcode/.env`.

Repository `.nightcode` configuration can narrow budgets, enter PLAN mode, add prompts or hard
denials, require planning, and disable tools. It cannot grant filesystem roots, leave trusted PLAN
mode, raise trusted budgets, disable the task-plan safeguard, or select a model unless trusted
configuration explicitly permits project model selection. Repository instructions are canonically
contained and bounded, labeled as untrusted in the prompt, and remain subordinate to deterministic
tool policy.

## Approval modes

- `always` prompts for every mutation, MCP tool, and shell command, including the low-risk
  inspection allowlist.
- `on-risk` automatically permits bounded built-in reads and a narrow read-only Git inspection
  allowlist. General shell execution, project code execution, network commands, deletes, undo,
  external-root mutations, sensitive-file reads, and approval-gated MCP tools pause for review.
- `never` never prompts. High-risk shell actions, deletes, undo, external-root mutations,
  sensitive-file reads, and approval-gated MCP calls are denied. Lower-risk operations may still
  execute non-interactively.

Repository `always` may add prompting. Repository `never` adds high-risk hard denials while
preserving stricter trusted prompting; it cannot convert an operation that trusted policy would
prompt for into an automatic action.

Approval resolution is atomic and idempotent within the running process. Concurrent or repeated
responses for the same approval cannot execute its tool twice, and a conflicting repeated decision
is rejected.

## Filesystem and mutation boundary

Paths are resolved relative to the selected workspace unless absolute. The boundary resolves
existing symlinks/junctions, or the nearest existing ancestor for new paths, before checking
containment. Explicit additional roots are tracked separately so policy can require approval for
external mutations.

Patch operations support SHA-256 preconditions. A structured patch validates every operation before
the first write and rolls back the batch on an ordinary write failure. Undo verifies that every file
still matches Night Code's post-patch content before restoring anything, preventing accidental
overwrite of later user edits.

All four editing tools share bounded, reversible UTF-8 text snapshots. Files are limited to 8 MiB;
combined before/after snapshots in one patch are limited to 32 MiB. Invalid UTF-8, NUL-containing
files, and malformed Unicode output are rejected before any writes. UTF-8 BOMs and line endings
are preserved. Literal replacements reject overlapping matches and do not interpret dollar tokens.
Undo reauthorizes paths and rejects redirected junctions/symlinks before checking content. It uses
the same transactional patch path, including rollback on ordinary restore failures. Rollback attempts
every affected file and reports paths that could not be restored instead of silently suppressing errors.

Mutations reserve the primary workspace and all explicitly allowed roots together. Reservations
with equal or overlapping canonical paths are serialized FIFO and can be cancelled while waiting.
This covers nested workspaces, shared external roots, and roots added with `/allow`. Directory
aliases resolve through their nearest existing ancestor, including for paths not yet created.
Disjoint roots remain concurrent. Reservations are process-local and deliberately conservative:
granting a broad root reduces concurrency even when a particular operation touches only one file.

## Sensitive files and search

Conventional credential and private-key paths—such as `.env*`, `.ssh`, `.aws`, `.azure`, `.kube`,
credential files, and common private-key extensions—are excluded from repository indexing and
literal grep. Direct `readFile`, `readLines`, and `fileInfo` calls require approval, or are denied in
non-interactive/high-risk-denial policy. Example/template dotenv files remain readable.

The classifier is filename/path based. It is not content inspection or data-loss prevention: a
secret stored under an ordinary filename is not detected, and a conventional sensitive filename
may produce a false positive. Literal grep is case-insensitive and bounded by file count, file size,
line length, output, and cancellation; it intentionally does not accept regular expressions.

## Shell boundary

The shell tool provides:

- a narrow static risk classification and user approval policy;
- a canonical, authorized working directory;
- time limits, bounded stdout/stderr, cancellation, and exit codes;
- a minimal environment with provider credentials and secret-like variables removed;
- isolated `HOME`, `USERPROFILE`, `TMP`, and `TEMP` directories under a private OS temporary root.

Multiline commands and control-character separators never qualify for automatic read-only approval.
Only a small allowlist of `git status` and branch-listing arguments can run unattended; commands
that print file contents or use mutation-capable flags require approval. Allowed Git inspection runs
directly, bypassing the shell, with paging and repository-configured
[`core.fsmonitor`](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corefsmonitor)
hooks disabled. Use a current Git release; Git versions before 2.36 do not consistently interpret
the boolean fsmonitor setting.

The local shell runner is **not an operating-system sandbox**. An approved general-purpose command
still has the host user's process, filesystem, and network permissions. Timeouts and cancellation
terminate the command's isolated process group on Unix and use `taskkill /T /F` on Windows before
the parent shell exits. Output readers are cancelled and released after termination. This cleans up
ordinary descendants; deliberately detached or already orphaned processes can still escape that
cleanup and require OS-level isolation.

For untrusted autonomous workloads, run Night Code inside a disposable container or VM with
filesystem and network policy. See the isolation guidance from
[OpenAI](https://developers.openai.com/codex/sandboxing) and
[Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing).

## MCP boundary

Project MCP configuration is disabled until the exact canonical workspace is trusted through
`NIGHTCODE_TRUSTED_MCP_WORKSPACES`, or trusted configuration enables project MCP globally. PLAN mode
does not connect MCP servers.

Tools are namespaced, can be allowlisted, inherit a minimal redacted environment for stdio, and
default to approval. Connect, discovery, and close operations are time-bounded. Remote transport
requires HTTPS except for explicitly configured loopback servers, rejects redirects and embedded URL
credentials, and blocks private, link-local, metadata, multicast, documentation, and other reserved
address ranges, including IPv4-mapped private IPv6 addresses and NAT64/6to4 transition ranges.

Each HTTP request validates its origin, resolves every DNS answer, rejects the complete answer set
if any address violates policy, and connects directly to the first checked address. `localhost`
must resolve exclusively to loopback addresses. The original `Host` header, TLS server name, and
certificate verification are preserved using
[Bun's native fetch address pinning](https://bun.com/docs/runtime/networking/fetch#connecting-to-a-specific-address).
Automatic proxy environment settings are disabled for these connections so a proxy cannot resolve
the hostname independently. Redirects are rejected before another request is sent. Cancellation
applies during DNS resolution, connection, and streaming; native fetch handles compression and empty
responses. DNS lookup may finish in the background after cancellation but cannot start a request.

A trusted or compromised MCP server can still change advertised behavior, return prompt-injection
content, access anything available to its own process, or exfiltrate tool inputs. Network routes,
custom DNS infrastructure, and local administrators remain outside this transport's control. Apply
outbound network controls and follow the current
[MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices).

## HTTP boundary

The server binds to `127.0.0.1` by default. `NIGHTCODE_API_TOKEN`, when configured, protects every
route with constant-time bearer-token comparison; a token is required before binding to a
non-loopback host. Bearer authentication is not TLS.

Without a configured token, request authorities must use `localhost`, `127.0.0.1`, or `::1`;
arbitrary hostnames are rejected even if DNS resolves them to loopback. When supplied, `Origin`
must exactly match the request URL's origin, and `Sec-Fetch-Site` must be `same-origin` or `none`.
These checks cover every route, including JSON and read-only routes. Native CLI clients need
neither browser header. Remote clients require the configured bearer token. Reverse proxies must
preserve the external request origin correctly; forwarded headers are not trusted automatically.

Clients cannot select arbitrary host directories. `NIGHTCODE_SERVER_WORKSPACE_ROOTS` defines allowed
canonical roots, and a session cannot later be rebound to another workspace. Session IDs and request
schemas are bounded, request bodies are limited to 8 MiB, runtime count and idle retention are
bounded, cancellation propagates from the response stream, and active or approval-pending sessions
cannot be deleted or evicted.

## Durability boundary

Conversation messages and presentation notices are persisted in the local SQLite session database.
Saving a session and enforcing retention are one database transaction; snapshots with older timestamps
cannot replace newer history. A malformed or unreadable legacy session file surfaces an import error
without marking migration complete, allowing a retry after repair.
In-flight model/tool state, pending approvals, the resolved-approval cache, mutation queues, and undo
checkpoints are process memory only. A process restart cannot rehydrate a paused approval or undo the
previous process's checkpoint.

Atomic replacement and best-effort rollback protect ordinary failures, but Night Code has no
write-ahead crash journal or cross-process transaction. A process crash, power loss, or concurrent
external editor can still leave state that requires manual inspection.

## Deployment recommendations

- Keep the service on loopback unless authentication and TLS terminate in front of it.
- Use a dedicated OS account with least privilege.
- Mount only intended workspace roots and deny outbound network by default.
- Use a disposable container/VM for adversarial repositories or autonomous execution.
- Do not place credentials in repositories, MCP configuration, prompts, or tool output.
- Protect `~/.nightcode/nightcode.db`, which may contain source code and conversation history.
- Keep `NIGHTCODE_TELEMETRY` off unless the configured integration is understood; Night Code sets
  telemetry input/output recording to false.

## Residual risks

- Shell syntax is too expressive for perfect static classification.
- Prompt injection can influence model choices even when deterministic policy prevents some effects.
- Provider calls send selected prompts and tool data under the provider's data controls.
- External processes can race any filesystem client; hashes, serialization, and conflict-safe undo
  reduce but cannot eliminate host-level races.
- Filename-based sensitive classification, DNS checks, cancellation, and ordinary atomic writes are
  defense-in-depth controls, not substitutes for OS isolation and least privilege.
