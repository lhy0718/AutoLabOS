# Plugin Production Pilot Acceptance

## Acceptance Classes

| Class | Execution surface | Evidence boundary | Required command |
| --- | --- | --- | --- |
| Direct contract | Built AutoLabOS CLI | Core research governance behavior | `npm run validate:research-governance` |
| CI bridge | Repo plugin bridge with deterministic CLI proxy | Bridge delegation without a Codex installation | `npm run validate:plugin-bridge` |
| Workstation bridge | Installed Codex plugin cache bridge | Local discovery, cache alignment, and bridge execution | `npm run validate:plugin-bridge:local` |
| Hermetic cache | Temporary isolated Codex home | Cache sync and doctor behavior independent of workstation state | Pending |
| Operations preflight | Bounded aggregate of required gates | Production-pilot go/no-go summary | Pending |

No acceptance class substitutes for another. A deterministic CI pass does not prove that a workstation cache is current, and an installed-cache pass does not replace repeatable CI coverage.

## Evidence Matrix

| Gate | Current evidence | Production-pilot requirement | Status |
| --- | --- | --- | --- |
| Research artifact chain | Nine-process direct acceptance | Preserve downgrade, claim ceiling, schema block, and bundle hashes | Passing |
| Repo bridge delegation | Nine-process deterministic bridge acceptance | Keep Codex-independent and required in CI | Passing |
| Installed bridge delegation | Discovery, bridge hash, dependency check, nine-process chain | Keep workstation-only and versioned | Passing |
| Machine-readable report retention | Optional atomic JSON reports for direct, fixture, and installed surfaces | Preserve portable metadata and reject private paths | Passing |
| Missing CLI | Unit-level blocking `GateReport` | Fault matrix entry with repair target | Partial |
| CLI contract mismatch | Unit-level blocking `GateReport` | Fault matrix entry with distinct artifact identity | Partial |
| Missing cache | Strict doctor test | Fault matrix entry with deterministic repair target | Partial |
| Stale cache version | Doctor verdict logic | Fault matrix entry proving stale-version rejection | Partial |
| Bridge drift | Comparable-file hashing | Fault matrix entry proving bridge-specific rejection | Partial |
| Schema mismatch | Direct and bridge acceptance | Preserve concise blocking output | Passing |
| Non-portable bundle content | Pack-time exclusion logic | Fault matrix entry proving exclusion and downgraded portability | Partial |
| Hermetic cache lifecycle | Isolated sync and doctor unit tests | Integrated sync, strict doctor, bridge dependency, and cleanup | Gap |
| Aggregate operating verdict | Independent commands | One bounded summary that cannot hide a failed required gate | Gap |

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
| Fault matrix | Seven named failure classes produce deterministic blocking evidence | Open |
| Hermetic cache | Isolated cache lifecycle passes without workstation cache reuse | Open |
| Operations preflight | Required gates aggregate into one machine-readable verdict | Open |
| Contract synchronization | CI, dogfood, release, docs, and skill agree on the gates | Open |
| Final validation | Full repository and global gates pass with a clean worktree | Open |
