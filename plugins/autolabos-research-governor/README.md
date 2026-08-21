# AutoLabOS Research Governor

AutoLabOS Research Governor is the Codex-facing governance plugin for AutoLabOS.
It treats Codex and external research tools as execution engines, while
AutoLabOS owns artifact intake, evidence gates, claim ceilings, downgrade
decisions, node strengthening, and paper-readiness packaging.

The plugin does not promise that a completed workflow or compiled draft is a
paper-ready result. External outputs remain untrusted evidence until AutoLabOS
gates classify them.

## Installation

From a clean checkout, run these commands at the repository root:

```sh
codex plugin marketplace add .
codex plugin add autolabos-research-governor@autolabos-local
codex plugin list
```

The first command registers this repository's local marketplace. The second
installs and enables the plugin from that marketplace. The final command should
show the plugin as installed and enabled. Run the install command again after a
plugin version or cachebuster change, then start a new Codex thread so the
updated skill is loaded.

## First Run

Run these commands from the repository root when installing, changing, or
auditing the plugin:

```sh
npm run plugin:contract
npm run plugin:dogfood
npm run plugin:doctor
npm run plugin:doctor -- --strict
npm run plugin:discovery-check
npm run validate:plugin-bridge
npm run validate:plugin-bridge:local
npm run validate:plugin-faults
npm run validate:plugin-hermetic
npm run validate:plugin-operations
npm run validate:plugin-operations:local
npm run plugin:sync-cache
npm run plugin:release-check
```

`npm run plugin:contract` prints the public artifact contract and separates
executable CLI intents from workflow-native intents.
`npm run plugin:dogfood` checks the plugin manifest, skill, marketplace entry,
README, helper scripts, and package wiring as an untrusted artifact bundle.
`npm run plugin:doctor` reports whether the installed Codex plugin cache is
aligned with the repo-local plugin contract. Use
`npm run plugin:doctor -- --strict` in CI or release checks when cache drift
should fail the command instead of only appearing in the JSON verdict.
`npm run plugin:discovery-check` verifies that local Codex lists the plugin as installed and enabled at the manifest version, resolves it to this repository, and passes the strict cache/skill cross-check. It requires a local Codex installation and is not a substitute for CI's structural contract tests.
`npm run validate:plugin-bridge` runs a deterministic CI-safe research chain through the repo plugin bridge. `npm run validate:plugin-bridge:local` first verifies discovery and cache alignment, then runs the same chain through the installed cache bridge; it is the workstation acceptance gate.
`npm run validate:plugin-faults` injects seven required failure classes. `npm run validate:plugin-hermetic` proves the cache lifecycle in an isolated Codex home. `npm run validate:plugin-operations` aggregates required CI gates without promoting partial success; add `:local` for installed bridge and discovery gates. All acceptance commands accept `-- --report <path>` for an atomic portable JSON report.
`npm run plugin:sync-cache` performs a dry run for copying the repo-local plugin
into the installed Codex cache; add `-- --write` only when intentionally
refreshing the local Codex installation. `npm run plugin:release-check` bundles
contract, dogfood, strict doctor, pack, and public-surface hygiene checks.

After changing plugin files, reinstall the plugin or restart the Codex thread so
cached skill text cannot drift from the repo-local contract.

## Executable CLI Intents

The bundled bridge delegates deterministic work to the installed AutoLabOS CLI:

```sh
npm run plugin:research -- --check
npm run plugin:research -- audit --external <artifact-root> --support-root <repository-root> --support-manifest <support-manifest.json> --out-dir outputs/research-governance/audit
npm run plugin:research -- review --gate outputs/research-governance/audit/gate-report.json --model-review <model-review-bundle.json>
npm run plugin:research -- improve --review outputs/research-governance/review/review-report.json
npm run plugin:research -- pack --gate outputs/research-governance/audit/gate-report.json --review outputs/research-governance/review/review-report.json
npm run plugin:research -- verify-pack --root outputs/research-governance/pack
npm run plugin:research -- verify-milestone --contract <milestone.json> --out-dir <new-milestone-audit-dir>
```

When claims cite files outside `<artifact-root>`, the audit command requires an explicit support manifest with schema version `1.0` and entries containing a portable relative `path`, lowercase SHA-256, and byte count. AutoLabOS copies only those exact bytes into the closed intake inventory; path escape, symlinks, collisions, missing files, and hash or size drift fail closed. Omit both support flags when the artifact bundle is already self-contained.

The bridge emits a blocking `PluginDependencyReport`, not a research `GateReport`, when the `autolabos` CLI is unavailable.
It never substitutes a fabricated audit result. A blocked or downgraded research
verdict is a valid governance outcome and is preserved through packaging.

## Workflow-Native Topic Discovery

`research:discover` is a workflow-native intent, not a CLI-backed command. It
starts from a complete discovery-scoped `ResearchBrief` whose `Research Mode`
is `topic_discovery`, then runs inside the first four nodes of the existing
10-node reference workflow:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments`

- The brief declares broad search scope, resource limits, evidence floor, and
  disallowed shortcuts. It does not require the user to preselect the final
  topic, primary metric, metric direction, meaningful-effect boundary,
  comparator, or dataset/task.
- Brief-level metric, comparison, and dataset/task entries are candidate
  selection rules or admissibility boundaries, not a final experiment contract.
- `collect_papers` gathers literature within those declared boundaries.
- `analyze_papers` emits `ResearchGapMap`, an evidence-linked literature gap
  map whose entries retain their epistemic status.
- `generate_hypotheses` emits `TopicPortfolio` with 5-7 candidates spanning at
  least 3 distinct nonempty evidence-axis clusters.
- Every candidate owns `primary_metric`, explicit `metric_unit` and
  `metric_scale`, `metric_direction`, structured `effect_criterion`, comparator, dataset/task,
  falsifier, kill signal, and local budget, plus closest-prior non-overlap, the
  strongest-baseline absorption objection, and minimum publishable evidence.
  Optional `meaningful_effect` prose may explain the boundary but cannot replace
  the machine-readable criterion.
- `design_experiments` validates the portfolio, emits `TopicProbeDecision`,
  and selects exactly one candidate into `active_topic_probe_contract.json`.
  The resulting `ActiveTopicProbeContract` binds the validated portfolio and
  active candidate by SHA-256. Every other authorized candidate remains
  explicitly `deferred`.
- The active candidate's measurement contract is then frozen into
  `ResultsPlanV2.primary_comparison_id` and
  `ResultsPlanV2.primary_effect_criterion`. The latter binds the same
  comparison to the raw metric, unit/scale semantics, direction, and
  inclusive/exclusive threshold; a favorable but sub-threshold delta is not a
  successful probe.

Closed-chain probe authorization allows only a `bounded_probe` to enter the
existing downstream workflow. Its outputs are screening evidence, not paper
claim evidence. It is not topic selection, research completion, or paper
readiness. A blocked authorization backtracks to
`generate_hypotheses`; it does not add a top-level node. Do not invoke
`research:discover` through `run-research-intent.mjs` or expose an
`autolabos research discover` command.

## Executable CLI Intent Contract

- `research:new`: create or repair a governed research brief.
- `research:audit`: audit a run or external artifact bundle as untrusted evidence.
- `research:review`: run deterministic gates and bound model review for paper readiness, claim ceilings, downgrade class, and repair targets.
- `research:improve`: map gate or review failures to node-local strengthening.
- `research:pack`: export a traceable paper-readiness bundle.

`research verify-pack` is the verification mode of `research:pack`. It
independently rechecks the closed file inventory, regular-file boundary,
portable paths, byte counts, SHA-256 bindings, and gate/review/bundle linkage.

`research verify-milestone` is a cross-intent verification mode for a
long-running objective. It rechecks declared artifact hashes and JSON
assertions, groups unmet requirements by their owning workflow node, and exits
nonzero until every required item passes.

## Governance Artifact Contract

- `ResearchBrief`
- `EvidenceBundle`
- `GateReport`
- `ReviewReport`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

## Workflow Artifact Contract

- `ResearchGapMap`: evidence-linked literature gaps emitted inside
  `analyze_papers`, with explicit support and epistemic status.
- `TopicPortfolio`: the bounded 5-7 candidate, 3-or-more-cluster portfolio
  emitted inside `generate_hypotheses`, including each candidate's prior-work,
  baseline-objection, measurement, comparator, dataset/task, budget, falsifier,
  kill-signal, and evidence-floor contract.
- `TopicProbeDecision`: the `design_experiments` decision bound to the
  validated portfolio. Its maximum authority is closed-chain probe
  authorization, never final topic selection or paper readiness.
- `ActiveTopicProbeContract`: the `active_topic_probe_contract.json` handoff
  that binds exactly one active candidate and its portfolio by SHA-256, records
  all remaining authorized candidates as `deferred`, and marks execution as a
  `bounded_probe` whose output is not paper claim evidence.

## Sidecar And Operational Artifacts

- `ModelReviewBundle` is the exact-gate-bound model-review sidecar.
- `PluginDependencyReport` records operational dependency failures. It is not
  a research artifact and cannot stand in for a `GateReport`.

## Model Review Authority

AutoLabOS separates four authority tiers:

- `A0 deterministic`: schema, hash, inventory, evidence-floor, blocker, and
  maximum claim/readiness-ceiling decisions.
- `A1 model advisory`: specialist critique, screening, uncertainty, and repair
  recommendations that cannot mutate a deterministic gate.
- `A2 model conservative`: model reconciliation that may add blockers or lower
  readiness within the deterministic ceiling, but cannot clear an `A0` blocker, change the deterministic
  ceiling, create external evidence, create human attestation, or create legal
  or redistribution permission.
- `A3 human authority`: separately recorded human review, final approval,
  attestation, or an authorized legal/redistribution decision.

When a user requests multi-agent review, or when `research:review` evaluates a
paper-scale target, the plugin uses the strongest available frontier model and
highest available reasoning tier under the active runtime policy. It launches
five independent initial roles in parallel: claim/evidence, methodology,
statistics, reproducibility, and adversarial review. Initial outputs are not
shared among reviewers. Each output binds the exact `GateReport` hash and
records model, provider, reasoning, and execution provenance.

The shared closed inventory contains the exact `GateReport`, exact
`EvidenceBundle`, and every required `GateReport.input_bindings` path.
Changing or omitting any of those bytes invalidates the panel.

A separate meta reviewer runs only after all five outputs are normalized,
hash-bound, and structurally validated. It reconciles the panel without deleting disagreements and emits a
`ModelReviewBundle` with at most `A2` authority. Incomplete or unbound panels
remain non-promoting `A1` advice. Model review is a separate artifact and is
never represented as human review. Never generate the human review or final
approval.

Every specialist record remains in `ModelReviewBundle`, but only findings
adopted by the meta reviewer enter `ReviewReport`, readiness, and repair
targets. This preserves the independent record without multiplying duplicate
findings. Fresh audits bind available input files by portable path, SHA-256,
and byte length; changed input bytes require a new gate and complete panel.
Meta-harness repair targets may use the controlled surfaces `prompt`, `skill`,
`validator`, `policy`, and `runtime`.

The resulting `ReviewReport.reviewer_assurance` binds the exact bundle hash and
records the adjudication policy and raw/adjudicated finding counts while
keeping `can_promote=false`, `can_downgrade=true`, and `human_authority=false`.

Candidate, reference, and license material may receive clearly labeled model
screening or adjudication. Citation support requires direct full-text reading,
a bound full-text hash, and a precise evidence location. Redistribution remains
`local_only` or `uncertain` unless direct public license evidence is bound; a
model cannot create permission. The complete field and verification contract
is in `docs/model-review-protocol.md`.

## Governance Boundary

The standalone AutoLabOS TUI and web app remain the reference workflow,
compatibility shell, and live-validation environment. The public product
boundary is plugin-first: other agents may execute work, but AutoLabOS gates
the resulting artifacts before any paper-readiness claim is allowed.

Keep plugin examples and fixtures domain-neutral. Concrete model names,
benchmarks, datasets, condition markers, run ids, and private local paths belong
in run artifacts or user-provided inputs, not in reusable plugin code or docs.

See `docs/codex-plugin-governance.md` for the full direction and adapter
strategy.
