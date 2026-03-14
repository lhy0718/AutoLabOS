# Paper Quality Bar (Structural + Evidence Discipline)

This document captures minimum quality requirements around `write_paper` outputs.

## 1) Structural artifact requirements

When `write_paper` succeeds:

- `paper/main.tex` must exist.
- `paper/references.bib` must exist.
- `paper/evidence_links.json` must exist.

## 2) Evidence linkage sanity

`paper/evidence_links.json` must be structurally useful:

- Contains a non-empty `claims` array when claims are present.
- Each major claim entry includes:
  - non-empty `claim_id`
  - non-empty statement text
  - at least one concrete evidence or citation reference
- Reject obviously empty placeholder mappings (blank, `TODO`, `TBD`, `placeholder`, `unknown`).

## 3) Review packet handoff discipline

Before drafting, review output should be structurally complete:

- Review packet has core sections (`readiness`, `checks`, `suggested_actions`).
- Decision and revision artifacts are present when decisioning is active.

## 4) Claim strength and evidence discipline

- Do not overstate claims beyond available artifacts.
- If evidence is weak or incomplete, downgrade claim language explicitly.
- Do not fabricate statistics, confidence intervals, or reproducibility claims.
