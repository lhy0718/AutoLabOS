# ISSUES.md

This file is an append-only live-validation record for interactive reliability work.

## Entry contract (required fields)

Every active issue entry must include:

- Validation target
- Environment/session context
- Reproduction steps
- Expected behavior
- Actual behavior
- Fresh vs existing session comparison
- Root cause hypothesis
- Code/test changes
- Regression status
- Follow-up risks

Template: `docs/live-validation-issue-template.md`

## Current status snapshot

- Last updated: 2026-03-14T22:59 (local)
- Current validation target: `test/` real TUI path `/new -> /brief start --latest` with quality-first defaults
- Current active workspace(s): `test/tui-live-cycle-20260314-225525-iter8`, `test/tui-live-cycle-20260314-223110-iter7`
- Current active run: `a5dde90b-a4f8-44d1-be22-c1972cbdd3ed`
- Overall state: re-validating

## Active live-validation issues

## Issue: LV-20260314-implement-runnable-contract

- Status: `open`
- Validation target: analyze/generate/design을 통과한 run이 implement 이후 rollback loop 없이 `write_paper`까지 도달
- Environment/session context: `test/tui-live-cycle-20260314-223110-iter7`, run `5b10ff29-885f-4948-93d5-061497b3bdf4`, TUI quality-first cycle

- Reproduction steps:
  1. Start live TUI flow from `/new`.
  2. Run `/brief start --latest`.
  3. Let workflow advance to `implement_experiments`.
  4. Observe implement step output and transition behavior.

- Expected behavior: implement 단계가 runnable artifact 또는 `run_command`를 생성하고 `run_experiments`로 전이
- Actual behavior: `Implementer did not return a runnable artifact or run_command.` 반복 후 auto-rollback
- Fresh vs existing session comparison:
  - Fresh session: 동일 implement contract failure 재현됨
  - Existing session: 동일 failure 반복 및 cycle 고착
  - Divergence: no (both blocked)

- Root cause hypothesis:
  - Type: `persisted_state_bug`
  - Hypothesis: implement session output contract 검증/탐지가 runnable 계약을 충족하지 못한 결과를 허용하지 못함

- Code/test changes:
  - Code: pending (`src/core/agents/implementSessionManager.ts`, `src/core/nodes/implementExperiments.ts`, `src/core/nodes/runCommandResolver.ts` candidate surface)
  - Tests: pending (implement runnable contract regression test 예정)

- Regression status:
  - Automated regression test linked: no (pending)
  - Re-validation result: fail (still reproducible)

- Follow-up risks:
  - implement contract만 수정할 경우 run/analyze handoff 경계에서 새로운 false-positive runnable detection 위험
  - rollback convergence 정책과 상호작용 가능성

- Evidence/artifacts:
  - `test/tui-live-cycle-20260314-223110-iter7/.autolabos/runs/5b10ff29-885f-4948-93d5-061497b3bdf4/implement_result.json`
  - `test/tui-live-cycle-20260314-223110-iter7/.autolabos/runs/runs.json`

## Iteration log (condensed)

### Iteration 1

- Goal: fresh live baseline and artifact/UI comparison
- Change: none (observation only)
- Result: stale-running pattern observed
- Decision: continue

### Iteration 2

- Goal: prevent `/approve` false-success when no pending approval exists
- Change:
  - `src/tui/TerminalApp.ts`
  - `src/interaction/InteractionSession.ts`
  - `src/tui/renderFrame.ts`
  - tests in `tests/terminalAppPlanExecution.test.ts`, `tests/renderFrame.test.ts`
- Result: `/approve` now rejected with `/retry` guidance
- Decision: continue

### Iteration 3

- Goal: bound analyze retry stall window
- Change:
  - `src/core/analysis/paperAnalyzer.ts`
  - `src/core/nodes/analyzePapers.ts`
  - `tests/analyzePapers.test.ts`
- Result: stalled-running reduced, later loop moved to hypothesis/implement boundaries
- Decision: continue

### Iteration 4

- Goal: block forward `/approve` on zero-evidence analyze pause
- Change:
  - `src/tui/TerminalApp.ts`
  - `src/interaction/InteractionSession.ts`
  - tests in `tests/terminalAppPlanExecution.test.ts`, `tests/interactionSession.test.ts`
- Result: live guard confirmed
- Decision: continue

### Iteration 5

- Goal: restore quality-first defaults (remove forced timeout default)
- Change:
  - `src/core/analysis/paperAnalyzer.ts`
- Result: run duration increased; full completion still pending
- Decision: continue
