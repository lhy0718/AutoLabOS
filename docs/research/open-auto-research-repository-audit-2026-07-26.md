# Open Auto-Research Repository Audit

## Scope

- Audit date: 2026-07-26
- Index inspected: [worldbench/awesome-ai-auto-research](https://github.com/worldbench/awesome-ai-auto-research), `Tools & GitHub Repos`
- Inventory coverage: all 24 repositories listed in that section
- Baseline inspection: repository metadata, current README, declared purpose, setup, outputs, and visible project structure
- Deeper inspection: architecture or operation sections and source-tree boundaries for the systems most relevant to AutoLabOS
- Evidence boundary: this is a design audit, not a benchmark result. Repository claims are not treated as independently reproduced performance evidence.

Depth codes used below:

- `M`: metadata and README inspected
- `D`: `M` plus architecture or operation details and source-tree boundaries inspected

## Complete Inventory

| Category | Repository | Depth | Relevant mechanism | Adoption boundary |
|---|---|---:|---|---|
| Curated list | [DavidZWZ/Awesome-Deep-Research](https://github.com/DavidZWZ/Awesome-Deep-Research) | M | Taxonomy of deep-research agents, retrieval, and evaluation | Use as search-space coverage only; it is not an executable research gate. |
| Curated list | [yuzhimanhua/Awesome-Scientific-Language-Models](https://github.com/yuzhimanhua/Awesome-Scientific-Language-Models) | M | Scientific-language-model and benchmark map | Use to diversify source discovery; do not infer model suitability from list membership. |
| Curated list | [HKUST-KnowComp/Awesome-LLM-Scientific-Discovery](https://github.com/HKUST-KnowComp/Awesome-LLM-Scientific-Discovery) | M | Scientific-discovery lifecycle and autonomy taxonomy | Use for coverage checks; keep AutoLabOS's evidence gates independent of taxonomy labels. |
| Curated list | [openags/Awesome-AI-Scientist-Papers](https://github.com/openags/Awesome-AI-Scientist-Papers) | M | AI-scientist system and paper map | Use as a seed corpus, never as closest-prior verification. |
| Curated list | [handsome-rich/Awesome-Auto-Research-Tools](https://github.com/handsome-rich/Awesome-Auto-Research-Tools) | M | Tool inventory across the research lifecycle | Use for capability-gap scanning, not runtime composition by default. |
| Curated list | [webfuse-com/awesome-autoresearch](https://github.com/webfuse-com/awesome-autoresearch) | D | Keep-or-revert loops, `GOAL.md` fitness contracts, resume, shared experiment claims, and persistent traces | Adopt measurable contracts and bounded loops; reject single-score optimization as a general scientific-validity criterion. |
| Curated list | [Leey21/awesome-ai-research-writing](https://github.com/Leey21/awesome-ai-research-writing) | M | Reusable writing prompts and agent skills | Reuse workflow packaging patterns; writing assistance cannot substitute for evidence or reference verification. |
| Idea generation | [RenqiChen/Virtual-Scientists](https://github.com/RenqiChen/Virtual-Scientists) | D | Role-based teams, inter-team and intra-team discussion, and logged idea-generation runs | Use independent perspectives selectively; multi-agent agreement is not empirical evidence and large simulated societies are out of scope. |
| Idea generation | [JinheonBaek/ResearchAgent](https://github.com/JinheonBaek/ResearchAgent) | D | Literature retrieval followed by iterative problem, method, and experiment refinement with parallel reviewers | Adopt literature-bound candidate revision; add deterministic feasibility and execution gates because reviewer scores alone are insufficient. |
| Literature review | [Future-House/paper-qa](https://github.com/Future-House/paper-qa) | D | Local full-text index, iterative search and evidence gathering, metadata checks, contextual reranking, and cited answers | Adopt source adapters and evidence packets; retain exact source/version/verification-depth receipts outside generated prose. |
| Literature review | [LearningCircuit/local-deep-research](https://github.com/LearningCircuit/local-deep-research) | D | Local and encrypted document library, adaptive search-engine selection, local model support, and explicit privacy controls | Adopt local-first source handling and provider isolation; general web synthesis does not establish scholarly claim support. |
| Literature review | [mukulpatnaik/researchgpt](https://github.com/mukulpatnaik/researchgpt) | M | Conversational interaction with research papers | Useful as an inspection surface, but too narrow to define topic discovery or novelty gates. |
| Literature review | [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) | D | Web and local-document research, specialized multi-agent workflows, progress UI, and trace integration | Adopt pluggable source scopes and observable progress; source-frequency heuristics cannot replace claim-level verification. |
| Literature review | [AutoSurveys/AutoSurvey](https://github.com/AutoSurveys/AutoSurvey) | M | Automated survey planning and generation | Use outline/corpus coverage ideas only; generated surveys do not prove a research gap. |
| Literature review | [stanford-oval/storm](https://github.com/stanford-oval/storm) | D | Perspective-guided question asking, source-grounded simulated conversations, moderator role, and staged curation/writing | Adopt perspective coverage and a moderator that seeks missing questions; keep curation separate from paper-ready claims. |
| Coding and experiments | [karpathy/autoresearch](https://github.com/karpathy/autoresearch) | D | One editable surface, fixed wall-clock budget, explicit metric, comparable trials, and keep-or-discard decisions | Adopt frozen budgets and reviewable mutation scope; require multiple scientific endpoints and uncertainty rather than a universal single metric. |
| Coding and experiments | [going-doer/Paper2Code](https://github.com/going-doer/Paper2Code) | D | Separate planning, analysis, and code-generation agents with stage artifacts | Adopt role-specific artifacts inside existing nodes; generated-code fidelity does not establish hypothesis validity. |
| Coding and experiments | [microsoft/RD-Agent](https://github.com/microsoft/RD-Agent) | D | Idea and implementation separation, scenario-specific runtimes, downloadable traces, and real-time Web UI | Adopt trace visibility and scenario adapters; prevent scenario-specific behavior from leaking into generic runtime contracts or creating Web/TUI divergence. |
| Coding and experiments | [snap-stanford/MLAgentBench](https://github.com/snap-stanford/MLAgentBench) | D | Real interactive ML tasks where agents inspect files, run repeated experiments, and analyze results; sandbox guidance | Adopt real-task execution and isolated workspaces; do not use smoke fixtures as paper evidence. |
| Coding and experiments | [SWE-bench/SWE-bench](https://github.com/SWE-bench/SWE-bench) | D | Containerized, instance-addressable evaluation with exact logs and result directories | Adopt pinned, replayable evaluation units and gold self-checks; software issue resolution is not itself a scientific benchmark. |
| Coding and experiments | [SeeleAI/Thoth](https://github.com/SeeleAI/Thoth) | D | Durable runs, locked work items, append-only ledgers, mechanical acceptance, and Dashboard/TUI/status/doctor over shared read providers | Adopt one authoritative projection and explicit run authority; do not duplicate its separate workflow ontology inside AutoLabOS's fixed 10-node contract. |
| Peer review | [deep-diver/paper-reviewer](https://github.com/deep-diver/paper-reviewer) | M | Paper ingestion, review generation, and publication-oriented conversion | Useful for document parsing and presentation only; it does not verify repair closure. |
| Peer review | [poldrack/ai-peer-review](https://github.com/poldrack/ai-peer-review) | D | Independent model reviews, meta-review, concern-by-reviewer table, and structured outputs | Adopt independent concerns and dissent-preserving synthesis; model consensus cannot satisfy an evidence gate. |
| Peer review | [maxidl/openreviewer](https://github.com/maxidl/openreviewer) | D | Domain-specialized review model, long-document processing, and conference-shaped structured review | Treat as one optional reviewer profile; static review quality does not prove a reported repair was executed. |

## Cross-System Findings

### 1. Durable authority must be separate from conversational state

Thoth is the clearest operational reference: planning authority, runtime evidence, and read surfaces have distinct roles. AutoLabOS should keep checkpoints and artifacts authoritative, expose the same projection to TUI and Web, and prevent a read or refresh path from silently becoming a state-transition authority.

### 2. Topic discovery needs a portfolio and falsification loop

ResearchAgent, Virtual-Scientists, STORM, and the autoresearch ecosystem support iterative generation and critique. Their reusable common idea is breadth followed by revision. AutoLabOS must add stronger scientific controls: independent clusters, closest-prior full-text checks, reviewer-absorption objections, local feasibility estimates, preregistered kill signals, and automatic resampling after a no-pass result.

### 3. Literature retrieval and novelty adjudication are different capabilities

PaperQA2, Local Deep Research, GPT Researcher, and STORM offer useful retrieval and synthesis patterns. AutoLabOS should preserve source identifiers, snapshots, access status, full-text availability, verification depth, and claim-level evidence. A generated summary, citation count, or list inclusion cannot establish novelty.

### 4. Autonomous experiments need a frozen fitness contract

Autoresearch demonstrates the value of a fixed budget, a narrow editable surface, and comparable trials. MLAgentBench and SWE-bench add real tasks, isolated execution, instance-level logs, and exact evaluation. AutoLabOS should compile each promoted topic into a pinned execution contract with explicit baselines, endpoints, uncertainty, mutation scope, cost ceiling, and terminal grader before model execution begins.

### 5. Review must preserve dissent and verify closure

AI Peer Review and specialized reviewers are useful for independent fault discovery. A meta-review should retain unique concerns, assign each accepted concern to an owning node or artifact, and require a same-flow rerun plus before/after evidence. Majority agreement is diagnostic coverage, not proof that a paper is correct.

### 6. UI parity is an architectural invariant

Thoth exposes multiple surfaces over shared providers, while RD-Agent documents scenario-specific UI coverage differences. AutoLabOS should expose one run/read projection to TUI, Web, `/doctor`, and status outputs, then test fresh, refresh, resume, and stale-session behavior against the same persisted artifacts.

## AutoLabOS Integration Decisions

### Adopt now

1. Keep the historical 9-node workflow plus `figure_audit`; implement topic search inside `collect_papers`, `analyze_papers`, `generate_hypotheses`, and `design_experiments` artifacts rather than adding a top-level node.
2. Require a five-to-seven candidate portfolio across at least three independent clusters before narrowing.
3. Bind shortlist, adversarial reviews, experiment design, and promotion receipts to `run_id`, research cycle, and artifact hashes.
4. Discover provider models at runtime and fail closed when required roles or research inputs are absent.
5. Give Web and TUI one authoritative research-funnel projection with explicit candidate, gate, kill, and backtrack states.
6. Preserve independent reviewer findings and require typed repair obligations, owning nodes, rerun evidence, and post-repair scoring.
7. Use pinned, isolated, instance-addressable experiment bundles with exact graders and explicit resource budgets.

### Defer until the core gates pass

1. A persistent local full-text library and multiple scholarly retrieval adapters.
2. General-purpose extension loading for arbitrary experiment dashboards.
3. Parallel GPU experiment claiming and shared best-branch synchronization.
4. Learned topic-ranking or learned replay-prioritization policies.

### Do not adopt

1. A second workflow ontology that competes with the fixed AutoLabOS node contract.
2. Generic claims that an end-to-end run, generated PDF, or reviewer consensus means the research is complete.
3. One-off model, benchmark, metric, condition, or paper-topic defaults in public source and tests.
4. Hidden artifact repair, outcome-driven sample replacement, or metric changes after results are visible.
5. Large multi-agent societies whose additional calls are not tied to independent evidence coverage.

## Implementation Map

| Required capability | Current AutoLabOS surface | Completion test |
|---|---|---|
| Auditable topic portfolio | `src/core/researchFunnel.ts` | Cross-run, cross-cycle, copied-review, and artifact-hash substitution are rejected. |
| Node-owned topic artifacts | `src/core/nodes/generateHypotheses.ts`, `src/core/nodes/designExperiments.ts` | The fixed node graph is unchanged and only owner nodes can emit accepted artifacts. |
| Shared funnel projection | `src/core/runs/researchFunnelProjection.ts`, TUI/Web projections | Fresh, refresh, resume, and stale-session views agree for the same checkpoint. |
| Runtime-discovered local models | Ollama integration and runtime creation | No concrete installed-model catalog exists in production source; missing roles fail closed. |
| Review closure | `src/core/nodes/review.ts`, `src/core/metaHarness/` | Every promoted repair has a same-evaluation before/after receipt and an owning node. |
| Reproducible experiment contract | experiment contract and runner surfaces | Pinned inputs, baseline, grader, repeats, uncertainty, cost, logs, and outputs are replayable. |
| Public portability | public-code sanitization and plugin release checks | Public source and fixtures contain no one-off study identifiers or machine-specific paths. |

## Audit Conclusion

The strongest transferable pattern is not "more agents." It is a governed chain from broad source discovery to a frozen work contract, durable execution evidence, shared read projections, independent fault discovery, and mechanical closure. AutoLabOS should remain a research-governance plugin and runtime rather than becoming another monolithic research agent with embedded topic and benchmark assumptions.
