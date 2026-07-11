# Plugin Production Pilot Acceptance

## Acceptance Classes

| Class | Execution surface | Evidence boundary | Required command |
| --- | --- | --- | --- |
| Direct contract | Built AutoLabOS CLI | Core research governance behavior | `npm run validate:research-governance` |
| CI bridge | Repo plugin bridge with deterministic CLI proxy | Bridge delegation without a Codex installation | `npm run validate:plugin-bridge` |
| Workstation bridge | Installed Codex plugin cache bridge | Local discovery, cache alignment, and bridge execution | `npm run validate:plugin-bridge:local` |
| Hermetic cache | Temporary isolated Codex home | Cache sync, strict doctor, bridge hash, dependency, and research chain | `npm run validate:plugin-hermetic` |
| Operations preflight | Bounded aggregate of required gates | Production-pilot go/no-go summary | Pending |

No acceptance class substitutes for another. A deterministic CI pass does not prove that a workstation cache is current, and an installed-cache pass does not replace repeatable CI coverage.

## Evidence Matrix

| Gate | Current evidence | Production-pilot requirement | Status |
| --- | --- | --- | --- |
| Research artifact chain | Nine-process direct acceptance | Preserve downgrade, claim ceiling, schema block, and bundle hashes | Passing |
| Repo bridge delegation | Nine-process deterministic bridge acceptance | Keep Codex-independent and required in CI | Passing |
| Installed bridge delegation | Discovery, bridge hash, dependency check, nine-process chain | Keep workstation-only and versioned | Passing |
| Machine-readable report retention | Optional atomic JSON reports for direct, fixture, and installed surfaces | Preserve portable metadata and reject private paths | Passing |
| Missing CLI | Blocking fault-matrix `GateReport` with repair target | Preserve deterministic dependency rejection | Passing |
| CLI contract mismatch | Distinct blocking fault-matrix artifact identity | Preserve incompatible-contract rejection | Passing |
| Missing cache | Strict doctor fault-matrix rejection | Preserve `not_installed` verdict and repair target | Passing |
| Stale cache version | Strict fault-matrix version rejection | Preserve `cache_update_required` verdict | Passing |
| Bridge drift | Cached bridge hash mutation and strict rejection | Preserve bridge-specific drift evidence | Passing |
| Schema mismatch | Direct and bridge acceptance | Preserve concise blocking output | Passing |
| Non-portable bundle content | Quoted-path fault injection, exclusion, and portability downgrade | Preserve exclusion and `portable=false` | Passing |
| Hermetic cache lifecycle | Integrated isolated sync, strict doctor, bridge hash, dependency, chain, and cleanup | Preserve workstation-independent cache proof | Passing |
| Aggregate operating verdict | Independent commands | One bounded summary that cannot hide a failed required gate | Gap |

## Hermetic Cache Acceptance

Run the isolated cache lifecycle after a current build:

```sh
npm run validate:plugin-hermetic
npm run validate:plugin-hermetic -- --report <path>
```

The command creates a temporary Codex home, syncs the repo plugin into that cache, runs strict doctor and bridge hash checks, executes the bridge dependency check and shared research acceptance, then removes the isolated cache root. It does not read the workstation plugin cache.

## Fault-Injection Matrix

Run the seven-case matrix after a current build:

```sh
npm run validate:plugin-faults
npm run validate:plugin-faults -- --report <path>
```

The matrix passes only when each injected fault is blocked or excluded as specified. Every case records an expected behavior, observed verdict, and repair target. A successfully injected but unblocked fault fails the matrix.

## Report Retention

Each acceptance command accepts an optional report path:

```sh
npm run validate:research-governance -- --report <path>
npm run validate:plugin-bridge -- --report <path>
npm run validate:plugin-bridge:local -- --report <path>
```

Reports are written through a same-directory temporary file and atomic rename. Serialized content is rejected when it contains a machine-specific absolute path or credential-like assignment. An output outside the invocation directory is represented as `<external-report-root>/<filename>`.

## Promotion Rules

- `pilot_ready` requires every required local or CI-capable gate to pass in the current run.
- `blocked` is mandatory when any required gate fails, cannot execute, or returns malformed output.
- `partial` may describe completed optional gates but cannot be promoted to `pilot_ready`.
- Workstation-only checks must remain absent from generic CI.
- Reports must not contain machine-specific absolute paths, credentials, or one-off experiment identifiers.
- Validation workspaces and reports must remain outside the repository checkout unless an explicit output path is supplied.

## Completion Ledger

| Milestone | Exit condition | State |
| --- | --- | --- |
| Report retention | Direct and bridge runners support validated optional report output | Closed |
| Fault matrix | Seven named failure classes produce deterministic blocking evidence | Closed |
| Hermetic cache | Isolated cache lifecycle passes without workstation cache reuse | Closed |
| Operations preflight | Required gates aggregate into one machine-readable verdict | Open |
| Contract synchronization | CI, dogfood, release, docs, and skill agree on the gates | Open |
| Final validation | Full repository and global gates pass with a clean worktree | Open |
