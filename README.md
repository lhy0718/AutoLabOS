# AutoResearch

Language: **English** | [한국어](./README.ko.md)

Slash-first TUI for AI-agent-driven research automation.

## Quick Start

```bash
npm install
npm run build
npm link
autoresearch
```

Development mode:

```bash
npm run dev
```

Without `npm link`, you can still run `node dist/cli/main.js`.

## First Run

1. Run `autoresearch` in an empty project.
2. If `.autoresearch/config.yaml` is missing, setup wizard starts automatically.
3. Wizard creates scaffold/config and opens the dashboard.

## CLI Policy

- External command: `autoresearch` only.
- `autoresearch init` is not supported.
- Operational flows run inside TUI via slash commands.

## State Graph Workflow (v3)

Fixed graph nodes:

1. `collect_papers`
2. `analyze_papers`
3. `generate_hypotheses`
4. `design_experiments`
5. `implement_experiments`
6. `run_experiments`
7. `analyze_results`
8. `write_paper`

Default edge: linear `1 -> 8`.

## Runtime Policies

- Checkpoints: `.autoresearch/runs/<run_id>/checkpoints/`
- Phases: `before | after | fail | jump | retry`
- Retry policy: `maxAttemptsPerNode=3`
- Auto rollback policy: `maxAutoRollbacksPerNode=2`
- Jump modes:
  - `safe`: only current/previous node
  - `force`: forward jump allowed, skipped nodes recorded
- Budget policy:
  - `maxToolCalls=150`
  - `maxWallClockMinutes=240`
  - `maxUsd=15` (soft-check if provider cost unavailable)

## Agent Runtime Patterns

- ReAct loop: `PLAN_CREATED -> TOOL_CALLED -> OBS_RECEIVED`
- ReWOO split (planner/worker): used for high-cost nodes
- ToT (Tree-of-Thoughts): used in hypothesis/design nodes
- Reflexion: failure episodes are stored and reused on retries

## Memory Layers

- Run context memory: per-run short-term state
- Long-term store: JSONL summary/index history
- Episode memory: Reflexion failure lessons

## ACI (Agent-Computer Interface)

Standard actions:

- `read_file`
- `write_file`
- `apply_patch`
- `run_command`
- `run_tests`
- `tail_logs`

`implement_experiments` and `run_experiments` are executed via ACI.

## Slash Commands

| Command | Description |
|---|---|
| `/help` | Show command list |
| `/new` | Create run |
| `/doctor` | Environment checks |
| `/runs [query]` | List/search runs |
| `/run <run>` | Select run |
| `/resume <run>` | Resume run |
| `/agent list` | List graph nodes |
| `/agent run <node> [run]` | Execute from node |
| `/agent status [run]` | Show node statuses |
| `/agent collect [query] [options]` | Collect papers with filters/sort/options |
| `/agent recollect <n> [run]` | Backward-compatible alias for additional collection |
| `/agent focus <node>` | Move focus to node (safe jump) |
| `/agent graph [run]` | Show graph state |
| `/agent resume [run] [checkpoint]` | Resume from latest/specific checkpoint |
| `/agent retry [node] [run]` | Retry node |
| `/agent jump <node> [run] [--force]` | Jump node |
| `/agent budget [run]` | Show budget usage |
| `/model` | Open arrow-key selector for model and reasoning effort |
| `/approve` | Approve current node |
| `/retry` | Retry current node |
| `/settings` | Edit defaults |
| `/quit` | Exit |

Collect options:

- `--run <run_id>`
- `--limit <n>`
- `--additional <n>`
- `--last-years <n>`
- `--year <spec>`
- `--date-range <start:end>`
- `--sort <relevance|citationCount|publicationDate|paperId>`
- `--order <asc|desc>`
- `--field <csv>`
- `--venue <csv>`
- `--type <csv>`
- `--min-citations <n>`
- `--open-access`
- `--bibtex <generated|s2|hybrid>`
- `--dry-run`

Examples:

- `/agent collect --last-years 5 --sort relevance --limit 100`
- `/agent collect "agent planning" --sort citationCount --order desc --min-citations 100`
- `/agent collect --additional 200 --run <run_id>`

## Command Palette

- Type `/`: open command list
- `Tab`: autocomplete
- `Up/Down`: navigate candidates
- `Enter`: execute
- Run suggestions include `run_id + title + current_node + status + relative time`

## Run Metadata (v3)

`runs.json` stores:

- `version: 3`
- `workflowVersion: 3`
- `currentNode`
- `graph` (`RunGraphState`)
- `nodeThreads` (`Partial<Record<GraphNodeId, string>>`)
- `memoryRefs` (`runContextPath`, `longTermPath`, `episodePath`)

Legacy runs are auto-migrated to v3 on load.

## Generated Paths

- `.autoresearch/config.yaml`
- `.autoresearch/runs/runs.json`
- `.autoresearch/runs/<run_id>/checkpoints/*`
- `.autoresearch/runs/<run_id>/memory/*`
- `.autoresearch/runs/<run_id>/paper/*`

## Development

```bash
npm run build
npm test
npm run test:smoke:natural-collect
npm run test:smoke:natural-collect-execute
npm run test:smoke:ci
```

Smoke note:
- `test:smoke:natural-collect` runs in `/test` and verifies PTY flow for
  natural-language collect request -> pending `/agent collect ...` command.
- `test:smoke:natural-collect-execute` runs in `/test` and verifies
  natural-language collect request -> `y` execute -> collect artifacts created.
- It uses `AUTORESEARCH_FAKE_CODEX_RESPONSE` to avoid live Codex calls.
- Execute smoke also uses `AUTORESEARCH_FAKE_SEMANTIC_SCHOLAR_RESPONSE`.
- `test:smoke:ci` runs CI-mode smoke selection.
  - Default mode: `pending`
  - Set `AUTORESEARCH_SMOKE_MODE=execute` or `AUTORESEARCH_SMOKE_MODE=all`
    to switch scenarios in CI.
