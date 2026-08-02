# Model Review Protocol

This protocol defines the domain-neutral authority, artifact, execution, and
verification contract for model-assisted review. It applies to
`research:review`, paper-scale review, and model screening or adjudication of
candidate, reference, and license material.

Model review supplements deterministic gates and human review. It does not
impersonate either one.

## Authority hierarchy

| Tier | Authority | Allowed effect | Hard boundary |
| --- | --- | --- | --- |
| `A0` | Deterministic | Validate schemas, hashes, inventories, required evidence, and mechanical gate predicates; establish blockers and the maximum permitted claim/readiness ceiling. | An `A0` blocker is cleared only by new or corrected hash-bound input followed by a fresh deterministic evaluation. |
| `A1` | Model advisory | Produce specialist critique, screening labels, risk findings, uncertainty, and repair recommendations. | Cannot mutate a gate, approve a claim, assert human judgment, or grant legal or redistribution permission. |
| `A2` | Model conservative | Reconcile model findings, preserve or add blockers, lower readiness within the deterministic claim ceiling, and route work to repair, backtrack, or human review. | Cannot remove or waive an `A0` blocker, change the incoming deterministic ceiling, create missing external evidence, create human attestation, or create legal or redistribution permission. |
| `A3` | Human authority | Provide an identified human review, final approval, attestation, or an authorized legal/redistribution decision when the governed process requires one. | Must be recorded in a separate human-authored, hash-bound artifact. It cannot be inferred or synthesized from model output, and new evidence must still be re-evaluated by `A0`. |

`A3` is conditional rather than a universal paper-scale transition. For
`controlled_deterministic_fault_injection`, A0 may establish metric gold
without a human label when the registered fault definitions, derived gold,
independent mutation replay, development/test suite hashes, and disjoint
fault-family/source split all verify. The resulting ceiling is
`registered_fault_families_only`. Naturalistic labels, external
generalization, human identity or attestation, and legal or redistribution
decisions still require the corresponding external or A3 evidence.

The tier number is not an unrestricted override order. In particular, neither
`A2` nor `A3` edits deterministic history. A later actor may provide new bound
evidence or an authorized decision, after which the applicable deterministic
gate runs again.

## Required review topology

`research:review` must use this topology when the user requests multi-agent
review or when the review target is paper-scale:

1. Freeze the deterministic `GateReport` bytes and a closed input manifest.
   The manifest contains the exact `GateReport`, the exact `EvidenceBundle`,
   and every path declared by `GateReport.input_bindings`. Every present
   reviewed input is required and carries its SHA-256 and byte length.
2. Select the strongest available frontier model and the highest available
   reasoning tier allowed by the active provider, account, and runtime policy.
   Record both the requested and effective routing. Do not silently substitute
   a weaker route.
3. Launch five initial reviewers in parallel with distinct execution IDs and
   these independent roles:
   - `claim_evidence`: claim scope, artifact support, citation support, and
     claim-ceiling alignment
   - `methodology`: design validity, controls, comparators, confounds, and
     interpretation boundaries
   - `statistics`: estimands, sample adequacy, uncertainty, repeated trials,
     statistical procedures, and quantitative reporting
   - `reproducibility`: executable artifacts, environment and data lineage,
     seeds, logs, manifests, and rerun sufficiency
   - `adversarial`: the strongest plausible rejection case, leakage, hidden
     assumptions, contradictory evidence, and unsupported promotion paths
4. Give every initial reviewer the same immutable input manifest and exact
   `GateReport` SHA-256. Do not share any initial reviewer output, summary, or
   conclusion with another initial reviewer.
5. Normalize and hash all five initial outputs before starting a separate meta
   reviewer. The meta reviewer receives the frozen gate and all five bound
   outputs, reconciles them at `A2`, and retains every material agreement and
   disagreement.
6. Fail closed when a role is missing, provenance is incomplete, the gate hash
   differs, initial isolation is not demonstrated, or meta reconciliation is
   absent. Partial reviews remain `A1` advisory artifacts and cannot support a
   paper-scale promotion.

Individual specialist outputs have `A1` authority. A complete meta review may
have `A2` authority only after deterministic verification of the bundle.

AutoLabOS runtime review persists this chain under the run directory:

- `review/review_input_snapshot.json` records the resolved inputs used to build
  the reviewer prompts.
- `review/review_input_manifest.json` records the closed, ordered input
  inventory with byte lengths and SHA-256 bindings.
- `review/review_gate_report.json` binds the exact deterministic minimum gate
  and input-manifest bytes.
- `review/review_assurance.json` records the deterministic/model assurance
  outcome and its gate and manifest bindings.
- `review/review_handoff.json` binds the exact assurance, pre-draft critique,
  review decision, and review packet consumed downstream.

The runtime validates the input manifest before dispatching any specialist.
`write_paper` revalidates the complete chain before drafting. A changed
bound upstream input,
critique, decision, packet, assurance, or binding invalidates the handoff and
requires a fresh review. Downstream nodes preserve the review-bound upstream
artifacts; a drafting-time research-mode check is written separately as
`paper/research_mode_guard_reassessment.json`.

## `ModelReviewBundle` field contract

The bundle is a strict JSON sidecar supplied to `research review` with
`--model-review <model-review-bundle.json>`. The validator rejects unknown
fields. Supporting prompts, raw responses, manifests, and execution receipts
may remain as separately hash-bound artifacts, but they are not inserted into
the strict bundle shape.

### Top-level fields

| Field | Requirement |
| --- | --- |
| `schema_version` | Must equal the supported protocol version, currently `1.0`. |
| `artifact_type` | Must equal `ModelReviewBundle`. |
| `gate_report` | Exact `GateReport` binding with only `artifact_id` and `sha256`. |
| `policy` | Three literal-false authority safeguards defined below. |
| `reviewers` | Between five and 32 independent specialist records, with every required role present. The governed standard uses exactly one record for each of the five roles. |
| `adjudicator` | One separately executed meta-review record with `role=meta_reviewer`. |

### Gate and input binding

`gate_report.sha256` is computed from the exact `GateReport` bytes supplied to
`--gate`, not from a reconstructed object. `gate_report.artifact_id` must match
that artifact. A mismatch invalidates the complete model review.

New `research:audit` outputs bind each available reviewed input by portable
path, SHA-256, and byte length in `EvidenceBundle.files` and
`GateReport.input_bindings`. External intake records the same bindings in
`external-intake-manifest.json`, together with portable source-to-copy alias
mappings. `GateReport.evidence_bundle_sha256` binds the exact serialized
`EvidenceBundle` bytes. The `EvidenceBundle` and `GateReport` artifact IDs
therefore change when a copied manuscript, result, citation-status file, or
other audited input changes. Older gate artifacts without `input_bindings` or
the evidence-bundle digest remain parseable for compatibility, but must be
regenerated before a new paper-scale review.

Each reviewer's `provenance.input_sha256` declares the hash of the exact bytes
dispatched to that execution. Initial role envelopes may differ in role
instructions, but they must contain the same immutable evidence inventory and
exact gate binding; none may contain peer output. Because the strict bundle
does not embed the initial prompt bytes, verifying those specialist input
hashes requires the separately retained execution receipts. The strict
validator does recompute the meta reviewer's `input_sha256` from the gate
binding and the deterministically ordered specialist output hashes. If the
gate or reviewed input changes, rerun the complete panel.

### Policy fields

`policy` has exactly these fields, each set to literal `false`:

| Field | Meaning |
| --- | --- |
| `consensus_is_evidence` | Agreement among models is not external or experimental evidence. |
| `may_override_deterministic_gate` | Model findings cannot remove or waive an `A0` decision. |
| `may_create_external_evidence` | Models may locate and bind existing evidence but cannot create missing evidence. |

### Model and execution provenance

Each object in `reviewers` has exactly `reviewer_id`, `role`, `provenance`, and
`findings`. `role` must be one of the five required specialist roles. The
`adjudicator` has the same shape, with `role=meta_reviewer`. Reviewer IDs and
execution IDs must be unique across specialists and the adjudicator.

`provenance` has exactly these fields:

| Field | Requirement |
| --- | --- |
| `actor` | Must equal `model`; this prevents a model artifact from being labeled human. |
| `provider` | Effective provider used for the execution. |
| `model` | Effective model identifier. Public protocol examples never hardcode a provider-specific model name. |
| `reasoning_effort` | Effective reasoning tier used for the execution. |
| `execution_id` | Unique portable execution identifier linked to the execution receipt or log. |
| `context_isolated` | Must be `true`. For specialists this attests that no peer output was present; for the adjudicator it means a distinct follow-up execution. |
| `input_sha256` | SHA-256 of the exact execution input envelope. |
| `output_sha256` | Canonical SHA-256 of `reviewer_id`, `role`, and the normalized `findings`; the validator recomputes this digest. Preserve the raw response separately when exact provider-output replay is required. |

The execution receipt referenced by `execution_id` should record the
availability snapshot, strongest-available model selection, highest-available
reasoning selection, dispatch timing, tool/source-access policy, attempt
status, and any fallback reason. The effective `provider`, `model`, and
`reasoning_effort` in the bundle must match that receipt. Receipt verification
is an orchestration responsibility because receipts are not embedded in the
strict bundle; the bundle validator cannot independently prove provider
routing or execution isolation. A silent routing downgrade invalidates the
paper-scale review.

Each `findings` entry requires `code`, `severity` (`blocker` or `warning`),
`message`, and portable `evidence_refs`. It may also include `target_node`,
`target_surface`, and `recheck_condition`.
`target_surface` is limited to `prompt`, `skill`, `validator`, `policy`,
or `runtime`; this lets the meta harness route a systemic enforcement defect
without changing the fixed top-level node contract.

All specialist records remain intact in the bundle after adjudication. The
adjudicator must emit a finding for every adopted blocker or warning and every
material conflict, cite the relevant specialist evidence references, state
whether a conflict is resolved, and preserve unresolved positions as blockers
or warnings. `ReviewReport` imports only these adjudicated findings; raw
specialist findings remain inspectable in `ModelReviewBundle` and are not
duplicated automatically into readiness or repair targets. Model consensus
cannot replace evidence, and reconciliation never deletes a specialist record
from the bundle.

### `ReviewReport` assurance projection

`research review` projects the accepted sidecar into
`ReviewReport.reviewer_assurance`:

| Field | Contract |
| --- | --- |
| `tier` | `A0_deterministic` without a model sidecar; `A2_model_conservative` only after a valid bundle is accepted. |
| `adjudication_policy` | `deterministic_only` for `A0`; `meta_findings_only` for `A2`. |
| `panel_size` | Zero for `A0`; otherwise the accepted specialist count. |
| `specialist_finding_count` | Total raw findings retained across the specialist records. |
| `adjudicated_finding_count` | Findings emitted by the meta reviewer and imported into `ReviewReport`. |
| `model_review_bundle_sha256` | `null` for `A0`; otherwise the SHA-256 of the exact supplied bundle bytes. |
| `independent_contexts` | `true` only when every bundle record declares isolated execution and has a unique execution ID. This is a validated bundle assertion, not cryptographic proof of provider isolation. |
| `adjudicator_present` | `true` only when the distinct meta reviewer is present and valid. |
| `can_promote` | Always `false`. |
| `can_downgrade` | Always `true`. |
| `human_authority` | Always `false`. |
| `limitations` | Non-empty statements of the remaining model-review boundary. |

The `ReviewReport.claim_ceiling` remains the deterministic ceiling. Model
blockers or warnings may lower the verdict/readiness projection, but model
findings cannot raise it.

For schema-version compatibility, a previously generated `ReviewReport` that
does not contain `reviewer_assurance` is interpreted as previous-version
deterministic review with no model-panel assurance. The validator also accepts
the prior assurance shape without the three adjudication/count fields. Every
newly generated report records the current fields explicitly; absence never
implies `A1`, `A2`, independent contexts, or human authority.

## Candidate, reference, and license review

Candidate, reference, and license work may use automated model screening or
model adjudication. Such records remain `A1` or `A2`, identify the reviewer as a
model, and never populate human identity, human attestation, or human approval
fields.

- Candidate screening may propose labels, exclusions, conflicts, or escalation
  targets. Preserve model disagreements and keep human-required decisions open.
- Citation review must read the cited full text directly. Record the full-text
  artifact hash and a precise evidence location such as page, section, table,
  figure, or paragraph. Abstract-only or metadata-only inspection cannot mark a
  citation claim supported.
- License screening may record only existing direct public license evidence,
  including its public location and content hash. In the absence of direct
  public license evidence, classify the material conservatively as
  `local_only` or `uncertain`; never infer redistribution permission from
  metadata, convention, or silence.

Model screening can locate and bind existing evidence. It cannot create the
external evidence, legal authority, or permission that the gate requires.

## Execution and verification procedure

1. Run `A0` validation and freeze the exact gate and closed input manifest.
   The manifest must include the exact `EvidenceBundle` and every path in
   `GateReport.input_bindings`; omission of any bound input invalidates A2
   review.
2. Record the model availability snapshot and selected provider, model, and
   reasoning tier in execution receipts before dispatch.
3. Dispatch the five initial roles in one parallel group with peer-output
   sharing disabled, unique execution IDs, and `context_isolated=true`.
4. Validate each output's schema, role uniqueness, gate binding, declared
   provenance, isolation assertion, and recomputed normalized-output digest.
   Verify specialist input hashes and effective routing against retained
   receipts outside the strict bundle.
5. Dispatch the meta reviewer only after all five initial outputs pass those
   checks. Compute its `input_sha256` over the gate binding and exact ordered set
   of specialist output hashes.
6. Assemble the strict bundle and run its deterministic schema, policy,
   independence, and expected-gate validation before importing any finding.
7. Verify operational receipts: strongest-available routing, initial
   non-sharing, meta input binding, output hashes, disagreement preservation,
   adopted meta findings, and the monotone `A0`/`A2` ceiling. Confirm that the
   gate input bindings still match the reviewed bytes.
8. Pass the valid sidecar with
   `research review --gate <gate-report.json> --model-review <model-review-bundle.json>`.
   Verify that `reviewer_assurance` binds the exact bundle hash and keeps
   `can_promote=false`, `can_downgrade=true`, and `human_authority=false`. An
   invalid or partial panel stays non-promoting `A1` evidence.
9. If human review or final approval is required, create a separate `A3`
   handoff. Never generate the human review or final approval.

## Invalid bundle conditions

A `ModelReviewBundle` is invalid when any of the following holds:

- a required role is absent, duplicated, or not independently executed
- an initial prompt or input contains another initial reviewer's output, or
  `context_isolated` is not `true`
- the supplied gate artifact ID or exact-byte SHA-256 differs
- the exact `EvidenceBundle` is omitted, its digest differs, any
  `GateReport.input_bindings` path is omitted, or a present reviewed input is
  marked optional
- model, provider, reasoning, or execution provenance is missing
- the meta reviewer did not bind all five validated output hashes in its input
- a disagreement was discarded or silently collapsed
- an `A0` blocker was removed or the deterministic ceiling was raised
- model output is represented as human review, attestation, final approval, or
  legal/redistribution permission
- citation support lacks direct full-text reading and a bound evidence location
- redistribution is allowed without direct public license evidence
- any strict bundle object contains unknown or misspelled fields
