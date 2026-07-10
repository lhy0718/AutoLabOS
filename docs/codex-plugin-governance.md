# Codex Plugin Governance Direction

AutoLabOS should present itself publicly as a Codex-native research governance layer, not as another monolithic fully automated scientist.

## Landscape Basis

The `worldbench/awesome-ai-auto-research` landscape groups current systems into idea generation, novelty assessment, literature retrieval, survey generation, deep research agents, code and experiment execution, reproducibility assessment, writing/review/rebuttal, paper-to-media conversion, fully automated research systems, and evolutionary self-improvement.

That landscape is crowded at the execution layer. AutoLabOS should therefore specialize in the layer that stays valuable across those systems: artifact intake, evidence gates, claim ceilings, review discipline, reproducibility checks, and node-level self-improvement.

Source: https://github.com/worldbench/awesome-ai-auto-research

## Public Role

Primary surface: Codex plugin.

AutoLabOS role: governed research harness.

Execution role: Codex or an external agent may run code, search, write, or execute experiments.

Standalone role: the existing TUI/web workflow remains a reference implementation, compatibility shell, and live-validation path.

Public contract: artifact and gate schema, not a fixed promise that every run becomes a paper.

## Plugin Intents

- `research:new`: create or repair a governed research brief.
- `research:audit`: audit a run or external artifact bundle as untrusted evidence.
- `research:review`: review paper readiness, claim ceilings, downgrade class, and upstream repair targets.
- `research:improve`: map failures to node-local prompt, skill, or validator strengthening.
- `research:pack`: export a traceable paper-readiness bundle.

## Artifact Contract

- `ResearchBrief`: execution contract with baseline, evidence floor, disallowed shortcuts, and failure conditions.
- `EvidenceBundle`: collected literature, run outputs, metrics, logs, drafts, and provenance imported as evidence candidates.
- `GateReport`: deterministic and structured findings about traceability, missing evidence, and done-condition drift.
- `ReviewReport`: claim-evidence alignment, readiness class, downgrade decision, and repair target.
- `MetaHarnessPatchPlan`: smallest safe node, prompt, skill, or validator strengthening plan with rollback expectations.
- `PaperReadinessBundle`: portable public bundle with provenance, claim evidence, downgrade decisions, and limitations.

## Adapter Strategy

External systems should be adapters, not dependencies. Literature tools, deep research agents, experiment runners, reproducibility benchmarks, review agents, and fully automated research systems may provide artifacts, but those artifacts remain untrusted until AutoLabOS gates classify them.

Adapter categories:

- literature retrieval and survey synthesis
- deep research report generation
- experiment execution and orchestration
- code reproduction and benchmark assessment
- paper review and rebuttal assistance
- fully automated research-system output import

No adapter may skip baseline requirements, claim-evidence mapping, reproducibility checks, or paper-readiness review.

## Executable Adapter

The plugin ships a thin bridge for `autolabos research
<new|audit|review|improve|pack>`. The bridge checks that the AutoLabOS CLI is
available, delegates execution without a shell, and emits a blocking
`GateReport` when the dependency is missing. The CLI owns deterministic
artifact validation and reuse of the existing brief, audit, review, and
meta-harness logic.

All normalized artifacts use schema version `1.0`. Paths in public artifacts
are workspace-relative or placeholder-based, and `research:improve` defaults
to `plan_only`.

## Self-Dogfood Loop

The plugin must be able to inspect its own public contract as an untrusted artifact bundle. Maintainers should run `npm run plugin:dogfood` after changing the plugin manifest, skill text, marketplace entry, governance contract, or plugin helper scripts.

Maintainers should also run `npm run plugin:doctor` when checking whether the installed Codex plugin cache matches the repo-local plugin contract. The default doctor report is diagnostic; `npm run plugin:doctor -- --strict` should be used for CI or release checks that must fail on cache drift. On a workstation with Codex installed, `npm run plugin:discovery-check` additionally verifies that `codex plugin list` reports the plugin as installed and enabled at the manifest version and repository source before applying the strict cache and skill checks. `npm run plugin:sync-cache` is dry-run by default and should be run with `-- --write` only when intentionally refreshing a local Codex installation. `npm run plugin:release-check` bundles contract, dogfood, strict doctor, pack, and public-surface hygiene checks for release readiness. Cache drift means the plugin should be reinstalled or the Codex thread restarted before relying on installed skill behavior.

The dogfood report is a `research:improve` surface: failed checks map to the smallest plugin-local repair target and must not be treated as broad workflow redesign requests. A passing report proves only that the plugin contract is internally coherent; it does not prove paper-readiness or research completion.

## Non-Goals

- Do not replace the governed workflow with an unbounded orchestrator.
- Do not encode one historical experiment in public source, tests, docs, or plugin examples.
- Do not treat external agent success as research success.
- Do not treat compiled manuscripts as paper-ready without review gates.
