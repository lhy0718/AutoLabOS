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

Each suite also declares an evidence class, paper-claim eligibility, and
adjudication status. A recipe with `paper_claim_eligible=true` is rejected
unless `adjudication_status=double_adjudicated`.

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
evaluated system. Human adjudicators should verify that each mutation introduces
only the declared fault family.

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

Its `corpus-manifest.json` sets `paper_claim_eligible=false` and
`adjudication_status=unreviewed`. It must not be reported as confirmatory
evidence.

The builder refuses existing output directories, paths outside the recipe
root, symbolic links, duplicate case IDs, and base-bundle split leakage. The
loader verifies artifact hashes before scoring.

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
