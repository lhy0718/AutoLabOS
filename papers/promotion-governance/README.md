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
  "evidence_class": "external_real_run",
  "paper_claim_eligible": false,
  "adjudication_status": "unreviewed"
}
```

Export the built suite with `export-promotion-annotations`, collect exactly two
independent full-coverage human label files, and import them with
`adjudicate-promotion`. A third independent resolver is mandatory for every
disagreement. Give the adjudicator only the exported `annotator/` directory,
which contains the opaque tasks, rubric, and artifact directories. The sibling
private map, recipe, mutation metadata, provisional gold, and system predictions
stay hidden. The importer, rather than a hand-edited
recipe, sets `adjudication_status=double_adjudicated` and promotes
`paper_claim_eligible=true` only after the external-real-run, held-out,
20-base, 200-case, and per-base paired-family gates all pass.
The clean controls must include both promotable and non-promotable adjudicated
outcomes.

Real provider requests must be exported through the blind prompt pack; only
`requests.jsonl` may enter provider context.
