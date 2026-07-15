# Security model

Night Code assumes model output, repository contents, tool results, MCP descriptions, and fetched content can be adversarial. It applies deterministic controls outside the prompt.

## Approval modes

- `always` — prompt for every mutation, MCP tool, and non-trivial shell action.
- `on-risk` — allow bounded read-only inspection; prompt for shell execution, external roots, deletes, undo, and MCP tools configured for approval.
- `never` — never prompt. Operations classified as high risk are denied instead of silently allowed.

MCP servers default to `requireApproval: true`. A project owner may opt a specific server out, preferably with a narrow `allowedTools` list.

## Filesystem boundary

Paths are resolved relative to the selected workspace unless absolute. The boundary resolves existing symlinks/junctions, or the nearest existing ancestor for new paths, before checking containment. Explicit additional roots are tracked separately so policy can require approval for external mutations.

Patch operations support SHA-256 preconditions. Undo verifies that every file still matches Night Code's post-patch content before restoring anything, preventing accidental overwrite of later user edits.

## Shell boundary

The shell tool provides:

- risk classification and user approval;
- a canonical, authorized working directory;
- time limits, bounded stdout/stderr, cancellation, and exit codes;
- a minimal environment with provider credentials and secret-like variables removed;
- isolated `HOME`, `TMP`, and `TEMP` directories under `.nightcode`.

The current local shell runner is **not an operating-system sandbox**. An approved general-purpose command can still use the host user's permissions. For untrusted autonomous workloads, run Night Code inside a disposable container/VM with network and filesystem policy. This is a hard deployment boundary, not something a command regex can replace.

## HTTP boundary

Clients cannot select arbitrary host directories. `NIGHTCODE_SERVER_WORKSPACE_ROOTS` defines allowed canonical roots. A session cannot later be rebound to another workspace. Runtime count and idle retention are bounded, and active/pending sessions are not evicted.

Recommended deployment controls:

- listen on loopback unless authentication and TLS terminate in front of the service;
- dedicate an OS user with least privilege;
- mount only intended workspace roots;
- deny outbound network by default;
- avoid placing credentials inside repositories or MCP tool output;
- keep `NIGHTCODE_TELEMETRY` off unless the configured integration is understood; inputs and outputs are never recorded by Night Code telemetry settings.

## Residual risks

- Shell syntax is too expressive for perfect static classification.
- A trusted MCP server can change its advertised tools between runs.
- Local session data may contain source code and should inherit user-only filesystem permissions.
- Provider calls send selected prompts and tool data under the provider's data controls.
- Concurrent external processes can race any filesystem client; hashes and undo conflict checks reduce but cannot eliminate all host-level races.
