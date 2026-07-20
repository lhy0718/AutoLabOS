# Reproducibility Expectations

Reproducibility claims must be backed by concrete artifacts.

## 1) Minimum artifact set (when applicable)

- Runtime event trace (`events.jsonl`)
- Deferred background recovery record when used (`collect_background_job.json`)
- Planned portfolio / trial-group structure (`experiment_portfolio.json`)
- Run manifest (`run_manifest.json`)
- Matrix trial-group index when managed bundle execution materializes dataset/profile slices (`trial_group_matrix.json`)
- Per-slice managed trial-group metrics when present (`trial_group_metrics/*.json`)
- Raw or summarized metrics (`metrics.json`, supplemental metrics)
- Objective evaluation (`objective_evaluation.json`)
- Result synthesis (`result_analysis.json`, optional synthesis artifact)
- Transition decision (`transition_recommendation.json`)
- Deterministic review gate and, when multi-agent or paper-scale review applies, the bound `ModelReviewBundle`
- Paper trace outputs (`paper/main.tex`, `paper/references.bib`, `paper/evidence_links.json`)

## 2) Run-state traceability

For each run, preserve:

- run id
- workflow node progression (`runs.json`) including current node/status, pending transition state, and aggregate usage when available
- optional operational sqlite index (`.autolabos/runs/runs.sqlite`) when present; treat it as a hot-path mirror of run-index metadata plus usage/checkpoint/event/artifact lookup tables rather than as the sole reproducibility artifact
- full persisted run snapshot (`.autolabos/runs/<run-id>/run_record.json`) when debugging run-state divergence or replaying control-flow decisions
- append-only runtime events (`events.jsonl`)
- key gate/recovery artifacts (`transition_recommendation.json`, `collect_background_job.json` when present)
- key generated artifacts in `.autolabos/runs/<run_id>/...`, including trial-group matrix artifacts when present

## 3) Model-review reproducibility

Model-assisted review is reproducible only when its inputs, topology, and
provenance are inspectable:

- Freeze the exact deterministic `GateReport` bytes and record their SHA-256.
- Record a closed, ordered input manifest with path, media type, source kind,
  byte count, and SHA-256 for every reviewed artifact.
- Bind each of the five required initial role outputs to the same gate and input
  hashes. Record `initial_output_shared=false`, distinct execution IDs, and one
  parallel-group ID; no initial input may contain peer output.
- Record provider, model ID and revision when available, requested and effective
  reasoning tier, executor, attempt, timestamps, prompt hash, tool/source-access
  policy, status, and output hash for every initial and meta review.
- Start the meta reviewer only after all five initial outputs are validated.
  Bind the exact five output hashes, preserve disagreements and unresolved
  positions, and keep the effective ceiling at or below the `A0` ceiling.
- Bind the exact supplied bundle bytes into
  `ReviewReport.reviewer_assurance.model_review_bundle_sha256` and require
  `can_promote=false`, `can_downgrade=true`, and `human_authority=false`.
- If the gate bytes or any input bytes change, invalidate the bundle and rerun
  the entire panel. Reusing prose against a new hash is not reproducible review.
- Keep model review (`A1`/`A2`) separate from human review (`A3`). Model output
  cannot create human attestation, final approval, external evidence, or legal
  or redistribution permission.

Candidate, reference, and license screening may be automated when the result is
explicitly model-authored and hash-bound. Citation findings must record the
directly read full-text hash and exact evidence location. License findings must
bind direct public license evidence; otherwise portability remains
`local_only` or `uncertain`. Private full text may remain outside a public
bundle, but its hash and evidence location must remain verifiable by an
authorized reviewer.

The complete `ModelReviewBundle` field and verifier contract is defined in
`docs/model-review-protocol.md`.

## 4) Reproducibility claim language

- If required artifacts are missing, do not claim reproducibility is satisfied.
- Use weaker language when evidence is partial.

## 5) Validation workspace location

Validation and test runs should not write transient state into the repository checkout.

- The default validation workspace root is the sibling `.autolabos-validation/`
  directory next to the repo root. If the repo is checked out under the user's
  home directory, this is commonly `~/.autolabos-validation/`.
- Set `AUTOLABOS_VALIDATION_WORKSPACE_ROOT` to override that root.
- `npm test` sets `TMPDIR`, `TMP`, and `TEMP` to
  `<validation-workspace>/.tmp`.
- Live fixture workspaces are created under `<validation-workspace>/.live/`.
- Real TUI/web validation workspaces should live under the validation root, with
  run artifacts in `<validation-workspace>/.autolabos/...` and public outputs in
  `<validation-workspace>/outputs/...`.

## 6) Contributor workflow

Before marking work complete:

1. Re-run the relevant flow or tests.
2. Confirm expected artifacts are present, parseable, and consistent across `runs.json`, `run_record.json` when present, optional `runs.sqlite` mirrors/indexes, `events.jsonl`, checkpoints, and other run-scoped artifacts.
3. Record limitations and unresolved uncertainty.

For long-running or resumed runs, `npm run validate:harness` also audits checkpoint/resume consistency across `runs.json`, `run_record.json`, `checkpoints/latest.json`, and numbered checkpoint records when those surfaces exist. This audit is not evidence of month-long autonomous completion; it only verifies that restart-critical state is inspectable and monotonic enough to investigate or resume safely.

## 7) Validation surfaces

- Runtime diagnostics: `/doctor` in TUI and web Doctor tab (environment + workspace harness checks).
- CI/internal gate: `npm run validate:harness` (issue log format + workspace/test run artifact structure, including event logs and portfolio/manifest contracts).
- Research governance process gate: run `npm run build` followed by `npm run validate:research-governance` to execute `research new`, weak-input `audit/review/improve/pack`, and structurally complete `audit/review/pack` as separate CLI processes. The gate invokes `research verify-pack` on both outputs and verifies honest downgrade, claim ceiling, a closed regular-file inventory, portable paths, byte counts, SHA-256 hashes, and gate/review/bundle bindings in a validation workspace outside the checkout. It also confirms that an unbound added file makes verification fail.
- Distributed bundle check: run `autolabos research verify-pack --root <paper-readiness-bundle-dir>` before transfer or review. A passing result means the packaged bytes and governance bindings are internally intact and portable; it does not upgrade the bundle's readiness class or establish missing experimental evidence.
- Plugin bridge CI gate: after the build, run `npm run validate:plugin-bridge` to execute the same acceptance scenario through the repo plugin bridge and a deterministic built-CLI proxy. This proves bridge delegation and artifact behavior without requiring Codex to be installed in CI; it does not prove that a workstation's installed plugin cache is current.
- Installed plugin acceptance: on a Codex-enabled workstation, run `npm run validate:plugin-bridge:local`. It requires local discovery and cache/repo bridge hash alignment, then executes the full acceptance scenario through the installed cache bridge. Do not add this command to generic CI.
- Plugin operations preflight: run `npm run validate:plugin-operations` in CI to aggregate direct, repo bridge, hermetic cache, and fault gates. Run `npm run validate:plugin-operations:local` on a Codex-enabled workstation to add installed bridge and discovery gates. Any required failure keeps the aggregate verdict at `fail`.

No separate end-user command is required beyond `/doctor`, but maintainers should still run `npm run validate:harness` before declaring artifact-level reproducibility complete.
