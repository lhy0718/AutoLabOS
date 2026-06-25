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

## Non-Goals

- Do not replace the governed workflow with an unbounded orchestrator.
- Do not encode one historical experiment in public source, tests, docs, or plugin examples.
- Do not treat external agent success as research success.
- Do not treat compiled manuscripts as paper-ready without review gates.
