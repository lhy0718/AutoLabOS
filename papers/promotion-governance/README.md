# Promotion Governance Research Memo

## Status

This manuscript is a protocol and development-validation memo. It is not a
submission-ready empirical paper. The target venue is the NeurIPS 2026
AutoResearch workshop, whose call requests the official NeurIPS 2026 template.
The workshop deadline and submission details were still tentative on
2026-07-16. Do not substitute an older NeurIPS or ACL style file.

Current blockers:

- fewer than 20 independently sourced base bundles,
- no 200-case held-out confirmatory suite,
- no double-adjudicated held-out labels,
- no three-trial real-provider manuscript-only baseline,
- no post-repair recovery evaluation,
- 14 citation-bearing claims still require full-text source review in Refgate,
- no official NeurIPS 2026 workshop template bundle in this directory.

## Build

The neutral memo compiles independently of a venue template:

```bash
cd papers/promotion-governance
latexmk -pdf -interaction=nonstopmode -halt-on-error manuscript.tex
```

The bibliography uses `unsrt`, so references form one list numbered from 1 in
first-citation order. There is no keyword block and no `ACL2023` package.

## Development Reproduction

Use a fresh temporary directory because corpus and suite builders refuse to
overwrite existing outputs:

```bash
npm run build
WORKDIR=$(mktemp -d)
node dist/cli/main.js governance-benchmark generate-promotion-development --out-dir "$WORKDIR/corpus"
node dist/cli/main.js governance-benchmark build-promotion --recipe "$WORKDIR/corpus/recipe.json" --out-dir "$WORKDIR/suite"
node dist/cli/main.js governance-benchmark run-promotion --suite "$WORKDIR/suite/suite.json" --out-dir "$WORKDIR/predictions"
node dist/cli/main.js governance-benchmark score-promotion --suite "$WORKDIR/suite/suite.json" --predictions "$WORKDIR/predictions/predictions.jsonl" --out-dir "$WORKDIR/score"
```

The generated suite must report `paper_claim_eligible=false`, and the score
must report `paired_analysis.exploratory_only=true`.

The `development/` directory preserves the generated recipe, corpus manifest,
raw predictions, and score outputs used by the development table. The
`pre-strengthening/` subdirectory preserves the earlier score and the generated
failure-to-node recommendations. These files are evaluator-debugging evidence,
not confirmatory benchmark data.

To recompute the checked-in score from the preserved predictions, generate and
build a fresh development suite as above, then run:

```bash
node dist/cli/main.js governance-benchmark score-promotion \
  --suite "$WORKDIR/suite/suite.json" \
  --predictions papers/promotion-governance/development/predictions.jsonl \
  --out-dir "$WORKDIR/recomputed-score"
```

## Confirmatory Boundary

A confirmatory recipe must declare:

```json
{
  "evidence_class": "human_adjudicated_test",
  "paper_claim_eligible": true,
  "adjudication_status": "double_adjudicated"
}
```

The builder rejects paper-claim eligibility without double adjudication. Real
provider requests must be exported through the blind prompt pack; only
`requests.jsonl` may enter provider context.
