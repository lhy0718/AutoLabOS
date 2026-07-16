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
- no independent mutation-isolation audit,
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

Create a local manifest for at least 20 independently sourced canonical
bundles, then freeze it before building the suite:

```bash
node dist/cli/main.js governance-benchmark freeze-promotion-confirmatory \
  --manifest <intake.json> \
  --out-dir <frozen-corpus>

node dist/cli/main.js governance-benchmark build-promotion \
  --recipe <frozen-corpus/recipe.json> \
  --out-dir <confirmatory-suite>
```

The freezer rejects duplicate source hashes and bundles that cannot support
all nine fault mutations. It derives opaque base IDs from source hashes and
does not copy local source IDs or original source paths into its manifest. The
resulting recipe must declare:

```json
{
  "evidence_class": "external_real_run",
  "paper_claim_eligible": false,
  "adjudication_status": "unreviewed",
  "mutation_isolation_status": "unreviewed"
}
```

This stage does not establish that the bundles came from real executions.
`external_real_run` is an operator attestation that must be checked against the
preserved run records and raw evidence. The freezer also does not sanitize
content already inside a source bundle. All provisional labels remain
`needs_review`; freezing never grants paper-claim eligibility.

First export the built suite with `export-promotion-mutation-audit`. Give each
mutation auditor only the generated `mutation-auditor/` directory and collect
exactly two full-coverage files under distinct pseudonymous IDs. Verify them
with `verify-promotion-mutations`; any confounded case blocks progression and
routes the mutation operator to `design_experiments`.

Separately export the suite with `export-promotion-annotations`, collect
exactly two independent full-coverage human label files, and import them with
`adjudicate-promotion --mutation-audit-report <report.json>`. A third
independent resolver is mandatory for every label disagreement. Give the label
adjudicator only the exported `annotator/` directory,
which contains the opaque tasks, rubric, and artifact directories. The sibling
private map, recipe, mutation metadata, provisional gold, and system predictions
stay hidden. The importer, rather than a hand-edited
recipe, sets `adjudication_status=double_adjudicated` and promotes
`paper_claim_eligible=true` only after the mutation audit is
`double_verified` and the external-real-run, held-out, 20-base, 200-case, and
per-base paired-family gates all pass.
The clean controls must include both promotable and non-promotable adjudicated
outcomes.

The importer rejects declared mutation-auditor IDs that overlap label
adjudicator IDs. These pseudonyms do not establish real-world identity, so the
confirmatory study must retain an external role-assignment record.

Real provider requests must be exported through the blind prompt pack; only
`requests.jsonl` may enter provider context.
