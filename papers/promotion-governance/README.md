# Promotion Governance Pre-Confirmatory Manuscript

## Status

This manuscript is a protocol and development-validation draft. It is not a
submission-ready empirical paper. The primary target is an archival long paper
at REALM 2026, the Second Workshop for Research on Agent Language Models at
EMNLP 2026. The workshop accepts up to eight content pages, requires the ACL
2026 style, and lists a direct-submission deadline of 2026-08-05 Anywhere on
Earth as checked on 2026-07-18.

Current blockers:

- no 72-base independently curated confirmatory corpus,
- no 720-case held-out confirmatory suite,
- no artifact-verified execution provenance for 72 source-hash-distinct bases,
- no completed double-human candidate review or source-license decision,
- no completed canonical curation and independent verification,
- no double-adjudicated held-out labels,
- no independent mutation-isolation audit,
- no three-trial paper-eligible real-model manuscript-only baseline,
- no paper-scale post-repair recovery evaluation,
- 12 citation-bearing claims have hash-bound full-text evidence candidates but
  remain independently unchecked in Refgate,
- 2 OpenReview citation-bearing claims still lack full-text source files,
- no citation-bearing claim has been promoted to `checked`.

`reference-evidence-status.json` records the portable source hashes, claim
coverage, missing sources, and the fail-closed review state. It does not package
third-party PDFs.

## Independent Reference Review

`reference-review-handoff/` binds the 12 mapped full-text candidates to the
current claim TSV, evidence status, and Refgate lock hashes. Give an independent
reviewer only `reference-review-handoff/reviewer/`. The included template is
incomplete by construction: its reviewer identity and decisions are null, and
all human and independence attestations are false.

To reproduce the handoff in a fresh output directory:

```bash
node dist/cli/main.js reference-review prepare \
  --claims papers/promotion-governance/refgate_claims.tsv \
  --status papers/promotion-governance/reference-evidence-status.json \
  --lock papers/promotion-governance/refgate.lock.json \
  --out-dir <new-reference-review-handoff>
```

When the reviewer should receive an offline, hash-bound copy of the already
mapped full texts, place exactly one `<citation-key>.pdf` or
`<citation-key>.txt` file per mapped source in a private source directory and
create a closed distribution:

```bash
node dist/cli/main.js reference-review distribute-private \
  --packet papers/promotion-governance/reference-review-handoff \
  --source-dir <private-citation-key-named-full-text-dir> \
  --out-dir <new-private-reference-review-distribution>
```

This command rejects missing, ambiguous, symlinked, or hash-mismatched sources.
Its manifest fixes `public_distribution_allowed=false` and
`license_review_status=not_assessed`; the resulting directory must not enter a
public source snapshot without a separate license review. The original two
missing-source claims remain absent rather than being filled from abstracts.
The private packet's `reviewer/SOURCE_README.md` lists their citation keys,
titles, public record URLs, and blocked claim IDs so source collection remains
explicitly separate from human claim review. The public verification receipt is
`docs/research/evidence/promotion-reference-review-handoff-v2.json`; it records
hashes and gate outcomes, not the third-party full texts.

Preflight a returned human review separately:

```bash
node dist/cli/main.js reference-review preflight \
  --packet <handoff-or-private-distribution-dir> \
  --review <completed-human-review.json> \
  --out-dir <new-reference-review-preflight>
```

Preflight verifies exact task coverage, packet hashes, decision-specific
evidence, and the reviewer's attestations. It does not verify real-world
identity and never modifies Refgate claim status. Even a fully supported return
still requires explicit final approval and a separate Refgate import. The two
claims without full source text remain outside the task file and continue to
block submission.

## Build

The review manuscript compiles with the vendored official ACL style:

```bash
cd papers/promotion-governance
latexmk -pdf -interaction=nonstopmode -halt-on-error manuscript.tex
```

The source uses `\documentclass[11pt]{article}`, `\usepackage[review]{acl}`,
and `acl_natbib`. Current ACL references are author--year entries rather than a
numbered list. There is no keyword block. The generic lowercase `acl` package
is the current official style; `ACL2023` is a retired year-specific filename
and is deliberately not substituted. The unmodified vendored files come from
official commit `d5adc823ff0f80f98c80405ca0ab66c68e684409`:

- `acl.sty`: `19dfeddc2c0e448f3926a0bef048a9db3f3611b46265b760caabd7ada4f361de`
- `acl_natbib.bst`: `6fbb306202290f4b68e74ac1460a8b27398500cb6dfeb4492e74c457eae7cd1e`

## Development Reproduction

Use a fresh temporary directory because corpus and suite builders refuse to
overwrite existing outputs:

```bash
npm run build
WORKDIR=$(mktemp -d)
node dist/cli/main.js governance-benchmark generate-promotion-development --out-dir "$WORKDIR/corpus"
node dist/cli/main.js governance-benchmark build-promotion --recipe "$WORKDIR/corpus/recipe.json" --out-dir "$WORKDIR/suite"
node dist/cli/main.js governance-benchmark run-promotion --suite "$WORKDIR/suite/suite.json" --out-dir "$WORKDIR/predictions"
node dist/cli/main.js governance-benchmark run-promotion-development-recovery --suite "$WORKDIR/suite/suite.json" --predictions "$WORKDIR/predictions/predictions.jsonl" --system-run-manifest "$WORKDIR/predictions/system-run-manifest.json" --repaired-suite-id development-repaired-suite --repaired-trial-id development-post-repair --out-dir "$WORKDIR/recovery"
node dist/cli/main.js governance-benchmark score-promotion --suite "$WORKDIR/suite/suite.json" --predictions "$WORKDIR/predictions/predictions.jsonl" --out-dir "$WORKDIR/score"
```

The generated suite must report `paper_claim_eligible=false`, the score must
report `paired_analysis.exploratory_only=true`, and the recovery summary must
report `development_evidence_verified=true` with
`paper_claim_eligible=false`. The development recovery command uses the paired
clean control as an oracle repair target to validate rerun coverage and metric
arithmetic; it is not evidence of autonomous repair or paper-scale recovery.

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

Complete the paired 72-candidate review campaign with two independent
candidate reviewers and a distinct source-license reviewer. Only a passing,
revision-matched adjudication can prepare canonical curation. Distinct human
curator and verifier roles must then produce 72 schema-validated canonical
bundles before confirmatory intake can admit anything.

Create a local manifest for at least 72 source-hash-distinct canonical bundles,
then freeze it before building the suite:

```bash
node dist/cli/main.js governance-benchmark audit-promotion-confirmatory \
  --manifest <intake.json> \
  --out-dir <intake-audit>

node dist/cli/main.js governance-benchmark freeze-promotion-confirmatory \
  --manifest <intake.json> \
  --out-dir <frozen-corpus>

node dist/cli/main.js governance-benchmark build-promotion \
  --recipe <frozen-corpus/recipe.json> \
  --freeze-manifest <frozen-corpus/frozen-intake-manifest.json> \
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
  "mutation_isolation_status": "unreviewed",
  "execution_provenance_status": "artifact_verified"
}
```

Each source must include a hash-bound `execution-evidence.json` covering run
configuration, events, metrics, review decision, command, and execution log.
The audit rejects incomplete roles, non-real modes, failed exits, fewer than
three distinct trials, hash drift, and duplicate run identities or execution
fingerprints. This verifies the declared artifact record, not the real-world
occurrence or operator independence of an execution. The freezer also does not
sanitize source content. All provisional labels remain `needs_review`;
freezing never grants paper-claim eligibility.

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
`double_verified`, execution provenance is `artifact_verified`, and the
external-real-run, held-out, 72-base, 720-case, and per-base paired-family gates
all pass.
The clean controls must include both promotable and non-promotable adjudicated
outcomes.

The importer rejects declared mutation-auditor IDs that overlap label
adjudicator IDs. These pseudonyms do not establish real-world identity, so the
confirmatory study must retain an external role-assignment record.

Real provider requests must be exported through the blind prompt pack; only
`requests.jsonl` may enter provider context.
