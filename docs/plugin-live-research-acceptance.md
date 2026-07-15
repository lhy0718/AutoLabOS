# Plugin-Operated Live Research Acceptance

## Scope

This acceptance track verifies that the installed AutoLabOS plugin can govern a real research run without replacing node-owned execution or promoting partial evidence.

## Evidence Classes

| Class | Required evidence | Non-substitution rule | State |
| --- | --- | --- | --- |
| Installed skill | Discovery, enablement, version, source, and cache alignment | A repository fixture does not prove current-thread skill loading | Passing |
| Plugin audit | `research:audit` over a real run artifact root | Deterministic contract checks do not replace artifact inspection | Passing |
| Plugin review | Claim ceiling, downgrade class, and upstream repair target | A completed workflow or PDF does not imply paper readiness | Passing |
| Plugin improve | Node-local `MetaHarnessPatchPlan` tied to observed gate failures | External edits must not replace node-owned artifacts | Passing |
| Plugin pack | Portable bundle with provenance and limitation records | Private paths, credentials, and run-specific public identifiers must remain excluded | Passing |
| Same-flow execution | Persisted run/node/artifact state after a real retry | Unit tests and generated fixtures are secondary evidence | Passing |
| Scientific gates | Analysis, figure audit, and review consume executed evidence | Weak evidence must backtrack or downgrade | Passing |

## Live-Run Exit Conditions

- Every planned condition and repeated run is either completed with inspectable evidence or explicitly failed with a governed reason.
- Task-specific evaluation coverage preserves the approved task, split, and minimum-count contract.
- Runtime memory cleanup is verified from a later condition boundary, not inferred from one early success.
- Run-scoped metrics, verifier reports, public summaries, and persisted node state agree.
- `analyze_results`, `figure_audit`, and `review` preserve the strongest defensible evidence ceiling.
- A blocking review decision cannot advance to `write_paper` as if the research were paper-ready.

## Repair Rules

- Record a reproduced live defect before changing source.
- Keep public source and tests domain-neutral.
- Repair the smallest parser, validator, node, or runtime boundary that explains the defect.
- Rebuild and rerun the same live node after each source repair.
- Never hand-edit generated metrics, result tables, or experiment outputs to manufacture success.

## Accepted Governance Outcome

- Real execution artifacts reached `analyze_results`, `figure_audit`, and `review` through the repository-owned retry flow.
- Review detected absent repeated-run evidence, incomplete approved execution coverage, and a training-budget mismatch.
- The persisted decision remained `blocked_for_paper_scale`, applied a claim ceiling, and prevented `write_paper` promotion.
- Installed `research:audit`, `research:review`, and `research:improve` preserved the figure gate plus upstream repair targets for execution, implementation, hypothesis, and design nodes.
- Installed `research:pack` emitted a non-paper-ready bundle with provenance, limitations, hashes, and a list of redacted public copies.
- Independent scans found no machine-local path, credential assignment, run UUID, or concrete model/task/condition identifier in the public bundle; audit event IDs and contract paths remained intact.

This is acceptance of the governance behavior, not acceptance of the underlying research as paper-ready.

## Completion Ledger

| Milestone | Exit condition | State |
| --- | --- | --- |
| Current-state audit | Installed plugin and persisted live-run authority inspected | Closed |
| Task-specific evaluation contract | Declared task coverage is measured and any plan shortfall remains visible | Closed with governed evidence shortfall |
| Dependency routing | Data/model blockers produce structured upstream repair transitions | Not exercised by the final acceptance pass |
| Same-flow execution | Latest live blocker is cleared or honestly governed | Closed with blocked research outcome |
| Plugin governance intents | Audit, review, improve, and pack operate on the live bundle | Closed |
| Scientific gate traversal | Analysis, figure audit, and review consume current evidence | Closed with backtrack decision |
| Final validation | Repository, plugin, and global gates pass before reviewable commits are created | Closed |

## Validation Evidence

- `npm run build`: pass.
- `npm test`: 195 test files and 2694 tests pass.
- `npm run test:web`: 14 tests pass.
- `npm run validate:harness`: all issue entries pass structural validation.
- `npm run test:smoke:all`: every natural, composite, run-all, and replan PTY scenario passes.
- `npm run validate:plugin-operations:local`: all six direct, bridge, hermetic, fault, installed-cache, and discovery gates pass.
- `npm run plugin:release-check`: contract, dogfood, strict doctor, packaging, portability, and public-surface checks pass.
- `npm run plugin:research -- --check`: installed CLI dependency and version check pass.
- `~/.codex/bin/codex-global-preflight`: all four global gates pass.
