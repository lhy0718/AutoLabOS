# Artifact Access Design

This note documents the P1 artifact-access position for operators, public bundles, plugins, and future external integrations.

## Source Of Truth

Run-scoped artifacts under `.autolabos/runs/<run-id>/...` are the source of truth. Public outputs are projections and must remain traceable to those run artifacts.

## Access Tiers

Recommended access tiers:

- internal runtime: may read and write governed run artifacts for the active node
- operator local: may inspect run artifacts, events, checkpoints, and public bundles
- public bundle: may include sanitized, traceable outputs selected for sharing
- plugin/tool adapter: may access only declared inputs and output locations
- external reviewer or benchmark: may receive explicit artifact bundles, not the whole workspace

## Write Permissions

Writes should remain limited to:

- `.autolabos/runs/<run-id>/...`
- configured output bundle locations
- validation workspaces
- explicitly approved implementation files when a node owns that responsibility

External or plugin writes require policy classification and should be auditable.

Risk tiers:

- run-artifact writes: allowed when node-owned and traceable
- source, docs, prompt, or paper writes: require the active node or operator task to own the file
- publication, repository push, network side effect, or external service mutation: require explicit review or a hard stop according to policy

## Public Bundle Rules

Public bundles should:

- include a manifest
- identify generated files
- preserve artifact provenance
- avoid secrets and local machine paths
- distinguish run completion from paper readiness
- include downgrade and limitation artifacts when present

Public bundles should not include:

- private notes
- raw secrets or tokens
- unrelated workspace files
- unreviewed external credentials
- unsupported claims not backed by run artifacts

## Operator UX

Operator views should prioritize:

- current node and status
- pending approval or transition
- key blockers
- latest result table
- baseline comparison
- figure audit state
- review decision
- paper-readiness or downgrade state
- links to source run artifacts

## Future Integration Rule

Any external artifact-access integration must prove:

- least-privilege access
- explicit path allowlists
- traceable reads and writes
- no weakening of review gates
- no automatic publication without human approval
