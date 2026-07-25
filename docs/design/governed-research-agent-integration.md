# Governed Research Agent Integration

## Objective

AutoLabOS combines broad research automation with evidence-gated progression. External agent patterns are useful only when they preserve the fixed 10-node workflow, inspectable artifacts, bounded backtracking, explicit authority, and an evidence-based paper ceiling.

## Architectural Invariants

- The top-level workflow remains `collect_papers -> analyze_papers -> generate_hypotheses -> design_experiments -> implement_experiments -> run_experiments -> analyze_results -> figure_audit -> review -> write_paper`.
- Exploration and repair loops stay bounded inside their owning node.
- `A0` deterministic checks set blockers and the maximum readiness ceiling. `A1` reviewers advise, `A2` reconciliation can preserve or lower that ceiling, and only a genuine `A3` artifact can carry human or legal authority.
- TUI, Web, and plugin surfaces operate on the same persisted run and transition contracts.
- Read operations do not materialize or mutate governed artifacts.
- Generated code executes only through an explicit execution envelope with auditable inputs, limits, and outputs.

## Comparative Patterns

| Project | Useful pattern | AutoLabOS decision |
| --- | --- | --- |
| [AI Scientist v2](https://github.com/SakanaAI/AI-Scientist-v2) | Experiment-manager-guided progressive tree search and explicit sandbox warning for model-written code | Keep bounded branch exploration inside existing experiment nodes; require a controlled execution envelope before broader autonomy |
| [Agent Laboratory](https://github.com/SamuelSchmidgall/AgentLaboratory) | Specialized agents across literature, experimentation, and reporting, plus a copilot mode | Keep role-specialized reviewers and expose human participation as an explicit governed mode |
| [GPT Researcher](https://github.com/assafelovic/gpt-researcher) | Planner, execution-agent, and publisher separation | Preserve node ownership and prevent drafting agents from silently acting as evaluators |
| [ResearchGym](https://github.com/Anikethh/ResearchGym) | Agent adapters, local or container runtime selection, budget enforcement, and independent grading | Introduce provider-neutral execution adapters and a common run envelope rather than experiment-specific launch code |
| [AstaBench](https://github.com/allenai/asta-bench) | Restricted task tools, sandbox-backed analysis, trajectory-aware scoring, and cost logging | Record tool policy, model usage, and trajectory provenance as first-class evaluation evidence |
| [BenchFlow](https://github.com/benchflow-ai/benchflow) | One scored-trajectory contract, hardened verifiers, loop strategies, and interchangeable sandboxes | Separate rollout records from verifier records and make every bounded retry visible in cost and outcome traces |
| [STORM and Co-STORM](https://github.com/stanford-oval/storm) | Multi-perspective inquiry, moderator-led turn policy, human steering, and a shared concept map | Add bounded operator decisions and evidence maps; do not permit free-form human input to bypass deterministic gates |
| [OpenAGS](https://github.com/openags/auto-researcher) | Integrated research workspace, provider adapters, resumable sessions, Docker and remote execution | Keep one operator workbench while making action context and remote execution authority explicit |
| [DeerFlow](https://github.com/bytedance/deer-flow) | Long-horizon harness with sandboxes, memory, skills, subagents, and message gateways | Reuse skills and notifications behind governed interfaces; do not let memory or gateways become untracked evidence |
| [ResearchClawBench](https://github.com/InternScience/ResearchClawBench) | Evaluation spanning research reproduction and new discovery | Evaluate orchestration, recovery, provenance, and scientific outcomes separately instead of using workflow completion as the score |

The comparison set is indexed by the [Awesome AI Auto-Research survey repository](https://github.com/worldbench/awesome-ai-auto-research). Repository claims are treated as design references, not as independent evidence that a pattern improves AutoLabOS.

## Adopted Runtime Controls

### Run Context Lock

Every interactive projection carries two identities:

- `inspected_run_id`: the run whose state and artifacts are visible.
- `active_run_id`: the run that may receive commands and workflow mutations.

Inspection is read-only. A mismatch disables mutation until the operator explicitly activates the inspected run. Request generations prevent late responses from restoring stale run details.
Direct workflow mutations also require confirmation that names the action, run title, run ID, and node before the request is sent.

### Fail-Closed Human Boundary

`pause_for_human` is terminal for an autonomous pass. Confidence thresholds, repeated recommendations, force fallbacks, and automatic approval lists cannot consume it. Resumption requires a separately recorded operator action.

### Guarded Review Traversal

`/agent review` follows the full 10-node contract. From `analyze_results`, it executes `figure_audit`, applies only an exact auto-executable `figure_audit -> review` advance, and stops on backtrack, failure, cancellation, or human pause.

### Monotone Readiness

Deterministic-only evidence cannot produce `paper_ready=true`. A hash-bound `A2` result may preserve or lower the `A0` ceiling but cannot raise it, remove an `A0` blocker, or manufacture `A3` authority.

### Observational Read APIs

Web read endpoints build projections in memory. Artifact creation and refresh remain explicit workflow or command operations, so inspection cannot alter the evidence under review.

## Next Architecture Increments

### P1: Governed Decision Queue

Persist each intervention request with a stable decision ID, run and node identity, requested authority, allowed actions, reason, evidence bindings, creation time, expiry, and acknowledgement. Web, TUI, plugin, and notification gateways consume the same queue. Decisions are idempotent and cannot be replayed against a different checkpoint.

### P1: Operator Snapshot V2

Expose one versioned projection containing active and inspected run IDs, checkpoint sequence, pending transition, authority requirement, action capabilities, job lease state, projection sequence, and last durable event. This replaces independently refreshed UI fragments as the command-enablement source.

### P2: Durable Run Lease

Long-running work records owner identity, heartbeat, lease expiry, attempt ID, and cancellation acknowledgement. Restart recovery can distinguish an active worker from an abandoned job and prevents duplicate execution.

### P2: Execution Envelope and Adapters

An execution request declares adapter, immutable input snapshot, workspace boundary, command, environment allowlist, network policy, time and resource budget, random seeds, dependency lock, and expected output manifest. Local, container, remote, and provider-backed runners return the same receipt shape.

### P2: Trajectory and Evaluator Separation

Node attempts emit append-only trajectory records for prompts, tool calls, costs, outputs, retries, and termination. Evaluators consume frozen trajectories and artifact hashes through separate identities and write independent verifier records. Author and evaluator outputs never share an implicit mutable context.

### P3: Dual-Surface Journey Validation

One isolated run fixture drives the same real journey through TUI and Web: inspect a non-active run, activate it, execute a safe node, observe a human pause, resume explicitly, reload, and compare persisted artifacts. Deterministic smoke remains a secondary regression tool.

## Rejected Shortcuts

- Unbounded tree search that bypasses node budgets or checkpoint ownership
- Automatic conversion of `pause_for_human` into approval or advance
- UI-only action state without persisted checkpoint and authority identity
- Reviewer output that mutates deterministic evidence or impersonates a human attestation
- Generated-code execution without workspace, network, resource, and output constraints
- Workflow completion, PDF generation, or one favorable reviewer score as a paper-readiness proxy
