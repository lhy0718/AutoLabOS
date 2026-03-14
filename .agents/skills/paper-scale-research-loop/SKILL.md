---
name: paper-scale-research-loop
description: 작은 실험을 실제로 돌릴 수 있는 연구 주제를 택해, 논문 작성 가능 스케일의 관련논문을 수집하고, 가설을 세우고, baseline/ablation을 포함한 실험을 실행하고, 결과와 한계를 갖춘 paper-ready 원고까지 밀어붙일 때 이 스킬을 사용합니다.
---

# Paper-Scale Research Loop

## 목적
이 스킬은 “시스템이 끝까지 도는가”를 넘어서,
**실제로 검증 가능한 연구 질문을 선택하고,
논문 작성이 가능한 규모와 밀도의 관련연구를 수집하고,
반증 가능한 가설을 세우고,
작지만 실제인 실험을 수행하고,
결과 표와 한계를 포함한 원고를 만드는 것**을 목표로 합니다.

이 스킬의 핵심은 **“논문처럼 보이는 문서”보다 “실제로 검증된 연구 주장”**을 우선하는 것입니다.

## 이 스킬을 사용하는 경우
사용자가 다음을 원할 때 이 스킬을 사용합니다:

- “테스트 수준 말고 실제 작은 실험이 들어간 논문이 보고 싶다”
- “논문 작성 가능 스케일로 논문들을 수집해서 연구를 해라”
- “가설을 세우고 baseline이 있는 실험을 실제로 돌려라”
- “완주보다 paper-ready 수준을 올려라”
- “survey가 아니라 experiment paper를 만들어라”
- “실험이 포함된 완성도 있는 원고를 내라”

대표적인 트리거 문구:
- “논문 가능 스케일”
- “작은 실험”
- “baseline 포함”
- “실험 논문”
- “paper-ready”
- “수치 결과가 있는 논문”

## 이 스킬이 강제하는 구분
다음을 명시적으로 구분합니다:

- **workflow completed**
- **write_paper completed**
- **paper-shaped draft**
- **paper-ready experimental manuscript**

앞의 세 가지는 충분하지 않습니다.
마지막 상태를 목표로 할 경우, 아래 hard gate를 통과해야 합니다.

## Hard Gate: Paper-Worthy Minimum
다음 중 하나라도 만족하지 못하면 `paper_ready=false` 또는 `blocked_for_paper_scale`입니다.

1. 연구 질문이 명시적이고 검증 가능해야 한다.
2. 관련연구가 단순 title/abstract 나열이 아니라, 최소 일부는 본문 근거에 기반해야 한다.
3. 수집 코퍼스가 작은 테스트 샘플이 아니라, 주제 축 커버리지를 갖춰야 한다.
4. 가설이 반증 가능해야 한다.
5. 최소 1개 이상의 명시적 baseline 또는 comparator가 있어야 한다.
6. 최소 1개 이상의 실제 실험 실행 결과가 있어야 한다.
7. 결과 섹션에 숫자 표 또는 핵심 정량 비교가 있어야 한다.
8. 주요 주장마다 claim→evidence 연결이 있어야 한다.
9. 실패 실험 또는 한계가 원고에 포함되어야 한다.
10. workflow validation 자체가 논문의 핵심 기여가 되어서는 안 된다.

## blocked 처리 조건
다음은 자동으로 blocked 또는 downgrade 대상입니다.

- 실험 없이 literature-only 초안만 생성됨
- baseline 없이 자기 방법만 서술함
- run trace를 연구 기여로 오인함
- 근거 없는 novelty claim
- 표/수치 없는 결과 섹션
- abstract-only evidence에 과도하게 의존함
- toy smoke experiment를 주요 실험 근거로 사용함
- 시스템 검증 보고서를 실험 논문처럼 포장함

## 연구 주제 선택 원칙
좋은 주제는 다음을 만족해야 합니다:

- 작은 범위에서도 실제 실험이 가능하다
- 데이터셋, 태스크, 메트릭, baseline을 확보할 수 있다
- 구현/실행 예산이 과도하지 않다
- 1~3일 규모의 작은 실험으로도 유의미한 차이를 볼 수 있다
- 관련연구가 너무 빈약하지 않다
- negative result여도 논리적으로 의미가 있다

## 코퍼스 수집 기준
단순히 많이 모으는 것이 아니라, 다음 축별 커버리지를 요구합니다:

- seminal paper
- recent paper
- baseline paper
- method paper
- evaluation paper
- task/dataset paper

코퍼스 요약 시 반드시 기록:
- 총 수집 수
- full text 확보 수
- abstract-only 수
- 주제 축별 편중 여부
- downstream experiment에 실제로 쓰이는 핵심 subset

## 가설 기준
가설은 반드시 다음을 포함해야 합니다:

- 독립변수
- 종속변수
- 예상 메커니즘
- baseline 대비 기대 변화
- 반증 조건

좋지 않은 예:
- “이 방식이 더 좋을 수 있다”
- “이 연구는 의미가 있다”

좋은 예:
- “X 설정이 작은 tabular classification 과제에서 logistic regression 대비 macro-F1를 평균 0.5pt 이상 개선할 것이다. 개선이 없거나 runtime 비용이 과도하면 기각한다.”

## 실험 설계 기준
반드시 포함:
- dataset / task / bench
- objective metric
- baseline / comparator
- ablation 또는 controlled variation
- compute/time budget
- stopping rule
- failure condition
- reproducibility artifact

## 출력 형식
항상 다음 섹션을 포함합니다:

1. 연구 질문
2. 왜 이 주제가 작은 실제 실험으로 검증 가능한가
3. 코퍼스 규모와 포함/제외 기준
4. 관련연구 핵심 축과 research gap
5. 가설과 반증 조건
6. 실험 설계
7. baseline / comparator
8. dataset / task / metric
9. 실제 실행된 실험
10. 결과 표와 핵심 수치
11. 실패 실험 / 음성 결과
12. claim→evidence 매핑
13. paper-ready 판정
14. 재현성 자산
15. 남은 약점과 다음 반복

## 리뷰 단계 규칙
`review`에서 아래 중 하나라도 참이면 `write_paper`로 자동 진행하지 않습니다:

- 실제 외부 과제에 대한 실험이 없음
- baseline 없음
- 결과 표 없음
- claim→evidence mapping이 빈약함
- 관련연구가 지나치게 얕음
- workflow validation이 본문 중심을 차지함

이 경우 판정:
- `blocked_for_paper_scale`
- 또는 `downgrade_to_system_validation_note`

## 권장 실행 순서
1. 연구 질문 축소
2. paper-worthy corpus 수집
3. related work 구조화
4. 반증 가능한 가설 명시
5. 실행 가능한 작은 실험 설계
6. baseline 포함 구현
7. 실제 실험 실행
8. 결과 분석 및 표 작성
9. claim→evidence 정리
10. 한계/실패 실험 명시
11. paper-ready 여부 판정
12. 부족하면 다시 반복

## 금지사항
- `write_paper completed`만으로 성공 선언하지 마십시오.
- baseline 없이 실험 논문이라 주장하지 마십시오.
- 실험 없이 결과 섹션을 장식하지 마십시오.
- 내부 workflow artifact를 연구 기여로 대체하지 마십시오.
- 약한 근거를 강한 claim으로 포장하지 마십시오.

## 좋은 완료 기준
다음 조건을 만족하면 이 스킬은 완료입니다:

- paper-worthy 연구 질문이 명확함
- corpus가 논문 작성 가능 스케일로 충분함
- 반증 가능한 가설이 존재함
- baseline/ablation 포함 실험이 실제로 실행됨
- 정량 결과가 표로 정리됨
- claim→evidence 연결이 정리됨
- 한계가 명시됨
- 원고가 paper-ready 또는 명시적 blocked 상태로 정직하게 판정됨