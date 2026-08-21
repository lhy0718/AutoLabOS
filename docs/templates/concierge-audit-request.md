# Concierge Audit Request

Use this template when asking a pilot user for one real AI research-agent artifact bundle.

## Request

- Contact or team:
- Artifact owner:
- Permission to inspect artifacts for audit only: `yes|no`
- Permission to keep sanitized derived audit outputs: `yes|no`
- Requested turnaround:

## Artifact Bundle

Provide one bundle with any available files:

- draft or manuscript text
- run artifact root
- result table or metrics file
- execution log
- claim-evidence table
- citation list or bibliography
- figure audit summary or figure/caption files
- paper-readiness or review decision artifacts

Do not include secrets, private credentials, raw unpublished datasets, or personal data unless there is explicit approval and a separate handling plan.

## Operator Checklist

- [ ] Copy or summarize only allowlisted files into a repo-controlled ignored output directory.
- [ ] Run `autolabos audit --external <external-artifact-root> [--draft <draft.md>] [--log <run.log>] --out-dir outputs/audit/<pilot-id>`.
- [ ] Confirm `external-intake-manifest.json` does not expose machine-local paths.
- [ ] Inspect `paper-readiness-audit.md` before summarizing findings.
- [ ] Inspect `claim-evidence-table.json` for unsupported claims.
- [ ] Record whether the pilot user supplied a concrete recent failure case.
- [ ] Record whether the pilot user asked for a repeat audit or repo integration.

## Follow-Up Signal

- Recent failure example: `yes|no`
- Artifact access granted: `yes|no`
- Repeat audit requested: `yes|no`
- Repo integration requested: `yes|no`
- Positioning understood as paper-readiness audit: `yes|no`

Generic praise is not a go signal unless it is paired with artifact access or a concrete follow-up request.
