# Dependency review — October 20, 2026

## Current refresh

All workspace dependencies were checked against npm release tags on October 20, 2026.
Only AI SDK and its MCP adapter have newer stable releases than the October 15 baseline.
Bun's [official release notes](https://bun.com/blog/bun-v1.4.3) still identify 1.4.3 as the
current runtime; the installed runtime, minimum, package-manager pin, types, and CI agree.

| Dependency | October 15 baseline | Selected October 20 |
| --- | --- | --- |
| `ai` (server and shared) | 7.0.141 | 7.0.146 |
| `@ai-sdk/mcp` | 2.0.76 | 2.0.80 |
| `@ai-sdk/provider` (transitive) | 4.0.27 | 4.0.31 |
| `@ai-sdk/provider-utils` (transitive) | 5.0.60 | 5.0.64 |
| `@ai-sdk/gateway` (transitive) | 4.0.114 | 4.0.119 |
| `undici` (transitive) | 7.30.0 | 7.30.1 |
| `undici-types` (transitive) | 8.9.0 | 8.12.3 |
| CI `actions/upload-artifact` | 7.0.1 | 7.0.2 |

The [AI SDK changelog](https://github.com/vercel/ai/blob/main/packages/ai/CHANGELOG.md)
documents improved OpenAI custom-tool input streaming and an experimental low-memory stream
entry point. The [MCP changelog](https://github.com/vercel/ai/blob/main/packages/mcp/CHANGELOG.md)
records provider dependency alignment. Registry metadata and the installed lockfile confirm the
selected release versions. The harness retains its standard stream-consumption behavior.
The SDK and MCP adapter resolve to a single matching provider and provider-utils pair.

The CI artifact action is pinned to the full commit for
[v7.0.2](https://github.com/actions/upload-artifact/releases/tag/v7.0.2), which improves retry
handling for rate-limited artifact downloads. Checkout 7.0.1 and setup-bun 2.2.0 were already
at their current stable releases. Existing SHA pins remain in use.

Drizzle stays on the matching `rc` release 1.0.0-rc.4. The registry's `latest` tags are still
older 0.x releases, and the separate `rc5` tag remains a commit-suffixed development build.
The [v1 upgrade documentation](https://orm.drizzle.team/docs/upgrade-v1) confirms the migration
folder and relations changes already used by this repository. A channel switch or downgrade
would require a separate database migration review.

Final October 20 validation passed a frozen install, the full verification gate, 261 tests, and
783 randomized test executions. The registry reported no outdated direct dependencies and no
vulnerabilities across 118 audited packages. Full results are in [evaluation](evaluation.md).
The final workspace uses Windows x64 / Bun 1.4.3.

Network registry checks and fixture tests used host permissions after sandbox DNS resolution
failed. These checks are local; they do not establish Linux CI results, provider-account access,
or live model quality. The whole-repository verification recorded below belongs to the October 15
baseline; the evaluation document records the current verification separately.

## October 15 baseline upgrade

Versions were checked against npm release tags and official package documentation on October 15,
2026. The installed runtime was already Bun 1.4.3 (`c6da4a4d3`); the project minimum,
`packageManager`, Bun types, and Windows/Linux CI now agree on 1.4.3.

## Versions

| Dependency | Before | Selected |
| --- | --- | --- |
| Bun project minimum / CI | 1.4.2 | 1.4.3 |
| `@types/bun` | 1.4.2 | 1.4.3 |
| `@opentui/core`, `@opentui/react` | 0.5.14 | 0.6.6 |
| `react` | 19.3.0 | 19.3.1 |
| `@types/react` | 19.3.0 | 19.3.0 (current latest) |
| `ai` | 7.0.130 | 7.0.141 |
| `@ai-sdk/mcp` | 2.0.69 | 2.0.76 |
| `zod` | 4.6.5 | 4.6.7 |
| `dotenv` | 18.0.6 | 18.0.8 |
| `hono`, `@hono/zod-validator` | 4.13.13 / 0.9.1 | unchanged (current latest) |
| `@biomejs/biome` | 2.5.15 | 2.5.15 (current latest) |
| `typescript` | 7.0.2 | 7.0.2 (current latest) |
| `drizzle-orm`, `drizzle-kit` | 1.0.0-rc.4 | unchanged (current `rc` tag) |

`bun update --recursive --latest` updated all workspace manifests and refreshed transitive
dependencies. Exact pins and caret-range styles are preserved. Shared AI SDK and Zod versions
remain aligned across packages, and OpenTUI Core and React are pinned together.

Drizzle's npm `latest` tags remain on ORM 0.45.4 and Kit 0.31.11. This repository already uses
v1 relations and v3 migration folders, so downgrading would be incompatible. Both packages remain
on the matching `rc` release, 1.0.0-rc.4. The separate `rc5` tag points to a commit-suffixed build;
this upgrade does not opt into that development channel. No database schema or migrations changed.

## Bun integration

The [Bun 1.4.3 release notes](https://bun.com/blog/bun-v1.4.3) introduce a built-in TypeScript
checker and checks before bundling. Workspace scripts now use `bun check --project tsconfig.json`,
and every production build enables the new check (`--check` or `Bun.build({ check: true })`).
These additions keep direct build commands from silently bundling type errors.

The [type-checking documentation](https://bun.com/docs/runtime/check) explains that a package's
`check` script takes precedence over the checker. The root already uses that name for formatting,
linting, and type checking, so its scripts-only type check uses
`bun --check --tsconfig-override scripts/tsconfig.json`. Workspace checks still use each package's
own configuration. TypeScript 7.0.2 remains installed for editors, matching Bun's checker.

Workspace discovery is now simply `packages/*`. Redundant exclusions for deeper `test` and
`template` folders caused workspace script commands to fail with `error: Unexpected` on this
Windows/Bun installation; those folders were never selected by the one-level workspace glob.

The [update command documentation](https://bun.com/docs/pm/cli/update) documents recursive
workspace updates, preserving version-range styles, and retaining prereleases ahead of `latest`.
The refreshed lockfile passes `bun ci` without changes.

## Package compatibility

The [OpenTUI 0.6 migration notes](https://opentui.com/docs/releases/0.6.0/) require waiting for
`renderer.closed` after `destroy()`. Normal shutdown and UI smoke shutdown now wait before exiting.
Normal shutdown also reports restoration errors with a failing exit status and still restores the
terminal after a session-save failure. Three subprocess regression tests cover those behaviors.
The application uses standard built-in React renderables rather than the removed custom paint,
raw-pointer, or Yoga-node APIs.

The [0.6.6 release](https://github.com/anomalyco/opentui/releases/tag/v0.6.6) also resets omitted
layout props to their constructor defaults. The UI smoke test exercises the new native renderer.
The JavaScript bundle exposed a relative native-library path passed directly to `dlopen`.
Its build now wraps the selected native-package import and resolves the emitted asset against
`import.meta.url`, so the bundle starts from a working directory outside `dist`. This preserves
the emitted native asset and leaves executable embedding unchanged. The
[deployment guidance](https://opentui.com/docs/ship/deploy/) describes shipping all bundle assets;
the new `test:cli:bundle` smoke check also runs in CI after the build.
React 19.3.1 satisfies OpenTUI's `react >=19.2.0` peer range; the
[React version reference](https://react.dev/versions) is the upstream release reference.

The [AI SDK introduction](https://ai-sdk.dev/docs/introduction) and
[MCP tools documentation](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools) were reviewed alongside
the published package metadata. AI SDK and MCP share provider 4.0.27 and provider-utils 5.0.60 in
the refreshed lockfile. Their Zod peer ranges accept the selected Zod 4.6.7. Existing mock-model,
tool-loop, routing, streaming, cancellation, and MCP cleanup tests pass without API changes.

The [Zod 4 release notes](https://zod.dev/v4),
[Hono Bun guide](https://hono.dev/docs/getting-started/bun), and
[Hono validation guide](https://hono.dev/docs/guides/validation) cover the existing schema and
HTTP integration. Hono's validator accepts Zod 4 and Hono >=4.11.2; no adapter migration is needed.

The [dotenv documentation](https://github.com/motdotla/dotenv#readme) covers explicit paths,
parent-environment precedence, and quiet loading. Trusted environment regression tests continue
to pass with 18.0.8. [Biome's upgrade guidance](https://biomejs.dev/installation/upgrade-to-biome-v2/)
and [Drizzle's release reference](https://orm.drizzle.team/docs/latest-releases) were also checked;
their selected versions require no additional configuration changes.

## Verification

Validated locally on Windows x64 with Bun 1.4.3:

- `bun ci`: lockfile accepted, no changes.
- `bun run verify`: formatting, lint, all workspace and script type checks, migration validation,
  187 tests, coverage floors, and all production bundles passed.
- Weighted source coverage: 78.91% lines and 68.80% functions (floors: 65% and 55%).
- `bun run test:stress`: 561 passes, zero failures; randomized seed 1846548198.
- `bun run test:cli:smoke`: native terminal UI started and shut down successfully.
- `bun run test:cli:bundle`: built JavaScript UI started from the project root, loaded its emitted
  native library, and shut down successfully.
- `bun run build:cli:compile` and `bun run build:cli:bytecode`: both standalone builds succeeded.
- `bun audit`: no vulnerabilities found across 118 checked packages.
- `bun outdated --recursive`: no outdated dependencies reported.

The Windows sandbox blocks filesystem canonicalization and loopback connections needed by some
tests; the full verification and repeat suite passed when run with host permissions. Linux remains
in the existing CI matrix and was not run locally. Windows Application Control blocked launching
the newly compiled executable even with host permissions, so standalone runtime smoke testing
could not be completed. Live model/Gateway requests were not part of this upgrade check.
