# Independent Claim Review Guide

Use only the task file, the cited public record, and the exact full source whose SHA-256 is listed in the task.

1. Make a working copy of `review-template.json`.
2. Inspect the full source text, not only metadata or the abstract.
3. Choose `supported`, `rewrite`, `wrong_source`, or `missing_source` for every task.
4. For `supported` and `rewrite`, record a source locator and a short supporting passage. For `rewrite`, also provide the replacement claim.
5. Write a non-empty rationale for every decision and set all attestations to true only after personally completing the review.
6. Return only the completed JSON for preflight.

A passing preflight does not change Refgate claim status. Final status requires explicit approval and a separate Refgate import.
