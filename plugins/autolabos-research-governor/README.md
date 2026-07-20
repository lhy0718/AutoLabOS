# AutoLabOS Research Governor

AutoLabOS Research Governor is the Codex-facing governance plugin for AutoLabOS.
It treats Codex and external research tools as execution engines, while
AutoLabOS owns artifact intake, evidence gates, claim ceilings, downgrade
decisions, node strengthening, and paper-readiness packaging.

The plugin does not promise that a completed workflow or compiled draft is a
paper-ready result. External outputs remain untrusted evidence until AutoLabOS
gates classify them.

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

`npm run plugin:contract` prints the public artifact and intent contract.
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

## Executable Intents

The bundled bridge delegates deterministic work to the installed AutoLabOS CLI:

```sh
npm run plugin:research -- --check
npm run plugin:research -- audit --external <artifact-root> --out-dir outputs/research-governance/audit
npm run plugin:research -- review --gate outputs/research-governance/audit/gate-report.json --model-review <model-review-bundle.json>
npm run plugin:research -- improve --review outputs/research-governance/review/review-report.json
npm run plugin:research -- pack --gate outputs/research-governance/audit/gate-report.json --review outputs/research-governance/review/review-report.json
npm run plugin:research -- verify-pack --root outputs/research-governance/pack
npm run plugin:research -- verify-milestone --contract <milestone.json> --out-dir <new-milestone-audit-dir>
```

The bridge emits a blocking `GateReport` when the `autolabos` CLI is unavailable.
It never substitutes a fabricated audit result. A blocked or downgraded research
verdict is a valid governance outcome and is preserved through packaging.

## Command Intents

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

## Artifact Contract

- `ResearchBrief`
- `EvidenceBundle`
- `GateReport`
- `ReviewReport`
- `ModelReviewBundle`
- `MetaHarnessPatchPlan`
- `PaperReadinessBundle`

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
