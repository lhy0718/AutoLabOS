# Prior Scope and Residual Claim

## SciCoQA

Baumgartner and Gurevych define paper-code discrepancy detection, release 92
real and 543 synthetic discrepancies, evaluate 22 models, and show that long
inputs and late evidence remain difficult. Their implementation presents a
repository tree and then appends eligible files alphabetically until the model
context budget is exhausted.

Source: [ACL Anthology](https://aclanthology.org/2026.acl-long.1795/), official
code revision `9ccc87cfb848f97b31c54ea9ea23355219be51d2`.

Absorbed claims:

- Paper-code consistency checking is a distinct and difficult task.
- Relevant code location and long context affect discrepancy detection.
- The synthetic split supplies changed-file labels suitable for controlled
  relative comparisons.

Unresolved scope:

- SciCoQA does not evaluate a learned or structured file-retrieval
  intervention under an equal selected-code budget.
- Its alphabetical truncation is an input policy, not a strong retrieval
  baseline.

## Paper-Code RAG Demonstration

Keshri, Zachariah, and Boone describe a four-component RAG system with paper
and code vector stores, predefined implementation queries, reranking, and a
curated consistency report. The full paper contains architecture and
demonstration scenarios but no labeled paper-code retrieval benchmark, no
quantitative file-localization comparison, and no paired statistical test.

Source: [arXiv:2502.00611](https://arxiv.org/abs/2502.00611).

Absorbed claims:

- RAG can be used to organize paper-code consistency analysis.
- Targeted implementation queries are a plausible engineering design.

Unresolved scope:

- Whether paper-derived obligations improve changed-file localization over
  strong generic retrieval under a fixed budget remains unmeasured.

## Repository Retrieval

RepoCoder, CodeRAG, CoRet, ReflectCode, and related systems establish that
query construction, repository structure, dense retrieval, and reranking can
improve repository-level completion, editing, and bug localization. They make
a weak lexical baseline insufficient for a novelty claim.

Representative sources:

- [RepoCoder](https://arxiv.org/abs/2303.12570)
- [CodeRAG](https://aclanthology.org/2025.emnlp-main.1187/)
- [CoRet](https://aclanthology.org/2025.acl-short.62/)
- [Repository-level Code Search with Neural Retrieval Methods](https://arxiv.org/abs/2502.07067)

Absorbed claims:

- Repository retrieval and query reformulation are established techniques.
- BM25 alone is not a sufficient strongest baseline.

Residual claim:

> Explicit, source-linked implementation obligations may improve localization
> of discrepancy-bearing scientific-code files over whole-paper retrieval,
> Methods-only retrieval, generic hybrid retrieval, and an equal-call frontier
> repo-map selector under the same selected-code token budget.

The residual is supported only if the confirmatory experiment meets the frozen
effect-size, uncertainty, paired-test, and downstream conditions. Synthetic
results cannot estimate natural discrepancy prevalence or autonomous-reviewer
reliability.
