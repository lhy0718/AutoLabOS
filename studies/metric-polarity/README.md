# Metric-Polarity Corpus Preflight

This directory records a pre-outcome feasibility audit for a candidate study on
metric-direction reasoning in scientific tables. It is not an experiment result
or a paper claim.

The audit uses the public SciClaimEval shared-task development split pinned at
revision `efb3807399acec43854fdf7741c1bcfe605a72b9`. Raw dataset files remain in
the ignored `.autolabos/research-cache/` workspace and are not committed.

Only `Supported` table examples with exactly one explicit `↑` or `↓` column
marker are eligible. A family is one eligible table column with at least two
named rows and two distinct, strictly parsed scalar values. Multiple row pairs
from the same column are not treated as independent families.

The candidate may proceed only if the audit finds at least:

- 100 eligible table-column families
- 30 source papers
- 20 lower-is-better families

Run:

```bash
node studies/metric-polarity/scripts/audit-corpus.mjs \
  --snapshot .autolabos/research-cache/metric-polarity/sciclaimeval-snapshot \
  --output studies/metric-polarity/preflight/corpus-audit.v1.json
```

The audit is deliberately executed before model inference. A failed gate kills
this formulation instead of lowering the thresholds after observing the corpus.
