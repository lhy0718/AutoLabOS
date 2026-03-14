# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies (also installs web sub-package)
npm install

# Build TypeScript + web UI bundle
npm run build

# Run all unit tests (vitest, file parallelism disabled)
npm test

# Watch mode during development
npm run test:watch

# Run a single test file
npx vitest run tests/<test-file>.test.ts

# Start TUI without build step
npm run dev

# Start local web UI (builds web assets, then launches server)
npm run dev:web

# Smoke tests
npm run test:smoke:natural-collect          # NL collect -> pending command
npm run test:smoke:natural-collect-execute  # NL collect -> execute -> verify artifacts
npm run test:smoke:all                      # Full local smoke bundle
npm run test:smoke:ci                       # CI smoke (set AUTOLABOS_SMOKE_MODE=<mode>)
```

Smoke test env vars: `AUTOLABOS_FAKE_CODEX_RESPONSE=1`, `AUTOLABOS_FAKE_SEMANTIC_SCHOLAR_RESPONSE=1`, `AUTOLABOS_SMOKE_VERBOSE=1`.

## Architecture Overview

AutoLabOS is a TypeScript/ESM CLI (`npm run build` → `dist/cli/main.js`) that automates the full scientific research loop through a **fixed 9-node state graph**. Two UI surfaces share the same runtime: a **slash-first TUI** and a **local web ops UI** (`autolabos web`, default port 4317). Workspace state lives under `.autolabos/` in the user's research project directory.

### Source Layout

```
src/
  cli/          # Entrypoint (main.ts), arg parsing, eval harness
  runtime/      # createRuntime.ts — wires all providers, stores, and the runtime together
  core/
    stateGraph/ # StateGraphRuntime, CheckpointStore, DefaultNodeRegistry, types
    nodes/      # The 9 GraphNodeHandler implementations (one file per node)
    agents/     # AgentOrchestrator, AutonomousRunController, session managers,
                #   roles (collector_curator, implementer, paper_writer …),
                #   agent runtime patterns (reactLoop, reflexion, rewoo, tot)
    analysis/   # paperAnalyzer, paperSelection, paperText, researchPlanning,
                #   paperWriting, scientificWriting, paperManuscript, modelJson
    commands/   # Slash command parsing, natural-language routing (deterministic
                #   first, LLM fallback), collect options
    runs/       # RunStore, RunResolver, CheckpointStore helpers, brief files,
                #   ResearchBriefFiles, TitleGenerator, MigrateRuns
    memory/     # RunContextMemory, EpisodeMemory (Reflexion), LongTermStore
    llm/        # RoutedLLMClient (switches Codex ↔ OpenAI API at runtime)
    collection/ # BibTeX generation, enrichment, collection types
    evaluation/ # EvalHarness
    experiments/# RealExecutionBundle, RunVerifierFeedback
    events.ts   # InMemoryEventStream (shared event bus)
    *Panel.ts   # Deterministic internal panels: designExperimentsPanel,
                #   runExperimentsPanel, analyzeResultsPanel
    reviewSystem.ts / reviewPacket.ts  # 5-specialist review panel + packet
    resultAnalysis*.ts                 # Result synthesis + transition recommendation
  integrations/
    codex/      # CodexCliClient (spawns Codex CLI), modelCatalog
    openai/     # OpenAiResponsesTextClient, ResponsesPdfAnalysisClient, catalogs
  interaction/  # InteractionSession — shared command/session layer for TUI and web
  tui/          # TerminalApp, renderFrame, runProjection, commandPalette, theme
  tools/        # SemanticScholarClient, LocalAciAdapter (ACI), commandPolicy
  web/          # Express HTTP server, REST contracts, artifact browser
  config.ts     # AppConfig load/save/scaffold, setup wizard
  types.ts      # All shared TypeScript types (GraphNodeId, RunRecord, AppConfig …)
web/            # Vite-bundled browser UI (React, separate package.json)
tests/          # Vitest unit tests (mirrors src/ names)
tests/smoke/    # expect/bash smoke scripts for interactive TUI flows
```

### Key Architectural Decisions

**State graph execution** (`src/core/stateGraph/runtime.ts`): `StateGraphRuntime.step()` runs the current node via `GraphNodeHandler.execute()`, writes checkpoints before/after, applies retry and rollback policies (max 3 retries, max 2 auto-rollbacks per node), and resolves `TransitionRecommendation` objects emitted by nodes. `approval_mode: minimal` auto-resolves safe transitions; `manual` pauses at every approval boundary.

**Node → role separation**: Each of the 9 `GraphNodeHandler` implementations in `src/core/nodes/` delegates to role classes in `src/core/agents/roles/` and session managers (`ImplementSessionManager`, `PaperWriterSessionManager`). Internal panels and personas (e.g., `designExperimentsPanel`, 5-specialist review) live inside nodes and do not add top-level graph nodes.

**Provider routing** (`src/core/llm/client.ts`): `RoutedLLMClient` lazily resolves to `CodexLLMClient` or `OpenAiResponsesLLMClient` based on `config.providers.llm_mode`. PDF analysis uses a separate `pdfTextLlm` route with its own model/reasoning settings.

**Runtime bootstrap** (`src/runtime/createRuntime.ts`): `bootstrapAutoLabOSRuntime()` is the single entry point. It wires `RunStore`, `CodexCliClient`, `OpenAiResponsesTextClient`, `RoutedLLMClient`, `SemanticScholarClient`, `LocalAciAdapter`, `DefaultNodeRegistry`, `StateGraphRuntime`, and `AgentOrchestrator`.

**Interaction layer** (`src/interaction/InteractionSession.ts`): Shared between TUI and web. Handles slash command dispatch, deterministic natural-language routing (→ `naturalDeterministic.ts`), LLM-backed assistant fallback (→ `naturalLlmAssistant.ts`), multi-step plan execution (`y/a/n` or web buttons), and run-lifecycle management.

**Artifacts and checkpoints**: All run artifacts live under `.autolabos/runs/<run_id>/`. User-facing deliverables are mirrored to `outputs/<run-title>-<run_id_prefix>/`. Checkpoints are written at `before | after | fail | jump | retry` phases.

**Memory layers**: `RunContextMemory` (per-run key/value store), `LongTermStore` (JSONL history), `EpisodeMemory` (Reflexion failure lessons used on retries).

**ACI execution**: `LocalAciAdapter` (`src/tools/aciLocalAdapter.ts`) provides `read_file`, `write_file`, `apply_patch`, `run_command`, `run_tests`, `tail_logs` actions used by `implement_experiments` and `run_experiments`.

**Web UI**: `src/web/server.ts` is an Express server serving the Vite-built `web/dist/` assets. `web/src/` is a separate React package (its own `package.json`); build it with `npm --prefix web run build`.

### Test Conventions

- All unit tests are in `tests/` as `*.test.ts`, discovered by vitest.
- Tests often switch `process.cwd()` to isolated temp workspaces — this is why `fileParallelism: false` is set in `vitest.config.ts`.
- Smoke tests live in `tests/smoke/` as expect/bash scripts and use fake environment variables to avoid live API calls.
- To run a single unit test: `npx vitest run tests/<name>.test.ts`.

### Scientific Writing / Agent Behavior Principles

The `AGENTS.md` file (Korean) defines mandatory behavior for this codebase's agents and any code changes related to manuscript generation:
- Claims must not exceed what the evidence supports; weak evidence → weaker language.
- Manuscript completeness requires explicit method details, result variance, and internal consistency checks.
- Use claim→evidence traceability; never fabricate statistics, confidence intervals, or reproducibility claims without artifacts.
- Paper writing uses claim-evidence contracts enforced at the `review` and `write_paper` nodes.
