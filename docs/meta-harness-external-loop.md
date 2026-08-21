# Meta-Harness External Multi-Run Loop

This note defines the first P2-2 slice for external meta-harness context ingestion.

It is intentionally read-only. It prepares context bundles from external run artifact roots, but it does not call an LLM, apply prompt diffs, commit changes, score external runs, or claim autonomous improvement.

## Purpose

The external multi-run loop lets an operator gather multiple governed run artifact roots into a single meta-harness context bundle for prompt or review analysis.

The first implementation supports:

```sh
autolabos meta-harness --external-run <run-artifact-root> --external-run <run-artifact-root> --no-apply
```

`--no-apply` is required for external contexts.

## Contract

External run roots are treated as context only.

The loop must:

- copy only an allowlisted set of governed artifacts
- write a context manifest
- avoid recording absolute external paths in the manifest
- tolerate missing optional artifacts
- never mutate prompts or source files
- never treat copied context as measured benchmark performance
- preserve review, claim ceiling, baseline, and artifact validation contracts

## Copied Artifact Classes

The first slice may copy artifacts such as:

- `events.jsonl`
- `result_analysis.json`
- `result_analysis_synthesis.json`
- `baseline_comparison.json`
- `result_table.json`
- `transition_recommendation.json`
- `analysis/evidence_scale_assessment.json`
- `review/decision.json`
- `review/review_packet.json`
- `review/paper_critique.json`
- `paper/paper_readiness.json`
- `paper/paper_critique.json`

Unlisted files are not copied.

## Manifest

The generated context includes a manifest describing:

- mode
- external context count
- safe source labels
- copied artifacts
- missing optional artifacts

The manifest should not include machine-specific absolute source paths.

## Future Expansion

Future slices may add:

- explicit external-source schemas
- benchmark-condition labels
- context compression
- external-run scoring as separate non-mutating analysis
- safe candidate generation for human review

Automatic prompt mutation from external contexts remains out of scope until an explicit approval and validation contract is added.
