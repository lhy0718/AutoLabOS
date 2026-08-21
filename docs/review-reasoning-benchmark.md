# Review Reasoning Benchmark

This benchmark evaluates reasoning-tier routing for AutoLabOS model review. It
is a project-internal policy evaluation, not research evidence for a generated
paper and not a substitute for the governed five-specialist plus meta-review
topology.

## Evaluation contract

- Regime: `controlled_deterministic_fault_injection`
- Claim ceiling: `registered_fault_families_only`
- Policy scope: `internal_model_routing_only`
- Splits: source- and fault-family-disjoint `development` and `test`
- Gold: derived from structured packet predicates by an independent oracle
- Inputs: rendered packets omit injected labels, source fingerprints, and gold
  adjudication dispositions
- Outputs: exact JSON with per-case findings and meta-review adoption choices

The frozen suite contains domain-neutral synthetic research packets. Fault
families cover comparison validity, evaluation scale, repetition, uncertainty,
claim scope, partition overlap, metric direction, budget confounding, artifact
binding, and citation verification. Clean packets are included to measure false
positive control. The held-out split also includes compound multi-fault
packets and near-threshold clean packets with fault-like surface cues. A detected
ceiling effect
blocks promotion and requires suite strengthening before more repetitions are run.

## Running the benchmark

Validate the suite without model calls:

```bash
npm run benchmark:review -- --dry-run
```

Run the Codex-supported comparison:

```bash
npm run benchmark:review -- --provider codex --effort high --effort xhigh --repetitions 3
```

Run the API comparison that includes `max`:

```bash
npm run benchmark:review -- --provider openai --effort high --effort xhigh --effort max --repetitions 3
```

The command writes a unique output directory containing the frozen suite,
preflight, raw responses, execution receipts, JSON report, and Markdown report.
Provider/model/reasoning provenance, input and output hashes, usage, latency,
parse failures, and per-tier scores remain inspectable.

## Routing gate

A candidate reasoning tier is eligible only when all of these hold:

1. The held-out `test` split was used.
2. Suite validation, oracle replay, source disjointness, and fault-family
   disjointness pass.
3. At least three matched repetitions complete without parse or provider
   failures.
4. Defect recall improves by at least `0.03`.
5. The paired case-bootstrap 95% lower bound for recall improvement exceeds
   zero.
6. Precision and adjudication accuracy each regress by no more than `0.02`.

An eligible result sets `routing_policy_review_allowed=true`; it never changes
`automatic_policy_change_allowed=false` and does not authorize an automatic
source edit. A failed or insufficient run preserves the current policy. The benchmark
cannot raise an `A0` claim ceiling, create external evidence, or establish
naturalistic reviewer quality.
