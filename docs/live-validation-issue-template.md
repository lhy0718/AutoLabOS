# Live Validation Issue Template

Use this template for each active issue entry in `ISSUES.md`.

## Issue: <short-id-or-title>

- Status: `open|in_progress|resolved|blocked`
- Validation target: <what path/flow is being validated>
- Environment/session context: <workspace, run id, branch, flags, provider mode, etc.>

- Reproduction steps:
  1. <step 1>
  2. <step 2>
  3. <step 3>

- Expected behavior: <what should happen>
- Actual behavior: <what happened>
- Fresh vs existing session comparison:
  - Fresh session: <result>
  - Existing session: <result>
  - Divergence: <yes/no + short note>

- Root cause hypothesis:
  - Type: `persisted_state_bug|in_memory_projection_bug|refresh_render_bug|resume_reload_bug|race_timing_bug`
  - Hypothesis: <short hypothesis>

- Code/test changes:
  - Code: <path(s) or "none yet">
  - Tests: <path(s) or "none yet">

- Regression status:
  - Automated regression test linked: <yes/no + path>
  - Re-validation result: <pass/fail/pending>

- Follow-up risks: <known adjacent risks>
- Evidence/artifacts: <paths, logs, screenshots, run artifacts>
