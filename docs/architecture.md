# Architecture (Harness-Focused)

This document captures the runtime contracts that must remain stable while improving quality enforcement.

## 0) Product surface decision

AutoLabOS is plugin-first at the public product boundary: Codex and external research agents may execute the work, while AutoLabOS owns the artifact, gate, review, downgrade, and paper-readiness contract. The fixed TUI/web workflow remains the reference implementation, compatibility shell, and live-validation environment.

This product-surface decision does not weaken the governed workflow contract below. The public contract should be expressed through traceable artifacts and gates, not through hardcoded one-off experiments or claims that a completed workflow is automatically paper-ready.

## 1) Governed workflow contract

AutoLabOS operates around a governed fixed research workflow:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> figure_audit -> review -> write_paper`

The historical 9-node contract remains the architectural baseline for the research loop. The current runtime has 10 named nodes because `figure_audit` is the one approved post-analysis checkpoint added for independent figure-quality and vision-critique resume behavior. Beyond that deliberate checkpoint, the top-level governed workflow must remain stable unless an explicit contract change is made.

Do not casually add, remove, reorder, or redefine top-level nodes.

A top-level workflow change is allowed only when all of the following are true:

- the change clearly improves the research/runtime contract rather than duplicating an existing stage
- inspectable state transitions are preserved
- artifact audibility is preserved
- reproducibility is preserved
- review gating and claim-ceiling discipline are preserved
- safe backtracking behavior is preserved
- the change is reflected consistently in docs, runtime behavior, and validation expectations

Until those conditions are met, treat the governed workflow shape as fixed.

### Workflow-native topic discovery

The public plugin intent `research:discover` is implemented inside the fixed
reference workflow, not as a CLI-backed command or a new top-level node. It
starts from a complete `ResearchBrief` whose `Research Mode` is
`topic_discovery` and uses this existing node sequence:

`collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments`

- `collect_papers` gathers literature under the brief's broad search scope,
  admissibility constraints, evidence floor, and failure conditions. The brief
  must not pretend that a final intervention, dataset, or metric has already
  been selected. It builds multiple independent query families, and every
  family carries a scientific lens plus a contribution intent. Retrieval
  candidates are only a screening pool: each lexically eligible paper-family
  pair must receive a bounded `direct_support`, `application_only`, or
  `uncertain` judgment before the paper can enter the analysis corpus. The
  retrieved candidate universe, lexically eligible pair universe, semantic
  review universe, and bounded retained corpus remain distinct and auditable;
  the corpus cap never removes a lexical pair before semantic precision is
  computed. A partial or unavailable reviewer causes a reviewer-only retry and
  must not train query reformulation feedback.
  Before retrieval, the node freezes a role-bearing scientific-scope contract.
  A `topic_discovery` brief should declare `Scientific Scope` with separate
  `Scientific Object`, `Empirical Problems`, `Scientific Relations`,
  `Prior-Work Probes`, constraints, process rules, publication goals, and
  exclusions. Only empirical problems and scientific relations authorize query
  axes; the scientific object authorizes the immutable shared anchor, while
  prior-work probes remain a separate closest-prior lane. Briefs without this
  explicit section receive deterministic role classification and fail closed when authority is
  insufficient. Every family must retain at least two terms from one frozen
  source axis unless two deduplicated candidate titles establish queryability;
  free-form lens prose never counts as lineage, and candidate-title vocabulary
  may support a technical refinement but cannot create a replacement problem or
  direct-support evidence. A brief-declared anchor is immutable before the first
  retrieval. Planning fails closed when the brief does not expose enough
  role-authorized scientific material, and
  feedback from a different scope fingerprint is quarantined instead of merged.
  Before query-family planning, at most four brief-declared prior-work probes
  with at least two substantive terms run through a separate bounded retrieval
  lane. Each probe retains at most four titles from eight provider candidates.
  Those titles are cache-bound vocabulary hints only: they cannot authorize an
  axis, enter the corpus, count toward family precision, establish novelty, or
  become paper evidence. Generic closest-prior process reminders are recorded
  in the scope contract but do not trigger provider searches.
- `analyze_papers` materializes `ResearchGapMap` from evidence-linked
  typed research opportunities and retains supported versus provisional
  epistemic status. The admissible opportunity types are explicit scientific
  limitations, cross-paper result disagreements under a shared comparison
  frame, boundary or transfer mismatches, grounded comparator/control
  omissions, and grounded reproducibility omissions. Every type has its own
  deterministic evidence conditions and adversarial reviewer conditions;
  topic similarity and empty-field inference are never sufficient.
- `generate_hypotheses` materializes `TopicPortfolio` with 5-7 candidates
  spanning at least 3 distinct nonempty evidence-axis clusters. Each candidate
  records closest-prior non-overlap, the strongest-baseline absorption objection,
  primary metric, explicit metric unit and numeric scale, optimization direction, a structured
  delta-versus-reference practical-effect criterion,
  comparator, data/task scope, local budget, falsifier, kill signal, and
  minimum publishable evidence.
- `design_experiments` validates the portfolio, materializes
  `TopicProbeDecision`, binds exactly one authorized candidate in a hash-bound
  `ActiveTopicProbeContract`, and explicitly defers the other authorized
  candidates until that probe is resolved.

A validated candidate rejection may route a successor run back to portfolio
refresh, but refresh is not permission to relabel the same study. The
`topic_probe_successor_route_target` binds the rejected candidate's topic-memory
descriptor and a deterministic divergence policy. A refreshed candidate must:

- change the contribution object;
- change at least three of contribution object, method mechanism, data/task
  scope, and evaluation protocol;
- receive a `clear` decision against the project topic-memory ledger; and
- carry a new complete candidate-owned experimental contract.

Changing only an identifier, wording, dataset, or metric does not satisfy this
contract. The changed-axis check is a deterministic minimum, not proof of
scientific novelty. Closest-prior search, full-text absorption review, and the
topic-memory decision remain required before a refreshed candidate can be
probe-eligible.

This workflow intent first reaches closed-chain probe authorization, a
pre-probe gate. That decision admits one candidate to experiment design; it is not final topic selection and is not executable
authority. `effective_execution_authorized=true` is a separate fail-closed
decision that additionally requires a valid candidate-conditioned direct-prior
receipt covering the active candidate and a passing estimator contract that was
promoted byte-for-byte to `experiment_contract.json`. Candidate-prior
collection plans are created before backtracking, so a completed plan must bind
to the immediately preceding research cycle. Its broad-discovery parent corpus,
semantic review, and query plan must remain valid in the immutable collection
archive. Missing or tampered parent lineage, wrong-candidate coverage, an
unpromoted experiment contract, or estimator failure blocks implementation and
execution. Neither authorization state establishes final topic selection,
research completion, confirmatory evidence, or paper readiness.

## 2) Shared runtime surfaces

- TUI (`autolabos`) and local web ops UI (`autolabos web`) share the same interaction/runtime layer.
- Node execution and transitions are controlled by `StateGraphRuntime`.
- Runtime events are persisted per run in `.autolabos/runs/<run-id>/events.jsonl`; high-churn telemetry should go there rather than into the run index surfaces.
- Deferred `collect_papers` recovery state is persisted in `.autolabos/runs/<run-id>/collect_background_job.json` whenever background enrichment is active, so restart recovery stays inspectable.
- Approval mode and transition recommendation behavior are part of runtime contracts.
- `/approve` must respect stored non-advance pending transitions (for example `analyze_results -> backtrack_to_design`) instead of advancing by graph order. Explicit manual `/agent run <next-node>` handoffs may resume `pause_for_human` transitions without weakening default approval behavior.
- Interactive surfaces distinguish the inspected run from the active action target. Selecting a run is read-only; commands, approvals, retries, transition application, and node execution require an explicit active-run match.
- Asynchronous projections are keyed by run identity and request generation. A late response for a previously inspected run must never replace the current inspector state.
- HTTP `GET` routes are observational. Derived artifact materialization belongs to explicit commands or mutating routes, never to a read endpoint.

Harness and runtime work must preserve both TUI and web behaviors unless a change is explicitly requested.

## 3) Artifact model

- Run-scoped source of truth: `.autolabos/runs/<run-id>/...`, including `run_record.json` for the full persisted run snapshot
- Sqlite-backed operational hot path: `.autolabos/runs/runs.sqlite` for list/get/search/update index traffic plus sqlite-maintained usage, checkpoint, event, and artifact metadata indexes
- Lightweight compatibility mirror/projection: `.autolabos/runs/runs.json` (status, node pointer, pending transition, aggregate `usage`, without long transition-history payloads)
- Public mirrored outputs: `outputs/` (single latest-run public bundle)
- Checkpoints and run context are persisted under each run directory.
- Design/execution experiment contracts live in `experiment_portfolio.json` and `run_manifest.json`.
- Managed-bundle matrix slices, when materialized, are persisted as `trial_group_matrix.json` plus per-slice `trial_group_metrics/*.json`.
- Transition/gate decisions remain inspectable through artifacts such as `transition_recommendation.json`, `analysis/evidence_scale_assessment.json`, `review/*`, a bound `ModelReviewBundle` when used, and `paper/write_paper_eligibility.json`.

Workflow-native topic discovery has a distinct run-scoped artifact class:

- `collect_query_plan.json` version 7 records the versioned query-family
  contracts, their stable identifiers, the hash-bound scientific-scope
  contract, sentence-role audit units, and per-family scope-lineage diagnostics.
  The scope artifact uses
  a brief fingerprint, an anchor-independent scope fingerprint, and an
  anchor-bound contract fingerprint so resumed planning cannot silently reuse
  stale feedback or replace the executed anchor.
- `collect_prior_work_probe_receipt.json` records every executed
  brief-declared probe, provider diagnostics, bounded candidate titles, and the
  explicit `query_hint_only` / `paper_evidence_allowed=false` boundary.
  It remains outside both the retrieval candidate sidecar and the retained
  evidence corpus.
- `collect_topic_discovery_candidates.jsonl` preserves the retrieval candidate
  universe with retrieval-family, lexical-match, semantic-selection, and
  final-corpus publication states. It always has
  `paper_evidence_allowed=false`; it is diagnostic input, not paper evidence.
- `collect_semantic_review_input.json` preserves the exact bounded reviewer
  input and its hash, while `collect_semantic_review.json` preserves pair-level
  judgments and reviewer identity without promoting the candidate pool.
- `collect_corpus_quality.json` version 4 admits only direct-support pairs,
  exposes application-only and uncertain counts plus per-family semantic
  precision, and fails closed when the review is partial or operationally
  unavailable.
- `ResearchGapMap` at `analysis/gap_map.json`
- `TopicPortfolio` at `hypothesis_generation/topic_portfolio.json`
- `TopicProbeDecision` at `design_experiments_panel/topic_decision.json`
- `ActiveTopicProbeContract` at `design_experiments_panel/active_topic_probe_contract.json`
- candidate direct-prior plan and receipt at
  `collect_candidate_prior_search_plan.json` and
  `collect_candidate_prior_search_receipt.json`
- estimator candidate, contract, and report under `design_experiments_panel/`
- the recomputed execution gate at
  `governance/topic_probe_execution_authorization.json`

These are workflow artifacts, not executable CLI intents. `TopicPortfolio`
binds the verified gap map, `TopicProbeDecision` binds the validated portfolio,
and `ActiveTopicProbeContract` binds one candidate and its candidate-owned
measurement contract for a bounded probe. Their presence or a passing probe
decision does not establish final topic selection or paper readiness.

The jobs API, Web UI, TUI, `implement_experiments`, direct implementation
manager entry, and `run_experiments` all consume the same recomputed execution
authorization. Persisted pre-probe booleans and estimator status are diagnostic
components and must never be treated independently as execution permission.

`analyze_papers` revalidates the collection generation, query plan, reviewer
input hash, pair judgments, retained paper IDs, family counts, and semantic
precision floors. A retired quality artifact, a changed judgment, or a corpus
whose family provenance diverges from the direct-support pairs blocks analysis
instead of being treated as a recoverable presentation warning.

`analysis/gap_synthesis.json` binds every accepted opportunity to its exact
`opportunity_type`, independent canonical works, grounded full-text evidence,
and the type-specific reviewer conditions. The gap map replays the same typed
eligibility from `evidence_store.jsonl`; a rehashed accepted cluster cannot
substitute for missing reviewer conditions. One grounded evidence row may
support more than one independently reviewed opportunity type, but it cannot
be used for a type it did not deterministically qualify for.

The active candidate measurement contract must carry the metric identifier,
non-empty unit, numeric scale, optimization direction, comparator, and machine-readable effect
criterion without reconstructing them from prose at execution time.

`design_experiments` must translate that candidate-owned contract into the
frozen `ResultsPlanV2`: `primary_comparison_id` selects the exact declared
subject/reference pair, and `primary_effect_criterion` binds that same
comparison to the raw candidate metric, its numeric scale, optimization
direction, and structured threshold. `ExperimentContract` persistence,
analysis, review, and writing must preserve this binding. A merely positive
delta cannot replace a candidate's declared minimum effect.

Quality checks should be deterministic and file-based whenever possible.

Public-facing outputs must remain traceable to underlying run artifacts.

Because events, checkpoints, background-job recovery, and execution artifacts already live in per-run files, long-lived/full-fidelity run state should stay under the run directory and be projected into index surfaces only as needed for list/search flows. In the current rollout, `runs.sqlite` carries the operational run-index hot path plus sqlite-maintained usage/checkpoint/event/artifact indexes, while `runs.json` remains a compatibility mirror for inspection, doctor/harness checks, and migration fixtures. Append-only artifacts should still live in per-run files rather than in sqlite or `runs.json`; sqlite should mirror their query-heavy metadata, not replace the files themselves.

## 4) Node-internal loops are bounded

Internal control loops inside nodes are allowed and expected, including loops in analysis, design, implementation, execution, result interpretation, and writing.

However, these loops must remain:

- bounded
- auditable through artifacts or logs
- consistent with node purpose
- non-destructive to top-level workflow clarity

Node-internal iteration must not be used to smuggle in an undeclared top-level workflow redesign.

## 5) Review and paper-readiness contract

`review` is a gate, not a cosmetic pass.

The system must not treat workflow completion, `write_paper` completion, or successful PDF generation as equivalent to paper-ready research.

Top-level progression to paper-writing behavior should preserve the distinction between:

- system completion
- artifact completion
- research completion
- paper readiness

A paper-scale outcome requires evidence beyond successful orchestration, including baseline/comparator presence, real experiment execution, quantitative comparison, and claim-to-evidence linkage.

### Decision authority hierarchy

Review decisions use four explicit authority tiers:

- `A0 deterministic` validates schemas, hashes, closed inventories, required evidence, and mechanical gate predicates. It establishes blockers and the maximum permitted claim/readiness ceiling.
- `A1 model advisory` produces specialist critique, screening, uncertainty, and repair recommendations without mutating deterministic gates.
- `A2 model conservative` reconciles model findings and may preserve or add blockers, lower readiness within the deterministic ceiling, or route work upstream. It cannot remove an `A0` blocker, change or raise the deterministic ceiling, create missing external evidence, create human attestation, or create legal or redistribution permission.
- `A3 human authority` records an identified human review, final approval, attestation, or an authorized legal/redistribution decision in a separate hash-bound artifact. Model output cannot impersonate this tier.

The hierarchy is monotone with respect to deterministic blockers. New or corrected evidence must be hash-bound and evaluated again at `A0`; neither model nor human prose rewrites gate history. Fresh `EvidenceBundle` and `GateReport` artifacts bind each available audited input by portable path, SHA-256, and byte length so stale manuscript or evidence bytes cannot inherit a prior review gate.

A3 is required only when the governed claim depends on human or legal
authority. A controlled deterministic benchmark may establish metric gold at
A0 when a frozen registry, independent artifact-replay oracle, hash-bound gold
and split manifests, and held-out source/fault-family separation all verify.
That path is limited to `registered_fault_families_only`; it cannot establish
naturalistic generalization, reviewer identity, attestation, or redistribution
permission.

### Paper-scale model review topology

When `research:review` is paper-scale or the user requests multi-agent review, Codex plugin orchestration follows `docs/model-review-protocol.md`; the CLI validates and conservatively imports the resulting sidecar:

1. Freeze the exact `GateReport`, exact `EvidenceBundle`, and every required
   `GateReport.input_bindings` path as the closed input manifest.
2. Select the strongest available frontier model and highest available reasoning tier under active provider/runtime policy, recording requested and effective routing.
3. Execute five initial `A1` roles in parallel: `claim_evidence`, `methodology`, `statistics`, `reproducibility`, and `adversarial`.
4. Give every role that identical closed inventory and the same gate SHA-256,
   while withholding all peer outputs during the initial pass.
5. Hash and validate all initial outputs, then run a separate meta reviewer bound to those five hashes and the same gate hash.
6. Preserve every specialist record in `ModelReviewBundle`, require the meta reviewer to emit each adopted finding, and project only those meta findings into `ReviewReport` and repair targets with at most `A2` authority.

Missing roles, provenance, isolation evidence, exact hash binding, or meta reconciliation block model-based paper-scale promotion. Model review remains distinct from any `A3` human artifact. Never generate the human review or final approval.

Page-budget semantics should also remain explicit:

- brief-derived manuscript format targets drive main-body writing budgets
- brief-derived minimum main-body pages gate the compiled-PDF floor check
- template-derived layout hints influence appendix format and word-budget estimation

## 6) Research brief contract

A governed run should begin from a research brief that defines the execution contract.

`Research Mode` determines who owns the final experimental contract:

- In `hypothesis_test`, the brief owns the research question, primary metric,
  direction, practical-effect boundary, comparator, and data/task scope.
- In `topic_discovery`, the brief owns the broad search scope, candidate
  admissibility rules, resource ceiling, evidence floor, and failure rules.
  Each shortlisted candidate must own its final metric, direction,
  practical-effect boundary, comparator, data/task scope, falsifier, and local
  budget. The broad brief objective must not overwrite those candidate fields.

An explicitly unsupported mode is a validation error. Only an absent mode
defaults to `hypothesis_test`.

At minimum, the brief structure should align with `docs/research-brief-template.md`, including:

- Topic
- Research Mode (optional only because omission means `hypothesis_test`)
- Objective Metric
- Constraints
- Plan
- Research Question
- Why This Can Be Tested With A Small Real Experiment
- Baseline / Comparator
- Dataset / Task / Bench
- Target Comparison
- Minimum Acceptable Evidence
- Disallowed Shortcuts
- Allowed Budgeted Passes
- Paper Ceiling If Evidence Remains Weak
- Minimum Experiment Plan
- Paper-worthiness Gate
- Failure Conditions

Missing governance fields should be treated as execution risks, not harmless omissions.

For brief-governed runs, the brief is not only advisory prose. The runtime should enforce it as a contract:

- `design_experiments` should materialize brief completeness / design consistency artifacts and stop progression on explicit contract gaps.
- `analyze_results` should compare executed evidence against the brief's minimum acceptable evidence and emit a deterministic evidence-scale assessment.
- `review` should treat weak brief-governed evidence as a backtrack condition, not merely a drafting warning.
- `write_paper` should fail fast when pre-draft critique or brief-evidence assessment still classifies the run below paper scale.

Config should not compete with the brief for research-shaping intent.
In the current contract, `.autolabos/config.yaml` is primarily for provider/runtime policy, workspace defaults, and execution settings that are not specific to one governed research question.
Research- and manuscript-shaping fields that can be carried by the brief should be treated as brief-owned whenever possible.
That is why persisted config may omit `research` defaults entirely and may slim down brief-covered manuscript-profile fields such as column count and main-body page targets; the loader restores runtime defaults, but the brief remains the canonical execution contract for a run.

## 7) Validation surfaces are first-class

The following are first-class validation surfaces for contract enforcement:

- real TUI validation
- local web validation
- targeted tests
- smoke checks
- harness validation
- artifact inspection
- `/doctor` diagnostics when applicable

For interactive defects, real behavior is the primary ground truth.
Tests and harness checks support but do not replace same-flow revalidation.

## 8) Harness engineering goals

- Turn important quality assumptions into explicit checks.
- Keep checks cheap enough for routine CI.
- Fail early on structural incompleteness such as missing required artifacts or malformed records.
- Keep enforcement incremental and compatible with current contracts.
- Prefer minimal, high-confidence enforcement that improves observability and reproducibility.

## 9) Reproducibility contract

A run should not be treated as trustworthy unless its outputs and transitions can be inspected and rechecked.

When applicable, validation should confirm:

- checkpoint/state consistency
- consistency between public-facing outputs and run-scoped artifacts
- observable behavioral change, not only modified code paths
- explicitly stated remaining validation or reproducibility gaps

## 10) Non-goals for this track

- No redesign of product UX without an explicit product-direction decision.
- No broad refactor of orchestration/runtime without contract justification.
- No speculative replacement of existing node logic.
- No weakening of review gating, evidence discipline, or reproducibility expectations for convenience.

## 11) Exploration Engine (P2-9)

### Historical 9-node baseline and figure_audit checkpoint

AutoLabOS의 핵심 가치는 governed, checkpointed, inspectable workflow다.
Exploration Engine은 이 graph를 대체하지 않는다.
`figure_audit`를 제외한 exploration 관련 신규 상위 노드는 추가하지 않는다.

### Exploration Manager가 내부 coordinator인 이유

새로운 상위 노드를 추가하면 기존 checkpoint/resume 계약이 깨진다.
ExplorationManager는 기존 노드 핸들러 내부에서 초기화되고, 자체 파일시스템(`experiment_tree/`)에 상태를 저장한다.
즉, `design_experiments ~ analyze_results` 구간의 bounded coordinator이지, `StateGraphRuntime`를 우회하는 별도 오케스트레이터가 아니다.

### Bounded Exploration Engine 삽입 위치

- `design_experiments` → ExplorationManager 초기화, baseline proposal
- `implement_experiments` → tree node 코드 구현
- `run_experiments` → tree node 실행
- `analyze_results` → evidence 수집, Gate 1+2(결정론적), promotion gate, writeup manifest 생성
- `figure_audit` → Gate 3(vision LLM critique) + 전체 audit 집계 → `figure_audit_summary.json`
- `review` → figure audit 결과 반영, A0 gate에 hash-bound된 5개 독립 A1 specialist와 후속 A2 meta review를 통한 strongest defensible branch 판정

### figure_audit 노드를 별도 추가한 이유

Gate 1+2는 결정론적이고 실행 시간이 1초 미만이므로 `analyze_results` 후처리로 충분하다.
Gate 3(vision LLM)는 실행 시간이 분 단위이고 비동기 LLM 호출이며 타임아웃/실패가 가능하다.
Gate 3 실패 시 `analyze_results` 전체를 재실행해야 하는 책임 혼재를 피하고, `analyze_results 완료 / figure_audit 미완` 상태를 독립 체크포인트로 resume할 수 있어야 한다.
`figure_auditor.enabled=false`이면 `figure_audit` 노드는 workflow compatibility를 위해 pass-through로 동작할 수 있지만, 그 ablation 결과는 manuscript promotion을 승인할 수 없다.

### Baseline Lock과 Single-Change Enforcement

`baseline_hardening` stage 완료 시 baseline lock이 생성된다.
이후 모든 branch는 lock의 `allowed_intervention_dimensions` 안에서 단 하나의 dimension만 바꿀 수 있다.
동시에 두 dimension이 바뀌면 `singleChangeEnforcer`가 차단한다.

### Executed-Evidence-Only와 Claim Ceiling의 연결

claim ceiling (`paperMinimumGate.ts`)은 claim-evidence 정합성을 검사한다.
`evidenceSerializer`는 그 이전 단계에서 미실행 항목이 claim source로 진입하지 못하도록 차단한다.
두 메커니즘은 독립적이지만 상호 보완적이다.

### Figure Auditor 역할

`figure_audit`는 `analyze_results` 완료 후, review 입력 전에 동작하는 품질 gate다.
역할은 미적 개선이 아니라 증거 정합성(`evidence_alignment`), 가독성, 게재 가능성(`publication_readiness`) 판정이다.
`empirical_validity_impact`와 `publication_readiness`는 별도 필드로 분리 저장된다.
severe mismatch는 review decision을 `revise` 이상으로 격상시킨다. measured audit가 없거나 결과가 malformed 또는 ablated이면 manuscript promotion은 fail-closed로 차단된다.

### AI-Scientist-v2와의 차이

유사점:
- experiment manager
- tree-based exploration
- stage-based policy
- search budget

차이점:
- AutoLabOS는 governed fixed graph를 유지하며 exploration tree가 그 안에 내장된다. `figure_audit`는 Gate 3의 독립 체크포인트 필요성 때문에 추가된 노드이며, exploration engine 자체가 상위 workflow를 늘리는 방식은 아니다.
- single-change enforcement와 baseline lock이 필수 gate다.
- review gate가 단순 LLM 점수가 아닌 A0 deterministic gate + 5개 독립 A1 specialist + 후속 A2 meta reviewer 구조다.
- checkpointed resume와 audit trail이 핵심 요구사항이다.
- Figure Auditor가 별도 노드로 분리되어 비동기 vision critique를 독립 resume 가능하게 한다.
