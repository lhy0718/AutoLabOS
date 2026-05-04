---
name: repo-portability-hygiene
description: Use when creating or editing files that may be committed or uploaded to GitHub, especially docs, checklists, skills, tests, scripts, configs, or examples that might reference local files, private reference docs, private mirrors, workspaces, run outputs, or machine-specific resources.
contract_version: 1
contract_kind: codex_skill
runtime_contract: true
gate: public_repo_portability
validation: changed_file_path_scan
---

# Repo Portability Hygiene

## Purpose

Keep committed repository content portable, publishable, and free of accidental machine-local paths or private environment details.

## Required Checks

Before finishing any repo edit that could be committed:

1. Scan changed files for machine-specific absolute paths and private roots.
2. Replace local paths with repo-relative paths or generic placeholders.
3. Remove private/internal reference document paths from public docs unless the user explicitly asks to publish them.
4. Keep real local paths only in terminal commands, transient logs, ignored outputs, or final chat links when needed for local navigation.
5. Re-run the scan after edits.

Recommended scan:

```sh
rg -n "/home/|/Users/|/mnt/|/tmp/|reference[-_ ]?vault|private[-_ ]?mirror" <changed-files>
```

If a path is intentionally local, explain why and keep it out of committed docs unless the file is explicitly a local-only template.

## Preferred Patterns

- Use repo-relative paths for files inside this repository, such as `docs/architecture.md`.
- Use generic placeholders for external files, such as `<path-to-brief.md>`.
- Define placeholders once near the top of a document when they are part of a public contract.
- For examples, prefer `<reference-source>/...` over a user home directory or private mirror name.
- For generated run artifacts, use `.autolabos/runs/<run-id>/...` or `outputs/<bundle>/...`.

## Do Not Commit

- Personal home paths like `/home/<user>/...` or `/Users/<user>/...`.
- Machine-specific mirror roots.
- Private reference document paths or internal knowledge-base titles when the target document will be public.
- Absolute paths from a temporary validation workspace.
- Local secrets, tokens, `.env` contents, or credentials.
- Claims that a local-only path is the canonical project contract.

## AutoLabOS-Specific Rule

Private reference notes may be used as input while planning, but committed repo docs should not expose their local paths or internal document names. Summarize the implementation-relevant decisions directly in repo docs and cite repo-native source-of-truth files such as `AGENTS.md` or `docs/architecture.md`.

Do not write to private reference mirrors, and do not commit the current machine's mirror path.
