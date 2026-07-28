# Reviewer Evaluator Audit

> **Status: terminated research candidate.** The frozen formulation was killed
> before confirmatory analysis after an independent novelty and identifiability
> review. See `method/termination-decision.v1.json`. Partial judge runs are
> quarantined outside the repository and must not be used as evidence.

This study audits whether public scientific-error localization results are
stable under changes to ground-truth granularity, metric implementation, and
evaluator choice. The empirical scope is the pinned public non-ML CS extension
declared in `method/preflight-contract.v1.json`.

The corpus gates passed for a bounded measurement study, but the later
closest-prior and estimator audit invalidated the proposed paper contribution.
The remaining deterministic findings are exploratory software-forensics
observations only.

## Reproduce the corpus audit

Download and extract both pinned archives outside the repository, then run:

```bash
node studies/reviewer-evaluator-audit/scripts/audit-corpus.mjs \
  --config studies/reviewer-evaluator-audit/method/preflight-contract.v1.json \
  --corpus-root "$CACHE_DIR/extracted" \
  --output studies/reviewer-evaluator-audit/preflight/corpus-audit.v1.json
```

The audit verifies the declared counts, required prediction/evaluation cells,
paper overlap, and the amount of unchanged context inside modified ground-truth
blocks. Raw archives and extracted papers are intentionally kept outside the
Git working tree.

## Reproduce the public-output rescore

The version 2 rescore preserves every official `location_error` excerpt in
both reference conditions. The focal condition removes only unchanged context
inside paired `modified_text` blocks.

```bash
node studies/reviewer-evaluator-audit/scripts/rescore-public-predictions.mjs \
  --config studies/reviewer-evaluator-audit/method/preflight-contract.v1.json \
  --corpus-root "$CACHE_DIR/extracted" \
  --output studies/reviewer-evaluator-audit/results/public-rescore.v2.json
```

## Superseded independent-judge plan

The following command documents the superseded reproducibility contract. Do
not execute it as a confirmatory study without a new, independently reviewed
protocol.

```bash
node studies/reviewer-evaluator-audit/scripts/run-independent-judge.mjs \
  --protocol studies/reviewer-evaluator-audit/method/protocol.v1.json \
  --bindings studies/reviewer-evaluator-audit/method/execution-bindings.v1.json \
  --config studies/reviewer-evaluator-audit/method/preflight-contract.v1.json \
  --corpus-root "$CACHE_DIR/extracted" \
  --judge-id judge_lineage_qwen \
  --output studies/reviewer-evaluator-audit/results/judge-lineage-qwen.v1.json
```

The retained code is a reusable, tested runner artifact; it is not evidence
that this terminated topic is paper-worthy.
