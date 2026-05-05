# Pilot Readiness Review

Date: 2026-05-05

## Implemented Runtime Behavior

- `autolabos audit --external <artifact-root> [--draft <draft.md>] [--log <run.log>] [--out-dir outputs/audit]`
- External intake manifest with sanitized source reference.
- Allowlisted artifact copying into the audit output directory.
- `claim-evidence-table.json` generated from existing claim artifacts and scorer issues.
- AGB-001 through AGB-010 full seed audit demo.
- Literature discovery findings for target-paper trace and wide related-work trace gaps.

## Demo-Only Evidence

- AGB seed replay is regression and product-demo evidence.
- It is not customer validation and is not scientific performance evidence.

## Manual Concierge Steps

- Request one artifact bundle from a pilot user.
- Copy or summarize only allowlisted files.
- Run the external audit command.
- Review `paper-readiness-audit.md`, `claim-evidence-table.json`, `blockers.json`, and `external-intake-manifest.json`.
- Record follow-up behavior using `docs/templates/concierge-audit-request.md`.

## Go / No-Go Thresholds

Go requires all of:

- at least three concrete recent AI research-agent output failures from five conversations
- at least two real artifact bundles shared for audit
- at least one repeat audit request or repo integration request
- the buyer/user understands the product as paper-readiness audit or evidence governance

No-go if:

- feedback stays at generic interest
- users will not share artifacts
- users only ask for a broader autonomous research OS
- the audit cannot produce actionable blockers on real artifacts

## Validation

- `npm run build`: passed.
- `npm test`: passed.
- `npm run validate:harness`: passed.
- `npm audit`: found 0 vulnerabilities.
- `npm --prefix web audit`: found 0 vulnerabilities.
- `npm run demo:audit-blockers -- --out-dir outputs/audit-demo-p4-smoke`: passed; AGB-001, AGB-003, and AGB-010 remained blocked or downgraded.
- `npm run demo:audit-full-seeds -- --out-dir outputs/audit-full-seeds-p4-smoke`: passed; AGB-001 through AGB-010 matched expected conservative outcomes.

## Remaining Risks

- External artifacts may not match AutoLabOS run artifact conventions.
- Citation support may require manual source normalization.
- Literature discovery trace formats are still intentionally narrow.
- Pilot outputs must remain sanitized before being shared or committed.
