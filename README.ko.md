# AutoResearch (한국어)

언어: [English](./README.md) | **한국어**

AI 에이전트 기반 연구 자동화를 위한 Slash-first TUI 도구입니다.

## 빠른 시작

```bash
npm install
npm run build
npm link
autoresearch
```

개발 모드:

```bash
npm run dev
```

`npm link` 없이 실행하려면 `node dist/cli/main.js`를 사용하면 됩니다.

## 첫 실행

1. 빈 프로젝트에서 `autoresearch`를 실행합니다.
2. `.autoresearch/config.yaml`이 없으면 setup wizard가 자동 시작됩니다.
3. wizard가 설정/스캐폴드를 만든 뒤 대시보드로 진입합니다.

## CLI 정책

- 외부 실행 커맨드는 `autoresearch` 하나만 사용합니다.
- `autoresearch init`은 지원하지 않습니다.
- 실제 운영은 TUI 내부 슬래시 명령으로 수행합니다.

## 상태 그래프 워크플로(v3)

고정 노드 8단계:

1. `collect_papers`
2. `analyze_papers`
3. `generate_hypotheses`
4. `design_experiments`
5. `implement_experiments`
6. `run_experiments`
7. `analyze_results`
8. `write_paper`

기본 엣지는 선형(`1 -> 8`)입니다.

## 런타임 정책

- 체크포인트 저장: `.autoresearch/runs/<run_id>/checkpoints/`
- 체크포인트 phase: `before | after | fail | jump | retry`
- 재시도 정책: `maxAttemptsPerNode=3`
- 자동 롤백 정책: `maxAutoRollbacksPerNode=2`
- 점프 모드:
  - `safe`: 현재/이전 노드만 허용
  - `force`: 미래 노드 점프 허용(중간 노드는 skipped 기록)
- 예산 정책:
  - `maxToolCalls=150`
  - `maxWallClockMinutes=240`
  - `maxUsd=15` (provider 비용 미지원 시 soft-check)

## 에이전트 실행 패턴

- ReAct 루프: `PLAN_CREATED -> TOOL_CALLED -> OBS_RECEIVED`
- ReWOO 분리(Planner/Worker): 고비용 노드 중심
- ToT(Tree-of-Thoughts): 가설/설계 노드에서 사용
- Reflexion: 실패 episode 저장 후 재시도 시 재주입

## 메모리 계층

- RunContextMemory: run 단기 메모리
- LongTermStore: JSONL 기반 장기 요약/색인
- EpisodeMemory: 실패 학습(Reflexion) 전용

## ACI (Agent-Computer Interface)

표준 액션:

- `read_file`
- `write_file`
- `apply_patch`
- `run_command`
- `run_tests`
- `tail_logs`

`implement_experiments`, `run_experiments` 노드는 ACI를 통해 실행됩니다.

## 슬래시 명령어

| 명령어 | 설명 |
|---|---|
| `/help` | 명령 목록 표시 |
| `/new` | run 생성 |
| `/doctor` | 환경 점검 |
| `/runs [query]` | run 목록/검색 |
| `/run <run>` | run 선택 |
| `/resume <run>` | run 재개 |
| `/agent list` | 그래프 노드 목록 |
| `/agent run <node> [run]` | 노드 실행 |
| `/agent status [run]` | 노드 상태 조회 |
| `/agent collect [query] [options]` | 필터/정렬 옵션으로 논문 수집 |
| `/agent recollect <n> [run]` | 추가 수집 하위 호환 alias |
| `/agent focus <node>` | 노드 포커스 이동(safe jump) |
| `/agent graph [run]` | 그래프 상태 출력 |
| `/agent resume [run] [checkpoint]` | 체크포인트 재개 |
| `/agent retry [node] [run]` | 노드 재시도 |
| `/agent jump <node> [run] [--force]` | 노드 점프 |
| `/agent budget [run]` | 예산 사용량 확인 |
| `/model` | 화살표 선택기로 모델/effort 선택 |
| `/approve` | 현재 노드 승인 |
| `/retry` | 현재 노드 재시도 |
| `/settings` | 기본 설정 수정 |
| `/quit` | 종료 |

수집 옵션:

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

예시:

- `/agent collect --last-years 5 --sort relevance --limit 100`
- `/agent collect "agent planning" --sort citationCount --order desc --min-citations 100`
- `/agent collect --additional 200 --run <run_id>`

## 명령 팔레트

- `/` 입력 시 명령 목록 오픈
- `Tab`: 자동완성
- `↑/↓`: 후보 이동
- `Enter`: 실행
- run 후보는 `run_id + title + current_node + status + 상대 시간`을 표시합니다.

## Run 메타데이터(v3)

`runs.json` 주요 필드:

- `version: 3`
- `workflowVersion: 3`
- `currentNode`
- `graph` (`RunGraphState`)
- `nodeThreads` (`Partial<Record<GraphNodeId, string>>`)
- `memoryRefs` (`runContextPath`, `longTermPath`, `episodePath`)

기존 run 데이터는 로드시 자동으로 v3로 마이그레이션됩니다.

## 생성 경로

- `.autoresearch/config.yaml`
- `.autoresearch/runs/runs.json`
- `.autoresearch/runs/<run_id>/checkpoints/*`
- `.autoresearch/runs/<run_id>/memory/*`
- `.autoresearch/runs/<run_id>/paper/*`

## 개발

```bash
npm run build
npm test
npm run test:smoke:natural-collect
npm run test:smoke:natural-collect-execute
npm run test:smoke:ci
```

스모크 테스트 안내:
- `test:smoke:natural-collect`는 `/test` 경로에서 실행되며,
  자연어 수집 요청 -> pending `/agent collect ...` 생성 흐름을 PTY로 검증합니다.
- `test:smoke:natural-collect-execute`는 `/test` 경로에서 실행되며,
  자연어 수집 요청 -> `y` 실행 -> 수집 산출물 생성까지 PTY로 검증합니다.
- 실제 Codex 호출 없이 `AUTORESEARCH_FAKE_CODEX_RESPONSE`를 사용합니다.
- execute 스모크는 `AUTORESEARCH_FAKE_SEMANTIC_SCHOLAR_RESPONSE`도 사용합니다.
- `test:smoke:ci`는 CI 모드 선택 실행입니다.
  - 기본 모드: `pending`
  - CI에서 `AUTORESEARCH_SMOKE_MODE=execute` 또는 `all`로 시나리오를 선택할 수 있습니다.
