# AGENTS.md

## 목적 (핵심만)
이 저장소는 9-node 연구 워크플로우를 실제 TUI/web 상호작용으로 안정적으로 실행하고,
근거 기반 산출물을 생성하며,
가능하면 paper-ready 수준까지 끌어올리는 시스템이다.

항상 우선순위:
1. 인터랙티브 동작 정확성
2. 상태/아티팩트 일관성
3. 재현 가능한 검증
4. 근거를 넘지 않는 정직한 과학적 서술
5. 실험 논문 목표일 때 paper-ready 최소 기준 충족

## 운영 문서 (상세 정책의 단일 출처)
- `docs/architecture.md`
- `docs/tui-live-validation.md`
- `docs/experiment-quality-bar.md`
- `docs/paper-quality-bar.md`
- `docs/reproducibility.md`
- `docs/live-validation-issue-template.md`
- `docs/research-brief-template.md`

상세 규칙은 위 문서를 우선 참조한다.
이 파일은 고신호 엔트리포인트로 유지한다.

## 필수 작업 원칙
- 큰 변경보다 작고 검증 가능한 수정 우선.
- 복잡 이슈는 수정 전에 짧은 계획 수립.
- 버그 해결 선언 전에 동일 검증 플로우 재실행.
- 라이브 검증 이슈는 `ISSUES.md`에 재현/기대/실제/세션비교/가설/회귀상태를 기록.
- 원고/결과는 claim→evidence 연결이 없으면 수위를 낮추거나 blocked 처리.
- 기존 계약(9-node 흐름, TUI/web UX, 런타임 경계)을 명시적 요구 없이 변경하지 않는다.

## 시스템 완주와 논문 완성의 구분
다음을 절대 혼동하지 않는다:

- workflow completed
- `write_paper` completed
- PDF build success
- paper-ready experimental manuscript

앞의 세 가지는 시스템 실행 완주를 의미할 수 있으나,
논문 제출 가능 수준의 연구 완성을 자동으로 의미하지는 않는다.

실험 논문 목표일 때는 최소한 아래가 있어야 한다:
- 명시적 연구 질문
- paper-worthy 관련연구 코퍼스
- 반증 가능한 가설
- baseline 또는 comparator
- 실제 실행된 실험
- 정량 결과 표
- claim→evidence mapping
- limitations / failure modes

위가 없으면 `paper_ready=false`, `blocked_for_paper_scale`,
또는 `system_validation_note` / `research_memo`로 강등한다.

## 인터랙티브 버그 분류 (반드시 명시)
- `persisted_state_bug`
- `in_memory_projection_bug`
- `refresh_render_bug`
- `resume_reload_bug`
- `race_timing_bug`

## 논문 수준 연구에 대한 추가 원칙
- workflow artifact를 연구 기여로 대체하지 않는다.
- toy smoke experiment를 주요 실험 근거로 사용하지 않는다.
- baseline 없이 실험 논문이라고 주장하지 않는다.
- abstract-only evidence에 과도하게 의존하지 않는다.
- negative result도 허용되지만, 실험 근거와 해석이 있어야 한다.
- 실험이 부족하면 원고의 장르를 낮춰서 명시한다.

## review 단계 원칙
`review`는 단순 문장 다듬기 단계가 아니다.
다음을 확인하는 구조적 gate다:

- readiness
- methodology sanity
- experiment adequacy
- evidence linkage
- writing discipline
- reproducibility handoff

다음이 없으면 `write_paper` 자동 진행을 막는다:
- baseline / comparator
- 결과 표 또는 핵심 정량 비교
- claim→evidence mapping
- 실제 실험 실행 증거
- 최소 수준의 관련연구 깊이

## brief 설계 원칙
`/new`로 생성되는 brief는 단순 아이디어 메모가 아니라
실제 연구 런의 계약 문서다.

brief에는 반드시 다음이 포함되어야 한다:
- Topic
- Objective Metric
- Constraints
- Plan
- Research Question
- Why This Can Be Tested With A Small Real Experiment
- Baseline / Comparator
- Dataset / Task / Bench
- Minimum Experiment Plan
- Paper-worthiness Gate
- Failure Conditions

## ISSUES.md 운영 원칙
`ISSUES.md`는 버그 목록만이 아니라,
라이브 검증 상태와 연구 완성도 리스크를 함께 추적하는 문서다.

반드시 구분해서 기록한다:
- live validation issues
- research completion risks
- paper readiness risks

## 완료 기준 (요약)
작업을 완료로 보고하려면 다음을 만족해야 한다:
- 원인 재현 가능 + 패치 후 미재현
- 관련 테스트/스모크/라이브 검증 재실행
- 핵심 아티팩트 일관성 확인
- 인접 회귀 위험 검토
- 남은 리스크를 최종 요약에 명시

실험 논문 목표인 경우 추가로:
- baseline 포함 실험 실행
- 정량 결과 확보
- claim→evidence 연결 확보
- review gate 통과 또는 명시적 blocked 판정