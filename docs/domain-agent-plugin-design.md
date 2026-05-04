# Domain Agent Plugin Design

This note defines the contract for future domain-specific research-agent plugins.

## Purpose

Domain agents may add specialized knowledge, tools, prompts, or validators for a research domain. They must not replace the governed workflow or bypass evidence gates.

## Plugin Boundary

A domain plugin may provide:

- domain-specific brief guidance
- literature query heuristics
- dataset/task suggestions
- metric definitions
- artifact validators
- prompt appendices
- specialist review rubrics
- safe local tool adapters

A domain plugin must not:

- add top-level workflow nodes without architecture approval
- skip baseline/comparator requirements
- mark papers ready without review
- write outside approved artifact locations
- hide external actions
- weaken claim ceilings

## Runtime Contract

Each plugin capability should declare:

- target node or artifact
- allowed inputs
- allowed outputs
- validation command or artifact check
- policy tier for external actions
- fallback behavior when unavailable
- responsible-use constraints

## Artifact Contract

Plugin-generated artifacts should be run-scoped under `.autolabos/runs/<run-id>/...` and public only when explicitly published through the public output publisher.

Artifacts must include enough metadata to identify:

- domain
- plugin capability
- source inputs
- generated outputs
- validation status
- limitations

## Review Integration

Domain review should extend, not replace, the existing review panel. Domain findings must map to claim verification, methodology, statistics, writing readiness, or integrity so downstream gates remain comparable.

## Versioning

Domain plugins that affect runtime contracts should carry version metadata and validation expectations. Prompt-only helpers may be lighter, but still need clear scope and fallback behavior.

