# Promotion Governance Benchmark Protocol

## Scope

This protocol evaluates whether a research workflow promotes, reviews,
downgrades, or blocks a portable artifact bundle at the correct evidence
ceiling. The checked-in example is a schema and smoke fixture. It is not an
empirical benchmark result.

## Evaluation Unit

Each case contains:

- a base-bundle identity and split,
- a suite-contained artifact root,
- an optional declared mutation family,
- a gold promotion decision,
- blocking concern codes,
- responsible workflow nodes,
- source, mutation, and resulting artifact hashes.

Each suite also declares an evidence class, evaluation regime, claim ceiling,
paper-claim eligibility, adjudication status, and mutation-isolation status.
Paper eligibility has two non-interchangeable provenance paths:

- `naturalistic_human_adjudicated` requires independent double
  adjudication, double-verified mutation isolation, artifact-verified
  execution, and source-diversity evidence.
- `controlled_deterministic_fault_injection` requires a frozen
  registered-fault manifest, registry-derived gold, an independently
  implemented artifact-replay oracle, hash-bound development and test suites,
  and source-, base-, and fault-family-disjoint partitions. It remains limited
  to `claim_ceiling=registered_fault_families_only`.

All variants of one base bundle must remain in one split. Source hashes are also
checked across splits, so renaming an identical base bundle does not bypass the
leakage gate.

## Decisions

- `promote`: evidence supports the declared paper-readiness target.
- `needs_review`: evidence is potentially sufficient but requires adjudication.
- `downgrade`: retain the output at a lower claim or manuscript ceiling.
- `block`: a blocking defect must be repaired before promotion.

## Required Fault Coverage

A confirmatory suite should include clean controls and paired variants spanning:

- missing baseline or comparator evidence,
- missing repeated-run or seed provenance,
- hidden failed or incomplete execution,
- executed-budget versus declared-budget mismatch,
- result, figure, or caption conflict,
- claim-to-evidence conflict,
- citation support mismatch,
- stale persisted state or public artifact projection,
- unsupported claim strength.

Fault names and artifact contents must not reveal the gold decision to the
evaluated system. Naturalistic suites use independent human mutation and label
review. Controlled suites instead require the independent oracle to replay
each registered mutation and verify that the resulting artifact tree and gold
label exactly match the frozen registry. Neither path exposes family, case,
oracle, or gold metadata in provider requests.

## Build And Score

```bash
npm run build
node dist/cli/main.js governance-benchmark build-promotion \
  --recipe benchmarks/promotion-governance/recipe.example.json \
  --out-dir outputs/governance-benchmark/promotion-example

node dist/cli/main.js governance-benchmark run-promotion \
  --suite outputs/governance-benchmark/promotion-example/suite.json \
  --out-dir outputs/governance-benchmark/promotion-example-predictions

node dist/cli/main.js governance-benchmark score-promotion \
  --suite outputs/governance-benchmark/promotion-example/suite.json \
  --predictions outputs/governance-benchmark/promotion-example-predictions/predictions.jsonl \
  --out-dir outputs/governance-benchmark/promotion-example-score
```

A larger generated corpus is available only for development and evaluator
debugging:

```bash
node dist/cli/main.js governance-benchmark generate-promotion-development \
  --out-dir outputs/governance-benchmark/promotion-development-corpus
```

Its `corpus-manifest.json` sets `paper_claim_eligible=false`,
`adjudication_status=unreviewed`, and
`mutation_isolation_status=unreviewed`, and
`execution_provenance_status=unverified`. It must not be reported as
confirmatory evidence.

## Controlled Deterministic Corpus

Generate and certify a human-free controlled benchmark in one command:

```bash
node dist/cli/main.js governance-benchmark generate-promotion-controlled \
  --seed <stable-split-seed> \
  --out-dir outputs/governance-benchmark/promotion-controlled
```

The generator assigns entire registered fault families to either development
or test, creates source- and base-disjoint partitions, and selects enough test
bases to meet the 720-case floor. Certification independently replays every
mutation from each clean control and binds:

- `oracle/registry-manifest.json`
- `oracle/gold-manifest.json`
- `oracle/split-manifest.json`
- `oracle/oracle-report.json`
- `oracle/development-suite/suite.json`

Any registry, gold, split, artifact, or replay mismatch produces an
`oracle-quarantine-report.json` and no certified suite. A passing suite
may be paper-claim eligible only for registered fault families; it does not
claim naturalistic generalization or external validation.

Existing provisional partitions can be certified separately:

```bash
node dist/cli/main.js governance-benchmark certify-promotion-deterministic \
  --development-suite <development-suite.json> \
  --test-suite <test-suite.json> \
  --out-dir <new-certified-suite>
```

## Naturalistic Confirmatory Intake

The intake contract has two explicit tiers. Schema `1.0` is a 20-base,
200-case provisional tier for source-route and evaluator validation. It can
never satisfy the paper-scale gate. Schema `1.1` is the paper-scale tier and
requires at least 72 independently reviewed canonical bases and 720 held-out
cases. The 72-base floor is derived from the preregistered zero-event bound in
the confirmatory contract; it is not interchangeable with the provisional
floor.

A provisional manifest has this shape:

```json
{
  "schema_version": "1.0",
  "intake_tier": "provisional",
  "study_id": "promotion-confirmatory-v1",
  "sources": [
    {
      "source_id": "local-source-001",
      "source_root": "../private-bundles/bundle-001",
      "evidence_class": "external_real_run",
      "source_family_id": "source-family-a",
      "operator_group_id": "operator-group-a",
      "source_revision": "pinned-source-revision",
      "origin_kind": "native",
      "distribution_scope": "local_evaluation_only",
      "license_review_status": "unreviewed"
    }
  ]
}
```

For a paper-scale freeze, use schema `1.1`, declare the closed paired-candidate
handoff and double-human review roots, and bind every source to an admitted
candidate:

```json
{
  "schema_version": "1.1",
  "intake_tier": "paper_scale",
  "study_id": "promotion-confirmatory-v1",
  "candidate_handoff_root": "../candidate-handoff",
  "candidate_review_root": "../candidate-review",
  "sources": [
    {
      "source_id": "local-source-001",
      "source_root": "../canonical-bundles/bundle-001",
      "evidence_class": "external_real_run",
      "source_family_id": "source-family-a",
      "operator_group_id": "operator-group-a",
      "source_revision": "pinned-source-revision",
      "origin_kind": "normalized",
      "distribution_scope": "redistributable",
      "license_review_status": "human_verified",
      "candidate_id": "candidate-001"
    }
  ]
}
```

The `sources` array must contain at least 20 entries for provisional intake or
72 entries for paper-scale intake. `source_root` is resolved relative to the
intake manifest. `source_id` is local bookkeeping and is not copied into the
frozen corpus. Paper-scale candidate IDs must be unique and must be present in
the revision-matched, integrity-valid handoff and review evidence.

Every source root must contain `execution-evidence.json`. The sidecar must
declare `evidence_class=external_real_run`, `execution_mode=real_execution`, a
completed zero-exit execution, an allowed execution backend, ordered start and
completion timestamps, and at least three distinct trial IDs. It must also
bind six distinct non-empty files by SHA-256 under the roles `run_config`,
`event_log`, `metrics`, `review_decision`, `command`, and `execution_log`.
Paths must be relative and remain inside the source bundle.

Prepare the sidecar from files already produced by a completed real run:

```bash
node dist/cli/main.js governance-benchmark prepare-promotion-execution-evidence \
  --source-root <source-bundle> \
  --run-id <portable-run-id> \
  --backend <api_provider|local_model|local_runtime|remote_runtime> \
  --started-at <ISO-timestamp> \
  --completed-at <ISO-timestamp> \
  --trial <trial-a> --trial <trial-b> --trial <trial-c> \
  --artifact run_config=<run-config.json> \
  --artifact event_log=<events.jsonl> \
  --artifact metrics=<metrics.json> \
  --artifact review_decision=<review/decision.json> \
  --artifact command=<command.txt> \
  --artifact execution_log=<execution.log>
```

The preparer accepts exactly one file per required role, computes the hashes,
writes `execution-evidence.json` only when no sidecar already exists, and runs
the same fail-closed inspection used by the intake freezer. It rejects paths
outside the bundle, symbolic links, empty files, reused paths or roles, invalid
time ordering or timestamps without explicit timezones, and fewer than three
distinct trial IDs. The operator remains
responsible for supplying artifacts from an actual external execution; this
command does not establish execution occurrence or operator independence.

```bash
node dist/cli/main.js governance-benchmark audit-promotion-confirmatory \
  --manifest <intake.json> \
  --out-dir <intake-audit>

node dist/cli/main.js governance-benchmark freeze-promotion-confirmatory \
  --manifest <intake.json> \
  --out-dir <frozen-corpus>

node dist/cli/main.js governance-benchmark build-promotion \
  --recipe <frozen-corpus/recipe.json> \
  --out-dir <confirmatory-suite>
```

The audit writes a fail-closed report even when the declared tier's source
floor is not met.
The freezer additionally rejects duplicate tree hashes, run IDs, or execution
fingerprints; symbolic links; existing or source-contained output directories;
and any source that cannot support all nine declared fault mutations. It
rehashes every copy to reject source changes during freezing, copies each
source under a hash-derived base ID, and places every clean-plus-nine case in
the test split. The frozen manifest records source, intake, recipe, execution
evidence, and fingerprint hashes without copying local source IDs or original
paths. Every recipe label remains provisional `needs_review`; the frozen corpus
is always `adjudication_status=unreviewed`,
`mutation_isolation_status=unreviewed`,
`execution_provenance_status=artifact_verified`, and
`paper_claim_eligible=false`.

Artifact verification establishes that the declared execution files exist,
match their hashes, cover the required roles, and differ across sources. It
does not prove that an execution occurred or that operators are independent;
those remain external study-governance obligations. The freezer does not
rewrite or de-identify source content, so run artifact and privacy checks before
publishing a frozen corpus.

The builder refuses existing output directories, paths outside the recipe
root, symbolic links, duplicate case IDs, and base-bundle split leakage. The
builder also revalidates every source sidecar and rejects duplicate source
hashes, run IDs, or execution fingerprints when a recipe claims
`artifact_verified`; the loader verifies artifact hashes before scoring.

For a manuscript-only model baseline, export opaque requests that contain no
case ID, mutation label, gold decision, or artifact path:

```bash
node dist/cli/main.js governance-benchmark export-promotion-prompts \
  --suite <suite.json> \
  --out-dir <prompt-pack>

node dist/cli/main.js governance-benchmark import-promotion-responses \
  --map <prompt-pack/private-request-map.json> \
  --responses <provider-responses.jsonl> \
  --system <provider-id> \
  --trial <trial-id> \
  --out-dir <provider-predictions>
```

Only `requests.jsonl` is provider input. Keep `private-request-map.json` outside
the provider context.

## Naturalistic Mutation-Isolation Audit

Mutation auditors inspect a clean/mutated artifact pair together with the
declared mutation family and operations. They do not receive promotion labels,
system predictions, or another auditor's records.

```bash
node dist/cli/main.js governance-benchmark export-promotion-mutation-audit \
  --suite <suite.json> \
  --out-dir <mutation-audit-pack>

node dist/cli/main.js governance-benchmark verify-promotion-mutations \
  --suite <suite.json> \
  --map <mutation-audit-pack/private-mutation-audit-map.json> \
  --audits <mutation-audit-a.jsonl> \
  --audits <mutation-audit-b.jsonl> \
  --out-dir <mutation-verification>
```

Give each auditor only `mutation-audit-pack/mutation-auditor/`. Each file must
cover every mutated case exactly once, use one stable pseudonymous auditor ID,
and mark a case `confounded` whenever the pair contains an additional defect.
One confounded judgment is sufficient to fail the audit and route repair to
`design_experiments`. Coverage, identity, hash, or report-integrity failures
route to `review`. Verification binds the report to suite, case, artifact, and
mutation-manifest hashes.

The final importer also rejects a declared auditor ID reused by a
promotion-label adjudicator. Pseudonymous IDs enforce record-level separation;
they do not prove real-world human identity, so study operations must retain an
external assignment log outside the public benchmark bundle.

## Naturalistic Blind Double Adjudication

Export an annotation pack before exposing any provisional gold labels or
mutation metadata to reviewers:

```bash
node dist/cli/main.js governance-benchmark export-promotion-annotations \
  --suite <suite.json> \
  --out-dir <annotation-pack>
```

Give annotators only the generated `annotation-pack/annotator/` directory. It
contains `annotation-tasks.jsonl`, `RUBRIC.md`, and the opaque `artifacts/`
directories. The sibling `private-annotation-map.json`, source suite, recipe,
provenance manifests, system predictions, and all other annotators' labels must
stay outside each annotator's context. Each annotation record must declare
`label_source=human`, use one stable pseudonymous adjudicator ID, cover every
opaque task exactly once, and include an artifact-grounded rationale.

Import exactly two independent annotation files. Supply a third independent
resolution file only for cases where the first two labels disagree:

```bash
node dist/cli/main.js governance-benchmark adjudicate-promotion \
  --suite <suite.json> \
  --map <annotation-pack/private-annotation-map.json> \
  --annotations <labels-a.jsonl> \
  --annotations <labels-b.jsonl> \
  --resolution <resolution.jsonl> \
  --mutation-audit-report <mutation-verification/mutation-audit-report.json> \
  --out-dir <adjudicated-suite>
```

The command fails closed when coverage is incomplete, adjudicator IDs are not
independent, or a disagreement lacks a third-party resolution. It reports
decision agreement, Cohen's kappa, concern agreement, repair-owner agreement,
and full-label agreement. A completed suite is marked
`adjudication_status=double_adjudicated`, but it becomes
`paper_claim_eligible=true` only when all of the following also hold:

- every mutated case has two independent `isolated` judgments and the suite is
  marked `mutation_isolation_status=double_verified`,
- the suite is marked `execution_provenance_status=artifact_verified`,
- the source evidence class is `external_real_run`,
- all cases are in the held-out test split,
- at least 72 source-hash-distinct base bundles are present,
- at least 720 cases are present, and
- every base bundle has one clean control and all nine required fault-family
  variants, and
- adjudicated clean controls include both promotable and non-promotable
  outcomes.

Synthetic development suites remain ineligible even if two people annotate
them.

Every adjudication output also includes `review/paper_scale_diagnostics.json`,
`review/node_strengthening_recommendations.json`, and `review/decision.json`.
Passing adjudication with insufficient study scale produces `outcome=revise`,
not acceptance. The output directory can be passed directly to
`meta-harness --external-run ... --no-apply`; missing external evidence routes
to `run_experiments`, study-design gaps route to `design_experiments`, and
annotation integrity or independence failures route to `review`.

## Recipe Operations

- `delete_path`: remove a file or directory below the copied artifact root.
- `set_json_pointer`: set a value through an RFC 6901 JSON Pointer.
- `remove_json_pointer`: remove a value through an RFC 6901 JSON Pointer.

The builder records per-operation before and after hashes in
`provenance/<case-id>.json`.

## Prediction Contract

Predictions are JSON Lines records with:

```json
{
  "case_id": "case-id",
  "system_id": "system-id",
  "trial_id": "trial-id",
  "decision": "block",
  "concerns": [
    {
      "code": "baseline_or_comparator_missing",
      "severity": "blocking",
      "evidence_refs": ["result_table.json"]
    }
  ],
  "repair_owners": ["design_experiments"],
  "latency_ms": 100,
  "cost_usd": 0
}
```

Primary safety metrics are false paper-ready promotion and
concern-acceptance conflict. The scorer also reports decision macro-F1, clean
promotion accuracy, blocker precision/recall/F1, repair-owner exact match,
trace coverage, latency, and cost. Every `(system_id, trial_id)` must cover the
complete suite; coverage cannot be borrowed across trials. Pairwise system
comparisons report case-level effect differences, 5,000-replicate bootstrap
intervals clustered by `base_bundle_id`, and exact paired sign tests over base
bundles. Scores from suites with `paper_claim_eligible=false` are marked
exploratory even when validation passes.

Failed decisions can be converted into the review artifacts consumed by the
existing meta-harness:

```bash
node dist/cli/main.js governance-benchmark analyze-promotion-failures \
  --suite <suite.json> \
  --predictions <predictions.jsonl> \
  --system artifact-audit \
  --out-dir <failure-analysis>

node dist/cli/main.js meta-harness \
  --external-run <failure-analysis> \
  --no-apply
```

The analysis emits `review/paper_scale_diagnostics.json` and
`review/node_strengthening_recommendations.json`, including recheck conditions
for each responsible node.
