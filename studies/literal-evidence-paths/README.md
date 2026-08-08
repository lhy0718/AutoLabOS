# Literal Evidence Paths Study

This directory contains the governed, reproducible materials for a
mutation-based audit of artifact-aware research review. It is intentionally
separate from reusable AutoLabOS runtime code.

## Research Question

When a computed result expression in an AI-generated research workspace is
replaced by a plausible numeric literal at an artifact sink, how often does an
artifact-aware reviewer identify the exact substitution? Does a deterministic
evidence-path packet improve detection without increasing clean-workspace false
alarms?

The study does not infer intent, misconduct, or the natural prevalence of
fabrication. Its confirmatory estimand is reviewer sensitivity to controlled,
direct-sink provenance substitutions in a pinned corpus.

## Current Stage

- Topic status: killed at structural preflight
- Scientific outcomes observed: none
- Confirmatory model calls completed: 0
- Paper-scale claims authorized: no
- Source registry: `corpus/source.v1.json`
- Threshold contract and post-scan integrity amendment:
  `method/preflight-contract.v1.json`
- Manual development audit: `method/manual-development-mutation-audit.v1.json`
- Structural receipt: `results/structural-preflight.v1.json`
- Termination decision: `method/termination-decision.v1.json`

Five CPU workspaces are excluded from confirmatory analysis. One was reserved
because its code was inspected during topic exploration; four were selected by
the lowest SHA-256 values under the frozen development salt. The remaining 40
CPU workspaces form the maximum confirmatory set before structural exclusions.

## Evidence Boundary

A mutation is eligible only when it changes one parseable Python expression
that directly supplies a recognized serialized or tabular result sink, keeps
the file syntactically valid, preserves the surrounding API and output schema,
and uses a manuscript-derived numeric literal with a compatible scalar type.
Bare subscripts are excluded because a static scan cannot prove whether they
yield a scalar, array, Series, or mapping; an explicit scalar operation such as
`.item()`, `float(...)`, or a supported reduction is required.
The primary grader requires an exact file and mutated-line match plus the
declared `literal_evidence_substitution` category; it does not use an LLM judge.

The corrected structural scan found eligible direct-sink targets in 25 of 40
confirmatory workspaces and 2 of 5 development workspaces. Both frozen
eligibility floors failed. The two surviving development mutations have not
been manually re-audited after the conservative scanner revision, so the
manual-validity gate also fails. Development units cannot replace failed
confirmatory units, the thresholds remain unchanged, and no reviewer was
called.

## Frozen Preflight Result

Every numeric gate declared in the frozen contract is evaluated independently:

| Gate | Observed | Threshold | Result |
| --- | ---: | ---: | --- |
| Confirmatory workspaces with an eligible target | 25 | at least 40 | Fail |
| Development workspaces with an eligible target | 2 | at least 5 | Fail |
| Python parse success | 563/563 (1.0) | 1.0 | Pass |
| Mutation parse success | 27/27 (1.0) | 1.0 | Pass |
| Duplicate selected-target hash rate | 0/27 (0.0) | at most 0.05 | Pass |
| Manual development mutation validity | 0/2 (0.0) | 1.0 | Fail |

Manual validity is defined over generated development mutations. No prior
manual assertion is carried across the conservative scalar-classifier change;
the two surviving mutations remain explicit mismatches until a new audit is
performed. The structural result records each observed value, comparator,
threshold, and pass/fail decision.
The thresholds were fixed before the initial scan, but scanner corrections and
the registry/audit hash bindings were added after structural eligibility had
been observed. The contract records that amendment explicitly. No confirmatory
model output was observed, and the corrected scan is a termination receipt
rather than preregistered confirmatory evidence.

## Reproduction

The runner loads the contract and source registry only from their canonical
study paths. The contract pins the registry and manual audit by SHA-256; the
registry pins the corpus commit, repository URL, development split, and paper
index hash. The corpus checkout must be clean and at the pinned commit.

```bash
python3 studies/literal-evidence-paths/scripts/structural_preflight.py \
  --corpus-root <researcharena-checkout> \
  --paper-index-html <pinned-papers-html> \
  --output studies/literal-evidence-paths/results/structural-preflight.v1.json \
  --termination-receipt studies/literal-evidence-paths/method/termination-decision.v1.json
```

`PASS_PREFLIGHT` returns zero and does not create a termination receipt. A
frozen `KILL` requires and writes the canonical termination receipt, then
returns status 2 so automation cannot mistake termination for a successful
preflight.

## Planned Comparators

- `lexical_sink_scan`: deterministic literal-at-sink warning baseline.
- `artifact_review`: the strongest feasible whole-workspace reviewer under the
  same model and call budget.
- `evidence_packet_review`: the same reviewer supplied with a deterministic,
  source-linked evidence-path packet.

Clean and mutated variants are reviewed in separate, pair-blind sessions. The
primary metric is paper-level Youden's J (`mutated recall - clean false-positive
rate`), with exact detection recall and clean false-positive rate reported
separately. Uncertainty is clustered by workspace.
