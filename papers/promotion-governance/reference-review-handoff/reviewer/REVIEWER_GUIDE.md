# Independent Claim Review Guide

Use only the task file, the cited public record, and the exact full source whose SHA-256 is listed in the task.

1. Make a working copy of `review-template.json`.
2. Inspect the full source text, not only metadata or the abstract.
3. Choose `supported`, `rewrite`, `wrong_source`, or `missing_source` for every task.
4. For `supported` and `rewrite`, record a source locator and a short supporting passage. For `rewrite`, also provide the replacement claim.
5. Write a non-empty rationale for every decision and set all attestations to true only after personally completing the review.
6. Return only the completed JSON for preflight.
7. If every decision is supported, give the generated final approval template and preflight report to a different human final approver. The approver must review the complete return, fill the attestation and rationale, and return the approval JSON separately.

From the packet root (the parent of `reviewer/`), run:

```sh
autolabos reference-review preflight --packet . --review <completed-review.json> --out-dir <new-preflight-dir>
```

A passing preflight does not change Refgate claim status. After explicit approval, `autolabos reference-review import` generates a new import-candidate TSV without overwriting the source claims file.
