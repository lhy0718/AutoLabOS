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

필수: Semantic Scholar API key를 `.env`에 넣어야 합니다. (또는 첫 실행 setup wizard에서 입력)
선택: 기본 provider를 `OpenAI API`로 선택하거나 PDF 분석을 `Responses API`로 설정할 경우 `OPENAI_API_KEY`도 필요합니다.

```bash
cp .env.example .env
echo 'SEMANTIC_SCHOLAR_API_KEY=your_key_here' >> .env
echo 'OPENAI_API_KEY=your_openai_key_here' >> .env
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
4. setup wizard는 Semantic Scholar API key를 필수로 묻고, 입력한 값은 `.env`에 기록합니다.
5. setup wizard에서 기본 LLM provider를 선택합니다.
   - `codex`: 메인 워크플로를 Codex ChatGPT 로그인으로 실행
   - `api`: 메인 워크플로를 OpenAI API 모델로 실행 (`OPENAI_API_KEY` 필요)
6. setup wizard에서 PDF 분석 모드도 선택합니다.
   - `codex`: PDF를 로컬에서 텍스트 추출 후 Codex로 분석
   - `api`: PDF를 Responses API로 직접 전달해 분석 (`OPENAI_API_KEY` 필요)
7. 기본 provider로 `api`를 선택하면 setup wizard와 `/settings`에서 OpenAI API 모델도 선택할 수 있습니다.
   - 현재 카탈로그: `gpt-5.4`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`
8. PDF 분석에서 `api`를 선택하면 setup wizard와 `/settings`에서 Responses API PDF 모델도 선택할 수 있습니다.
   - 현재 카탈로그: `gpt-5.4`, `gpt-5`, `gpt-5-mini`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`
9. `/model`은 현재 기본 provider를 따릅니다.
   - Codex provider: Codex 모델 선택기
   - OpenAI API provider: OpenAI API 모델 선택기
10. 실행 시 AutoResearch는 `process.env` 또는 `.env`의 `SEMANTIC_SCHOLAR_API_KEY`, `OPENAI_API_KEY`를 읽습니다.

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

복합 plan의 단계별 승인:

- 자연어 복합 실행 계획은 각 step마다 멈추고 다시 승인받습니다.
- `y`: 다음 step 1개만 실행
- `n`: 남은 plan 취소
- step 실패 후에는 자동 재계획으로 후속 명령이 다시 pending 될 수 있습니다.

## 자연어 입력 지원 범위

AutoResearch는 가능한 모든 문장을 전부 고정 규칙으로 처리하지 않습니다.
대신 지원하는 deterministic intent family를 명시적으로 정의하고, 이 범위는
LLM보다 먼저 slash command 또는 로컬 상태 응답으로 연결합니다. 그 밖의 질문은
workspace 기반 LLM fallback으로 처리합니다.

TUI 안에서 아래처럼 물어보면 현재 지원 목록을 바로 보여줍니다.

- `지원되는 자연어 입력을 보여줘`
- `what natural inputs are supported?`

현재 지원하는 자연어 입력 범주:

1. 도움말 / 설정 / 모델 / 환경 점검 / 종료
   - 예: `도움말 보여줘`, `모델 선택기 열어줘`, `환경 점검해줘`
2. run 라이프사이클
   - 예: `새 run 시작해줘`, `run 목록 보여줘`, `alpha run 열어줘`, `이전 run 재개해줘`
3. run title 변경
   - 예: `run title을 Multi-agent collaboration으로 바꿔줘`
4. 워크플로 구조 / 현재 상태 / 다음 단계
   - 예: `현재 상태 보여줘`, `다음에 뭐 해야 해?`, `워크플로 구조 알려줘`
5. 논문 수집
   - 예: `최근 5년 관련도 순으로 100개 수집해줘`
   - 예: `오픈액세스 리뷰 논문 50개 수집해줘`
   - 예: `논문 200개 더 수집해줘`
   - 예: `기존 논문을 지우고 새 논문 100개 다시 수집해줘`
6. 노드 제어
   - 예: `collect_papers로 이동해줘`, `가설 노드 다시 실행해줘`, `implement_experiments에 집중해줘`
7. 그래프 / 예산 / 승인
   - 예: `그래프 보여줘`, `예산 상태 보여줘`, `현재 노드 승인해줘`, `현재 노드 재시도해줘`
8. 수집된 논문 직접 질의
   - 예: `논문 몇 개 모았어?`
   - 예: `pdf 경로가 없는 논문이 몇 개야?`
   - 예: `citation이 가장 높은 논문이 뭐야?`
   - 예: `논문 제목 3개 보여줘`

구현 위치:

- deterministic 자연어 라우터:
  [src/core/commands/naturalDeterministic.ts](/Users/home/AutoResearchV2/src/core/commands/naturalDeterministic.ts)
- 상태 / 다음 단계 로컬 응답:
  [src/core/commands/naturalAssistant.ts](/Users/home/AutoResearchV2/src/core/commands/naturalAssistant.ts)
- 복합 자연어 실행 계획은 단계별 승인(step-by-step approval)으로 동작합니다.
- 복합 plan이 pending 상태일 때 `a`를 입력하면 남은 단계를 한 번에 모두 실행할 수 있습니다.
- LLM이 만든 plan도 step 실패 시 자동 재계획으로 이어질 수 있습니다.

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
npm run test:smoke:all
npm run test:smoke:natural-collect
npm run test:smoke:natural-collect-execute
npm run test:smoke:ci
```

스모크 테스트 안내:
- smoke harness 파일은 `tests/smoke/` 아래에 있습니다.
- 수동 실행용 예시 workspace는 `/test` 아래에 둡니다.
- smoke는 `/test` 루트 상태를 덮어쓰지 않도록 `/test/smoke-workspace`를 별도 workspace로 사용합니다.
- `test:smoke:natural-collect`는 `/test/smoke-workspace` 경로에서 실행되며,
  자연어 수집 요청 -> pending `/agent collect ...` 생성 흐름을 PTY로 검증합니다.
- `test:smoke:natural-collect-execute`는 `/test/smoke-workspace` 경로에서 실행되며,
  자연어 수집 요청 -> `y` 실행 -> 수집 산출물 생성까지 PTY로 검증합니다.
- `test:smoke:all`은 `/test/smoke-workspace` 기준 전체 로컬 smoke 묶음을 실행합니다.
- 실제 Codex 호출 없이 `AUTORESEARCH_FAKE_CODEX_RESPONSE`를 사용합니다.
- execute 스모크는 `AUTORESEARCH_FAKE_SEMANTIC_SCHOLAR_RESPONSE`도 사용합니다.
- `test:smoke:ci`는 CI 모드 선택 실행입니다.
  - 기본 모드: `pending`
  - 추가 모드: `execute`, `composite`, `composite-all`, `llm-composite`, `llm-composite-all`, `llm-replan`
  - CI에서 `AUTORESEARCH_SMOKE_MODE=<mode>` 또는 `all`로 시나리오를 선택할 수 있습니다.
- smoke 출력은 기본적으로 조용하게 동작하며, 전체 PTY 로그가 필요하면 `AUTORESEARCH_SMOKE_VERBOSE=1`을 사용합니다.
