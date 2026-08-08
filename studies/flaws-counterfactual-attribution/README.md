# FLAWS Counterfactual Attribution Preflight

## Status

- Decision: `KILL_PROVENANCE`
- Topic selected: false
- Model execution allowed: false
- Research model calls: 0
- Decision receipt: `method/termination-decision.v2.json`

This candidate was stopped before model execution. A diagnostic local rerun
appeared to leave only thirty confirmatory paper clusters after layout
filtering, but that number is not admissible gate evidence: the runner did not
enforce the declared source-archive hashes, fresh extraction, or a fully
attested fresh build toolchain.

The frozen preflight contract is retained so the failed design decision remains
auditable. The unverified scripts, tests, and derived receipts are excluded from
the public study bundle rather than presented as reproducible evidence.

## Claim Ceiling

No empirical claim about source replay, build success, layout stability, or
model behavior is supported by this bundle. The only supported conclusion is
that the candidate failed its provenance preconditions and must return to topic
search or be rerun from verified source archives with a hash-bound toolchain.
