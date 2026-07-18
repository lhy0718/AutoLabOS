# Promotion Benchmark Curation Boundary

## Purpose

The promotion-governance benchmark separates immutable source observations from
benchmark controls created by the research team. This boundary prevents a
generated table, figure, claim map, or readiness decision from being presented
as if it had appeared in the source corpus.

## Provenance Classes

`source_native` contains bytes and fields present in an exact, hash-bound public
source revision. It includes task identities, operator identities, trajectories,
outcomes, patches, and evaluation logs only when those fields occur in the
source.

`source_projected` contains deterministic, integrity-checked projections of
`source_native` records. Projection may redact credentials, assign opaque
reviewer IDs, and select rows under a pre-content rule. It may not invent a
missing result table, figure, claim, citation, or readiness judgment.

`benchmark_curated` contains controls authored for this benchmark after source
selection and independent review. This class may include a canonical comparison
table, controlled figure, claim-to-evidence map, and intended readiness label.
Every curated artifact must identify its curator protocol and bind the exact
source hashes from which it was derived. It must never be accepted by the
source-normalization path as source-reported evidence.

`system_generated` contains outputs produced by a baseline or governed system
during evaluation. It is always evaluated against the frozen benchmark record
and cannot alter the record.

## Immutable Source Rule

Source rows, source outcomes, source operator identities, and source-native task
identities are immutable after the source revision is pinned. Privacy projection
may replace a sensitive literal with an auditable redaction marker, but it may
not change the event sequence, outcome, or comparison membership. Any source
change requires a new versioned handoff and a new integrity manifest.

## Paired Comparison Gate

A source-native task may enter candidate review only when it has at least two
different source operator groups and each group has at least three distinct,
hash-bound rows. Task and operator eligibility must be decided before reading
outcomes or trace content. Primary and comparator groups must use the same
source-native task identity, different operator identities, and disjoint source
row references.

The paper-scale candidate batch requires 72 distinct tasks satisfying this gate.
One operator with repeated rows is useful for a holdout but does not establish a
paired comparison. Row identity alone does not prove independent stochastic
sampling; reviewers must record whether the repeated executions are comparable.

## Human Review Gate

Two independent reviewers must inspect opaque packets without controller
identities. They separately decide:

- whether the two operator groups answer the same task under comparable
  conditions;
- whether all required trace and evaluation fields are present;
- whether privacy projection preserves the substantive evidence;
- whether the item is usable as a controlled benchmark base.

A separate human license reviewer inspects only the pinned source-license
packet and public permission evidence. Candidate reviewers do not receive the
source identity, controller map, or license decision, and the license reviewer
does not receive candidate annotations.

The runtime materializes this separation as an immutable pending review
campaign. Two reviewer package roots receive identical opaque six-trial packet
snapshots but different blank annotation templates; a third package receives
only the source-license packet and an undecided license template. The campaign
controller binds upstream and package-manifest hashes, while its inspector
requires three distinct pseudonymous roles, exact file inventories, null
decisions, and false human attestations. Package preparation is not annotation,
license approval, identity proof, or independence proof.

Returned files must re-enter through the campaign controller boundary. The
collector revalidates the immutable campaign and handoff, binds each return to
the assigned pseudonymous slot and handoff ID, preserves the exact return hash,
and requires the downstream adjudication input hashes to match those preserved
bytes. Unassigned or duplicated reviewer IDs, a mismatched license reviewer,
wrong-handoff returns, symlinks, file changes, and incomplete review content all
fail closed. A valid controller receipt establishes assignment and byte
provenance only; it does not establish real-world identity, expertise,
independence, legal authority, or confirmatory admission.

Progression into canonical curation depends on positive execution completeness
and repeated-trial comparability for every required source candidate, plus the
separate license gate. Source-absent result tables, readiness decisions, figure
audits, and claim links remain availability observations; they are not treated
as source defects or fabricated to make review pass. Canonical curation must
create any required benchmark-owned artifacts under `benchmark_curated`
provenance.

Disagreements require adjudication. Missing or conflicting reviews leave the
item unadmitted. Reviewer identities, decisions, timestamps, and packet hashes
must be preserved in the controller record; no reviewer decision may be
fabricated or inferred from automated checks.

## Canonical Control Gate

Canonical clean controls may be authored only after paired-comparison and human
review gates pass. A curated control must bind:

- the exact primary and comparator source-row hashes;
- a deterministic result-table derivation or an explicit human-authored table;
- a figure and figure audit when a figure is required;
- claim-to-evidence links whose targets are hash-bound artifacts;
- an intended readiness decision and evidence ceiling;
- the curator and adjudicator protocol versions.

Schema `1.1` defines a machine-checkable clean-control surface with 15
hash-bound roles:
result table, experiment evidence, run configuration, run record, evidence
store, design contract, figure audit, review critique, review decision, paper
Results text, paper readiness, claim status, claim evidence, evidence links,
and checkpoint readiness. Integrity alone is insufficient. The curation
inspector cross-checks comparator arithmetic, all six source-trial IDs,
planned/executed budgets, completed run state, figure-audit status, exact claim
IDs and links, evidence-store resolution, SOTA-claim support declarations, and
consistent promotion state across checkpoint, review, and paper artifacts.
These schema checks are independent of the evaluated promotion policy.

The runtime exposes a separate preparation handoff between review and
canonical-source creation. It accepts only a revision-matched, integrity-valid
handoff and adjudication with redistribution permission and at least 72
source-eligible candidates. The packet copies six privacy-projected,
hash-verified traces per task, the 15-role contract, and the upstream handoff
and review receipts. Preparation never emits a canonical source or
`benchmark-curation.json`: its manifest fixes all curation and verification
counts at zero, all human attestations at false, and confirmatory admission at
false. A changed trace, task, guide, contract, or upstream receipt invalidates
the packet.

Curated controls support claims about detection and repair in a controlled
promotion-governance benchmark. They do not support claims about the natural
prevalence of paper-quality failures or the absolute scientific quality of the
underlying agents.

## Admission And Freeze

Confirmatory admission remains zero until all 72 task bases pass the paired
comparison, license, double-review, curation, integrity, diversity, and leakage
checks. The complete candidate set, mutation policy, evaluator, baselines,
metrics, and analysis plan must then be frozen before confirmatory outcomes are
read. A failed gate causes explicit backtracking or downgrade, never cosmetic
paper completion.

The runtime now enforces this boundary through two intake tiers. Schema
`1.0` is normalized to `provisional` and retains a 20-base development
floor. Schema `1.1` is `paper_scale` only and requires an integrity-valid
paired handoff, a revision-matched adjudication directory, redistribution
permission, 72 source-eligible candidate IDs, and one
`benchmark-curation.json` per canonical source. The curation record binds the
six source traces, distinct curator and verifier IDs, protocol versions,
timestamps, intended clean readiness, evidence ceiling, and the fixed
artifact paths used by the mutation contract. Artifact bytes, real paths, and
cross-artifact clean-control semantics are rechecked before freeze.

The end-to-end regression fixture reaches 72 canonical bases and 720 cases to
verify this contract. It is synthetic system-validation evidence and does not
count as a human review, a real corpus freeze, or a paper result.

The current source comparison is recorded in
`docs/research/evidence/promotion-source-portfolio-v2.json`. The v10 handoff
passes the source-native trace and structural paired-comparison candidate
floors. It has no human license decision, independent comparability review,
canonical clean-control curation, or confirmatory freeze, so no v10 task is
admitted.
