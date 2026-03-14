# AGENTS.md

## 목적 (핵심만)
이 저장소는 9-node 연구 워크플로우를 실제 TUI/web 상호작용으로 안정적으로 실행하고, 근거 기반 산출물을 생성하는 시스템이다.

항상 우선순위:

1. 인터랙티브 동작 정확성
2. 상태/아티팩트 일관성
3. 재현 가능한 검증
4. 근거를 넘지 않는 정직한 과학적 서술

## 운영 문서 (상세 정책의 단일 출처)

- `docs/architecture.md`
- `docs/tui-live-validation.md`
- `docs/experiment-quality-bar.md`
- `docs/paper-quality-bar.md`
- `docs/reproducibility.md`
- `docs/live-validation-issue-template.md`

상세 규칙은 위 문서를 우선 참조한다. 이 파일은 고신호 엔트리포인트로 유지한다.

## 필수 작업 원칙

- 큰 변경보다 작고 검증 가능한 수정 우선.
- 복잡 이슈는 수정 전에 짧은 계획 수립.
- 버그 해결 선언 전에 동일 검증 플로우 재실행.
- 라이브 검증 이슈는 `ISSUES.md`에 재현/기대/실제/세션비교/가설/회귀상태를 기록.
- 원고/결과는 claim→evidence 연결이 없으면 수위를 낮추거나 blocked 처리.
- 기존 계약(9-node 흐름, TUI/web UX, 런타임 경계)을 명시적 요구 없이 변경하지 않는다.

## 인터랙티브 버그 분류 (반드시 명시)

- `persisted_state_bug`
- `in_memory_projection_bug`
- `refresh_render_bug`
- `resume_reload_bug`
- `race_timing_bug`

## 완료 기준 (요약)

- 원인 재현 가능 + 패치 후 미재현
- 관련 테스트/스모크/라이브 검증 재실행
- 핵심 아티팩트 일관성 확인
- 인접 회귀 위험 검토
- 남은 리스크를 최종 요약에 명시
