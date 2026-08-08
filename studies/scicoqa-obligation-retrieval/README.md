# Obligation-Guided Retrieval for Paper-Code Audits

## Status

`HOLD_EXTERNAL_PROVIDER_AUTHORIZATION`. Access, fresh materialization, and
deterministic development are complete under `freeze-receipt.v3.json`. The
frontier systems have not run because paper text and repository content may be
sent to a paid external API only after explicit data-egress and cost approval.
Confirmatory gold remains sealed.

This study asks whether implementation obligations extracted from a paper can
retrieve discrepancy-bearing code files more reliably than outcome-blind
whole-paper retrieval under an equal code-token budget. The experimental unit
is a paper, not a discrepancy or file.

The v2 outcome-blind access preflight found 86 eligible pairs against the frozen
floor of 80. A fresh-download materialization retained all 86 independent
paper/repository components: eight development units, seventy-two sealed
confirmatory units, and six reserves. No download failed and no duplicate
component was found. The blind manifest binds the bytes of every extracted paper
and mutated repository tree. Gold discrepancy fields remain unavailable to
retrieval code and method development.

The current v3 deterministic development evaluation reports macro changed-file
recall of 0.6563 for alphabetical
selection, 0.7604 for generic hybrid retrieval, 0.8021 for deterministic
obligations, 0.8021 for methods-only BM25, and 0.8438 for whole-paper BM25.
Deterministic obligations therefore do not satisfy the promotion rule.

The only authorized next execution is the frozen equal-call development
comparison between generic frontier selection and frontier obligation-guided
selection with `gpt-5.6-sol` at `high` reasoning. A real Responses API credential
is required. Codex OAuth and `codex_mock` outputs are not paper-grade evidence.
The candidate is terminated unless frontier obligations exceed the strongest
non-oracle baseline by at least 0.10, improve on at least five of eight papers,
and beat the methods, hybrid, and generic frontier comparators.

## Candidate Contribution

The residual claim is deliberately narrow: paper-derived implementation
obligations may improve file localization for paper-code consistency audits
under a fixed context budget. It is not a claim that retrieval-augmented
generation is new, that synthetic discrepancies estimate natural prevalence,
or that file retrieval alone constitutes automated peer review.

## Source Boundary

- SciCoQA code revision and synthetic dataset are recorded in
  `corpus/source.v1.json`.
- Dataset rows are CC BY 4.0; upstream repositories were selected by SciCoQA
  from permissively licensed projects.
- Paper PDFs and repository archives are fetched into an ignored local cache
  and are not redistributed by this study.
- Gold discrepancy fields are unavailable to access selection and method
  development. They are used only by the frozen evaluator.

## Execution Governance

- Materialization rejects a dataset whose SHA-256 differs from either the
  source registry or access receipt.
- Paper-grade frontier calls require an empty provider-cache location. Any
  existing cache entry is rejected rather than replayed. A successful fresh call
  records the canonical request, complete raw provider response, model identity,
  usage, latency, and content hashes in the canonical split execution receipt.
  Frontier evaluation and promotion both reject a prediction whose seal is not
  bound to that receipt and its complete frozen unit-by-system call grid.
- Every prediction file is sealed before evaluation. Confirmatory execution
  additionally requires a development `PROMOTE` receipt derived by
  `scripts/decide_development_promotion.py`. Validation reopens every bound
  prediction and seal, recomputes both development evaluations from sealed gold,
  and then recomputes the frozen gate. Self-authored evaluation scores cannot
  authorize confirmation.
- Each split has a physically separate gold directory and hash-bound manifest.
  Confirmatory evaluation uses one canonical lock manifest at
  `results/confirmatory-evaluation.lock.json`. Both frozen prediction kinds must
  be registered there before either evaluator may read confirmatory gold; the
  first registration therefore fails closed until the second kind is sealed.
  Callers cannot derive or redirect the lock from a supplied gold path.
- The current runners require the canonical v3 freeze receipt and experiment
  contract, then verify their own code and shared retrieval/governance code
  hashes before execution.

## Current Evidence

- `results/materialization-preflight.v2.json`: 86/86 materialized, zero failures,
  86 independent components.
- `corpus/blind-manifest.v1.jsonl`: paper-text and mutated-repository tree hashes
  for every development, confirmatory, and reserve unit.
- `results/development-deterministic-rankings.v3.json`: 40 predictions from five
  deterministic systems across eight development papers.
- `results/development-deterministic-predictions-seal.v3.json`: schema-v2
  deterministic-kind, contract, manifest, split, and prediction binding.
- `results/development-deterministic-evaluation.v3.json`: evaluation recomputed
  from the sealed development-gold manifest under canonical freeze-v3
  enforcement.
- `method/freeze-receipt.v3.json`: transparent post-development integrity
  amendment; confirmatory outcomes were not observed and scientific thresholds
  were not changed.
