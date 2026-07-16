# Promotion Benchmark Score

- Suite: promotion-governance-synthetic-development-v1
- Cases: 40
- Predictions: 160
- Validation: passed
- Evidence class: synthetic_development
- Paper-claim eligible: false
- Adjudication: unreviewed
- Mutation isolation: unreviewed
- Execution provenance: unverified

## System Summary

| System | Decision accuracy | Macro-F1 | False promotion | Concern-acceptance conflict | Clean promotion | Blocker F1 | Repair owner | Trace coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| advisory-artifact-audit | 0.100 | 0.045 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| always-promote | 0.100 | 0.045 | 1.000 | n/a | 1.000 | n/a | 0.000 | n/a |
| artifact-audit | 1.000 | 1.000 | 0.000 | 0.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| presence-checklist | 0.100 | 0.045 | 1.000 | n/a | 1.000 | n/a | 0.000 | n/a |

## Mutation Families

### advisory-artifact-audit

| Family | Cases | Decision accuracy | False promotion | Blocker recall | Repair owner |
| --- | ---: | ---: | ---: | ---: | ---: |
| citation_support_mismatch | 4 | 0.000 | 1.000 | n/a | 1.000 |
| claim_evidence_conflict | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| clean_control | 4 | 1.000 | n/a | n/a | n/a |
| comparison_evidence_gap | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| executed_budget_mismatch | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| hidden_failed_execution | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| repeated_run_provenance_gap | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| result_figure_conflict | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| stale_persisted_state | 4 | 0.000 | 1.000 | 1.000 | 1.000 |
| unsupported_claim_strength | 4 | 0.000 | 1.000 | n/a | 1.000 |

### always-promote

| Family | Cases | Decision accuracy | False promotion | Blocker recall | Repair owner |
| --- | ---: | ---: | ---: | ---: | ---: |
| citation_support_mismatch | 4 | 0.000 | 1.000 | n/a | 0.000 |
| claim_evidence_conflict | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| clean_control | 4 | 1.000 | n/a | n/a | n/a |
| comparison_evidence_gap | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| executed_budget_mismatch | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| hidden_failed_execution | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| repeated_run_provenance_gap | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| result_figure_conflict | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| stale_persisted_state | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| unsupported_claim_strength | 4 | 0.000 | 1.000 | n/a | 0.000 |

### artifact-audit

| Family | Cases | Decision accuracy | False promotion | Blocker recall | Repair owner |
| --- | ---: | ---: | ---: | ---: | ---: |
| citation_support_mismatch | 4 | 1.000 | 0.000 | n/a | 1.000 |
| claim_evidence_conflict | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| clean_control | 4 | 1.000 | n/a | n/a | n/a |
| comparison_evidence_gap | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| executed_budget_mismatch | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| hidden_failed_execution | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| repeated_run_provenance_gap | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| result_figure_conflict | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| stale_persisted_state | 4 | 1.000 | 0.000 | 1.000 | 1.000 |
| unsupported_claim_strength | 4 | 1.000 | 0.000 | n/a | 1.000 |

### presence-checklist

| Family | Cases | Decision accuracy | False promotion | Blocker recall | Repair owner |
| --- | ---: | ---: | ---: | ---: | ---: |
| citation_support_mismatch | 4 | 0.000 | 1.000 | n/a | 0.000 |
| claim_evidence_conflict | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| clean_control | 4 | 1.000 | n/a | n/a | n/a |
| comparison_evidence_gap | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| executed_budget_mismatch | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| hidden_failed_execution | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| repeated_run_provenance_gap | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| result_figure_conflict | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| stale_persisted_state | 4 | 0.000 | 1.000 | 0.000 | 0.000 |
| unsupported_claim_strength | 4 | 0.000 | 1.000 | n/a | 0.000 |

## Paired Analysis

Inference unit: base_bundle_id. Bootstrap replicates: 5000. Exploratory only: true.

| System A | System B | Decision delta | Decision 95% CI | Sign-test p | False-promotion delta | False-promotion 95% CI | Sign-test p |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| advisory-artifact-audit | always-promote | 0.000 | [0.000, 0.000] | n/a | 0.000 | [0.000, 0.000] | n/a |
| advisory-artifact-audit | artifact-audit | -0.900 | [-0.900, -0.900] | 0.125 | 1.000 | [1.000, 1.000] | 0.125 |
| advisory-artifact-audit | presence-checklist | 0.000 | [0.000, 0.000] | n/a | 0.000 | [0.000, 0.000] | n/a |
| always-promote | artifact-audit | -0.900 | [-0.900, -0.900] | 0.125 | 1.000 | [1.000, 1.000] | 0.125 |
| always-promote | presence-checklist | 0.000 | [0.000, 0.000] | n/a | 0.000 | [0.000, 0.000] | n/a |
| artifact-audit | presence-checklist | 0.900 | [0.900, 0.900] | 0.125 | -1.000 | [-1.000, -1.000] | 0.125 |
