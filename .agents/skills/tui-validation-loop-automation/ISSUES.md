---
name: tui-validation-loop-automation
description: 작업이 test/ 하위 실제 TUI 검증을 반복 수행하면서, 문제를 기록하고, 최소 수정 후 재검증하고, ISSUES.md를 갱신하는 자동화 루프일 때 이 스킬을 사용합니다.
---

# TUI 검증루프 자동화

## 목적
`test/` 하위 워크스페이스에서 실제 TUI 검증을 반복 실행하여,
문제를 재현하고,
`ISSUES.md`에 구조적으로 기록하고,
가장 작은 수정만 적용한 뒤,
같은 플로우를 다시 검증하고,
인접 회귀까지 확인하는 자동화 루프를 수행합니다.

이 스킬의 핵심은 **“수정”보다 “실검증 기반 재현-기록-재검증 루프”를 우선**하는 것입니다.

## 이 스킬을 사용하는 경우
다음과 같은 요청일 때 사용합니다:

- "TUI 실검증을 계속 반복해줘"
- "문제 해결될 때까지 TUI 검증 루프를 자동화해줘"
- "test/ 에서 실검증 → 수정 → 재검증을 반복해줘"
- "ISSUES.md를 갱신하면서 라이브 검증 루프를 돌려줘"
- "fresh session / existing session 비교까지 포함해서 반복 검증해줘"
- "실제 TUI 기준으로 고착 지점을 찾아서 계속 줄여줘"

대표적인 트리거 문구:
- "검증루프 자동화"
- "TUI 검증 반복"
- "실검증 사이클"
- "재현하고 고치고 다시 검증"
- "ISSUES.md 업데이트하면서 진행"
- "test/ 기준 라이브 검증"

## 이 스킬이 다루는 기본 원칙
1. **실제 TUI 동작이 1차 진실원천이다.**
2. **수정보다 먼저 재현과 기록을 한다.**
3. **항상 `test/` 하위에서 작업한다.**
4. **항상 가장 작은 수정만 시도한다.**
5. **같은 플로우로 재검증하기 전에는 해결 선언을 하지 않는다.**
6. **관찰된 사실과 가설을 분리한다.**
7. **필요하면 fresh session과 existing session을 반드시 비교한다.**
8. **persisted artifact와 UI 표시가 다를 수 있음을 항상 의심한다.**

## 기본 작업 디렉토리 규칙
- 실검증용 워크스페이스는 반드시 `test/` 하위에 둡니다.
- 실검증 중 생성되는 임시 연구 워크스페이스, 산출물, 로그, 실행 흔적도 `test/` 기준으로 관리합니다.
- 애플리케이션 소스 수정은 루트 소스에 반영하되, **검증 실행 자체는 `test/` 컨텍스트를 기준으로 수행**합니다.

예시:
- `test/tui-live-cycle-<timestamp>-iterN`
- `test/<issue-slug>-live-loop`
- `test/<brief-name>-validation`

## 루프 계약
한 번의 루프(iteration)는 항상 아래 순서를 따릅니다.

1. **검증 목표 고정**
   - 이번 반복에서 확인할 플로우를 한 문장으로 고정합니다.
   - 예: `/new -> /brief start --latest -> implement_experiments -> run_experiments`

2. **현재 상태 수집**
   - 세션 종류(fresh / existing)
   - 워크스페이스 경로
   - run id
   - 관련 artifact
   - 현재 화면 증상
   - 최근 실패 지점

3. **실제 재현**
   - 가능한 한 같은 명령, 같은 순서, 같은 조건으로 재현합니다.
   - 재현 절차는 다른 에이전트가 그대로 따라 할 수 있을 정도로 구체적으로 남깁니다.

4. **구조적 기록**
   - `ISSUES.md`에 아래 항목을 append-only 방식으로 기록합니다.
   - 필수 항목:
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

5. **문제 분류**
   - 아래 중 하나의 지배적 분류를 반드시 명시합니다:
     - `persisted_state_bug`
     - `in_memory_projection_bug`
     - `refresh_render_bug`
     - `resume_reload_bug`
     - `race_timing_bug`

6. **최소 수정**
   - 가장 작은 원인 경계만 수정합니다.
   - 넓은 리팩터링, UX 계약 변경, 상태모델 재설계는 금지합니다.
   - 수정 목적은 “현재 루프의 단일 실패 경계 축소”여야 합니다.

7. **테스트 보강**
   - 가능하면 해당 경계를 잡는 단위 테스트 또는 회귀 테스트를 추가합니다.
   - 단, 테스트 추가만으로 live 검증을 대체하지 않습니다.

8. **동일 플로우 재검증**
   - 반드시 같은 흐름으로 다시 실행합니다.
   - 해결 여부는 재실행 결과로만 판단합니다.

9. **인접 회귀 확인**
   - 바로 인접한 재개/새 세션/화면 갱신/아티팩트 반영 흐름을 점검합니다.

10. **반복 여부 결정**
   - 성공: 다음 병목으로 이동
   - 실패: 같은 이슈를 더 좁은 가설로 계속 반복
   - 불확실: 계측 추가 후 다시 반복

## 출력 형식
각 반복 결과는 항상 다음 섹션으로 요약합니다.

1. 이번 반복 목표
2. 워크스페이스 / 세션 컨텍스트
3. 실행한 실제 절차
4. 기대 동작
5. 실제 동작
6. fresh vs existing 비교
7. artifact vs UI 비교
8. 원인 가설
9. 적용한 수정
10. 추가/수정한 테스트
11. 재검증 결과
12. 남은 리스크
13. 다음 반복 결정

## ISSUES.md 갱신 규칙
- `ISSUES.md`는 **append-only 라이브 검증 기록**으로 취급합니다.
- 기존 항목을 지우기보다:
  - 새 iteration log를 추가하고
  - 상태(open / re-validating / blocked / fixed)를 갱신하고
  - 관련 코드/테스트 변경과 재검증 결과를 누적합니다.
- “고쳤다”가 아니라 **“같은 플로우 재검증에서 미재현”**으로 기록합니다.

## fresh vs existing session 규칙
다음 상황에서는 비교를 생략하지 마십시오:

- 기존 세션에서만 stale 해 보이는 경우
- resume 후 표시가 이상한 경우
- artifact는 맞는데 UI summary가 틀린 경우
- 재시작하면 증상이 사라지는 경우
- refresh / subscription / projection 문제가 의심되는 경우

비교 시 반드시 기록할 것:
- fresh session 결과
- existing session 결과
- divergence 유무
- divergence가 시작되는 단계

## artifact vs UI 비교 규칙
항상 다음을 분리해서 봅니다:
- persisted artifact
- 런타임 메모리 상태
- 최상위 UI summary
- 상세 화면/세부 출력

다음 착각을 금지합니다:
- artifact가 맞으니 UI도 맞을 것이라는 가정
- 화면이 맞아 보이니 persisted 상태도 맞을 것이라는 가정

## 허용되는 수정 방식
우선순위:
1. 경계 조건 수정
2. resume/load 경로 수정
3. projection/aggregation 수정
4. refresh/render 연결 수정
5. 최소 계측 추가

신중해야 하는 것:
- 상태 구조 전면 변경
- slash command 계약 변경
- 9-node 워크플로우 의미 변경
- TUI/web UX 계약 변경

## 금지사항
- 재현 전에 바로 수정하지 마십시오.
- `test/` 밖의 임시 검증 워크스페이스를 만들지 마십시오.
- live 검증 없이 테스트 통과만으로 해결 선언하지 마십시오.
- 관찰과 추측을 섞어 쓰지 마십시오.
- 한 번에 여러 실패 경계를 동시에 고치지 마십시오.
- unrelated refactor를 끼워 넣지 마십시오.

## 좋은 완료 기준
다음 조건을 만족하면 한 이슈에 대한 루프를 종료할 수 있습니다:

- 증상이 재현 가능하게 기록되어 있고
- 원인 경계가 하나의 주요 분류로 좁혀졌고
- 최소 수정이 적용되었고
- 관련 테스트가 보강되었거나 기존 테스트가 갱신되었고
- 같은 TUI 플로우 재검증에서 더 이상 재현되지 않고
- 인접 흐름에서 치명적 회귀가 보이지 않고
- `ISSUES.md`에 재현, 수정, 재검증, 남은 리스크가 모두 기록됨

## 권장 실행 태도
- 한 번에 완벽히 고치려 하지 말고 **병목을 한 단계씩 줄입니다.**
- 각 반복은 “무엇을 배웠는가”를 남겨야 합니다.
- 실패한 반복도 가치가 있으며, 반드시 다음 가설의 입력으로 축적합니다.

## 예시 목표 문장
- `test/` 하위 fresh TUI 세션에서 `/new -> /brief start --latest` 실행 후 implement 단계 고착 원인을 줄인다.
- existing session에서만 발생하는 stale summary 문제를 fresh session과 비교해 `resume_reload_bug`인지 확인한다.
- artifact는 정상인데 TUI 상단 요약이 뒤처지는 문제를 `in_memory_projection_bug` 관점에서 재현하고 축소한다.