# 워크숍 주제 독립 적대적 문헌·데이터 감사

- 감사 기준일: 2026-07-26
- 범위: 잠정 후보 `artifact-grounded revision closure`와 6개 독립 연구 클러스터의 fresh route 8개
- 증거 범위: 공식 논문, 공식 코드 저장소, 공식 데이터 저장소
- 실행 제한: 유료 API 및 유료 모델 호출 없음
- 로컬 예산: Intel i9-14900K, 논리 CPU 32개, RAM 125 GiB, RTX 4090 24 GB 2장

## 결론

`artifact-grounded revision closure`는 현재 형태로 탈락시킨다. 아이디어의 중요성과 별개로, 공개·허가된 데이터에서 reviewer obligation, 실행 receipt, 수정 후 재검증 결과를 함께 제공하는 독립 gold label을 찾지 못했다. FLAWS는 오류 삽입·위치·수정 문자열을 제공하지만 실행 기반 closure를 제공하지 않고, ReviseBench는 가장 가까운 실제 workspace benchmark이지만 공식 저장소에 코드·데이터 라이선스가 명시되지 않았다. 데이터나 라벨의 의미를 확장 해석해 메우지 않는 fail-closed 기준에서는 실험 주제가 성립하지 않는다.

문헌·데이터·계산 게이트를 모두 통과한 route는 B, D, F, G, I의 다섯 개다. 서로 다른 네 연구 클러스터인 reviewer-edit alignment, multimodal evidence routing, constrained document repair, statistical evaluation governance를 포괄한다. C와 H는 데이터가 좋아도 가장 가까운 선행연구가 핵심 가설과 endpoint를 이미 흡수해 탈락시킨다.

주제 선택 추천은 **후보 I, Evidence-Sufficiency Gates for Budgeted LLM Evaluation**의 동결 파일럿이다. 이 추천은 새로운 concentration bound를 주장하지 않는다. Card et al.의 power analysis, TMLS의 두 이론 보고서, LLM micro-benchmarking, Cer-Eval, CELEUS가 남긴 경계 안에서, 실제 로컬 모델의 item-level prediction log를 사용해 promotion policy의 false promotion, false block, undecided rate, 평가 비용을 직접 재생하는 empirical gate validation만을 주장한다. 5개 공개 benchmark의 21,851개 judge-independent item과 세 공개 모델군으로 자체 log를 만들 수 있고, 이론 보고서들이 명시적으로 수행하지 않은 구현·실제 log·gate-decision 검증을 채운다. 다만 ICLR 2026 micro-benchmarking과 CELEUS가 매우 가까우므로, held-out scenario에서 strongest valid baseline 대비 false promotion을 절대 5%p 이상 낮추고 평가 item을 25% 이상 줄이지 못하면 즉시 탈락시킨다. 그 경우 후보 B를 독립 reserve로 검토하되 자동 승격하지 않는다.

## Fail-Closed 판정 규칙

| 게이트 | 통과 조건 | 탈락 조건 |
|---|---|---|
| G1. 법적 사용 가능성 | 데이터와 코드 각각의 라이선스가 공식 저장소에 명시됨 | 라이선스 없음, `NOASSERTION`, 논문 라이선스만 있고 데이터 라이선스 없음 |
| G2. 실제 접근성 | 인증·승인 없이 핵심 입력과 라벨을 내려받을 수 있음 | 링크만 존재, gated approval 필요, 핵심 파일 누락 |
| G3. 라벨 적합성 | 1차 지표를 직접 계산할 gold label이 존재함 | proxy를 closure, correctness, execution success로 재해석해야 함 |
| G4. 비중복 기여 | 가장 가까운 2025-2026 선행연구와 다른 입력·출력·가설이 한 문장으로 구별됨 | 단순 적용, prompt 변경, 이미 제안된 사용례 |
| G5. 강한 baseline | 같은 공개 입력과 예산에서 재현 가능한 최신 baseline이 있음 | 약한 과거 baseline만 비교하거나 유료 frontier 모델이 필수 |
| G6. 통계 식별성 | 독립 단위, 동결 split, 효과 방향과 최소 효과가 사전 정의됨 | test tuning, 중복 행을 독립 표본으로 계산, 한두 예시 차이 |
| G7. 로컬 완결성 | 2 x RTX 4090에서 3일 이내 핵심 비교 가능 | 외부 대규모 cluster 또는 유료 API가 사실상 필수 |

G1-G3 중 하나라도 실패하면 즉시 탈락한다. G4-G7의 불확실성은 짧은 promotion probe로만 해소하며, 불확실한 상태에서 논문 주제로 확정하지 않는다.

## 공개 데이터 실물 감사

`다운로드 검증`은 실제 파일을 받아 구조·행 수·체크섬을 확인했다는 뜻이다. `API 검증`은 공식 저장소 메타데이터와 비인증 다운로드 응답을 확인했지만 대용량 파일 전체를 받지는 않았다는 뜻이다.

| 자원 | 접근·크기·내용 실사 | 라이선스 | 판정 |
|---|---|---|---|
| [FLAWS 데이터](https://huggingface.co/datasets/xasayi/FLAWS), [코드](https://github.com/xasayi/FLAWS) | 전체 저장량 30,651,328,339 B. `OPENAI_NON_ML.zip` 224,811,852 B를 다운로드 검증했고 SHA-256은 `042738b3e647348a9583934e6ebcfabd89c36f723be897d37784c6b4f1770788`. 표본에는 altered LaTeX/PDF, `original_text`, `modified_text`, 오류 설명·위치가 있었으나 실행 receipt와 reviewer obligation은 없음. 48개 오류·위치 레코드와 49개 altered-paper 폴더의 수 차이도 해소 필요. 데이터 snapshot `a20a57860ed4afc8a046a73abab6bd1222068762`. | 데이터 CC BY 4.0, 코드 MIT | source-level 오류 복구에는 사용 가능. execution-grounded closure gold로는 부적합 |
| [ReviseBench 논문](https://aclanthology.org/2026.findings-acl.887/), [공식 저장소](https://github.com/CGCL-codes/ReviseBench) | 논문은 ICLR 2025 논문 12개 workspace와 camera-ready human baseline을 설명. 저장소는 공개이고 GitHub API상 약 419,983 KiB지만 2026-07-26 현재 `license: null`이며 루트 LICENSE가 없음. | 논문은 CC BY 4.0. 코드·데이터는 불명확 | **G1 탈락**. 라이선스가 추가되기 전 사용 금지 |
| [ARIES 논문](https://aclanthology.org/2024.acl-long.377/), [공식 저장소](https://github.com/allenai/aries) | 비인증 S3에 14개 객체, 약 342 MB. `edit_labels_test.jsonl` 130,783 B, 196행, SHA-256 `e5c827f2572ecbc26e00583ca2ff557b083b8b71a577f4d308aaf00a24c62306`; `review_comments.jsonl` 1,395,177 B, 4,088행, SHA-256 `0f32ce3b66b12385dd2f9d1bb791a8800e80060b1a58c0deddd87bcded3b2b58`. 테스트 라벨에 positive edit IDs와 exhaustive negative edit IDs가 실제 포함됨. 코드 snapshot `5691bae71a101225ed345d0ffc42e47609f03bbb`. | 데이터 ODC-BY 1.0, 코드 Apache-2.0 | **G1-G3 통과** |
| [FindTheFlaws 논문](https://ojs.aaai.org/index.php/AAAI/article/view/41123), [공식 저장소](https://github.com/modulo-research/findtheflaws) | `datasets.zip` 1,889,237 B 다운로드 검증, SHA-256 `710bc9b9d0b99226372062592d2072b39b0b7bc7ecfabc6698f334c6342fafd0`. 공개 암호로 정상 해제 후 CSV 8,958,861 B. 총 1,712행, `flag_unreliable_data` 제외 1,513행. modified GPQA와 TheoremQA에 `step_of_injected_flaw`가 실제 존재. snapshot `58bea513102bb5fe7921603394f3319fca64975a`. | 저장소 CC0-1.0. 제3자 원천은 GPQA·TheoremQA·MedQA MIT, CodeNet Apache-2.0으로 별도 명시 | **G1-G3 통과** |
| [PRISMM-Bench 논문](https://openreview.net/forum?id=mjkGXdgm4T), [공식 저장소](https://github.com/da-luggas/prismm-bench), [데이터](https://huggingface.co/datasets/daluggas/PRISMM-Bench) | API 검증. 단일 parquet 1,182,058,841 B, 384 test행, 추정 decoded 크기 134,991,029 B. 각 행에 full PDF, page/bbox, text/image parts, identification/remedy/pair-match labels가 있음. 비공개 gate 없음. dataset snapshot `bd300ce513d8b59e82a86e1a018ba041285d432c`. 초기 arXiv 설명의 262개/242편과 현재 저장소의 384개/353편이 달라 snapshot 고정이 필수. | 데이터·코드 Apache-2.0 | **G1-G3 통과**, test-only 위험 |
| [SciFact 논문](https://aclanthology.org/2020.emnlp-main.609/), [공식 저장소](https://github.com/allenai/scifact) | `data.tar.gz` 3,115,079 B 다운로드 검증, SHA-256 `11c621288d41ac144d29b13b0f8503b3820b7d6e8b1f6ff24dff335c196d76be`. train 809, dev 300, test 300, corpus 5,183행. train/dev에는 stance와 rationale label이 있고 공식 test gold는 비공개. 5-fold split 제공. | claims·evidence annotations CC BY 4.0, S2ORC abstracts ODC-BY 1.0, 코드 Apache-2.0 | **G1-G3 통과**, 그러나 G4 탈락 |
| [DELEGATE-52 논문](https://arxiv.org/abs/2604.15597), [공식 저장소](https://github.com/microsoft/DELEGATE52), [데이터](https://huggingface.co/datasets/microsoft/delegate52) | `delegate52.jsonl` 19,137,584 B 다운로드 검증, SHA-256 `5618f5ab6394e1d2befde3bc8dd50e247bbc872472999eafd9f075c734b488d4`. snapshot `9d325644687cc69533f8070e4decfc9cbf057b12`에는 234 work-environment행, 48 `sample_type`, 1,863 states, 3,258 prompts가 있다. 논문의 310 environments·52 domains·2,125 tasks와 release가 다르므로 실험은 snapshot 수치만 사용한다. 모든 행은 `ok_to_redistribute=yes`지만 원문별 `context_license`가 이질적이다. permissive whitelist를 적용하면 20 domains, 98 rows가 남는다. | 데이터 CDLA-Permissive-2.0, 코드 MIT. 포함 원문의 개별 라이선스도 별도 준수 | **G1-G3 통과**, permissive subset만 허용 |
| [CodeTraceBench 논문](https://arxiv.org/abs/2604.11641), [공식 저장소](https://github.com/NJU-LINK/CodeTracer), [데이터](https://huggingface.co/datasets/NJU-LINK/CodeTraceBench) | parquet 984,091 B 다운로드 검증, SHA-256 `ae5926b496f2f7f4c3f6337c0ad6150311d3650c5f3bd00660556b3e41739505`. 1,000 verified rows, 46,539 steps, 405 trajectories에 incorrect labels, 1,695 incorrect-step IDs와 224 unuseful-step IDs가 있다. 전체 저장량 1,086,734,335 B, snapshot `aa213b84ffb6690fc37ca15766d6ca174ec36d4d`. | 데이터·코드 MIT | **G1-G3 통과**, 그러나 G4 탈락 |
| Budgeted-evaluation 공개 task 묶음 | [ARC-Challenge](https://huggingface.co/datasets/allenai/ai2_arc) test 1,172, [TruthfulQA MC](https://huggingface.co/datasets/truthfulqa/truthful_qa) 817, [MMLU-Pro](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro) test 12,032, [BIG-Bench Hard](https://github.com/suzgunmirac/BIG-Bench-Hard) 6,511, [GSM8K](https://github.com/openai/grade-school-math) test 1,319로 총 21,851 item. 다섯 자원 모두 ungated이며 표본 parquet를 다운로드·해시 검증했다. 평가 parquet 합계 약 5.71 MB, 저장소 reported storage 합계 약 420.35 MB. exact multiple-choice 또는 exact numeric endpoint가 있어 LLM judge가 필요 없다. | ARC CC BY-SA 4.0, TruthfulQA Apache-2.0, MMLU-Pro data card MIT·공식 코드 Apache-2.0, BBH MIT, GSM8K MIT | **G1-G3 통과**. 자체 local-model prediction log 생성 가능 |
| [Dycke & Gurevych 2026 counterfactual review data](https://tudatalib.ulb.tu-darmstadt.de/handle/tudatalib/4802), [공식 코드](https://github.com/UKPLab/tacl2026-counter-review-logic) | 논문은 133 papers의 counterfactual 931개를 설명한다. 저장소 약 641.5 MB의 papers, blueprints, counterfactuals, replication 파일이 열거되지만 모두 `File access restricted`로 request-a-copy가 필요하다. 코드 snapshot `47c8efa779fe6e633978b51066b58465fb7564b9`은 공개다. | 데이터 메타데이터 CC BY 4.0, 코드 Apache-2.0 | **G2 탈락**. prior로만 사용, 실험 데이터로 사용 금지 |
| [Micro-benchmarking 공식 코드](https://github.com/dill-lab/micro-benchmarking-reliability)와 cached predictions | 코드 snapshot `e5391177aee49427b281d92e610ad0f798114be6`은 공개이고 MIT다. README가 연결한 약 550 MB cached leaderboard predictions는 Google Drive에 있으나 독립 데이터 라이선스를 확인하지 못했다. | 코드 MIT, cached predictions 불명확 | 코드 재현은 가능. **prediction reuse는 G1 탈락** |
| [CELEUS 공식 저장소](https://github.com/zyecs/celeus) | 논문은 finite-pool real-log 실험을 보고하지만, 2026-07-26 저장소에는 루트 LICENSE와 핵심 실험 log가 없고 README의 향후 MIT 표기만 확인된다. | 현재 code·data license 불완전 | **G1-G2 탈락**. 코드·로그를 복사하지 않고 논문 식만 독립 구현 |

Budgeted-evaluation 파일의 실물 검증값은 다음과 같다. BBH는 전체 27개 config의 API 합계 669,583 B 중 한 config를 직접 받았고, 나머지 네 task는 핵심 evaluation parquet 전체를 받았다.

| task | 검증 파일 크기 | SHA-256 |
|---|---:|---|
| ARC-Challenge test | 203,808 B | `62f03257e737aed263f55c6abf87c7bb0028a44a6bdd2a26eb1279eb42c1d1e9` |
| TruthfulQA MC validation | 271,033 B | `23f08e230ca4ed66babf3a72419af7cbde1f3d734dd396ac4cf6d088bd162afd` |
| MMLU-Pro test | 4,144,185 B | `0e24a191921c2f453518a537a8b2117bd137e7714d4ef1565e9ba06c1ecb9ad8` |
| BBH sampled config | 4,700 B | `70a3ce074eddfdcac49471c62214a09d1a3f25d25f66f18091d57d0a2d0810f7` |
| GSM8K main test | 419,088 B | `ee7b8da9e381df27b9e3f7758a159ab2bdaa4dbaa910546cbbc47e0cb44e4f59` |

## 후보 비교 요약

| 후보 | 데이터·라벨 | 비중복성 | 1차 지표 식별성 | 3일 로컬 실행 | 2026 워크숍 적합성 | 판정 |
|---|---|---|---|---|---|---|
| A. Artifact-Grounded Revision Closure | 실패 | 이론적 구별은 가능하나 gold 없음 | 계산 불가 | 실행 자체는 가능하나 연구 검증 불가 | REALM 주제 적합, 증거 부적합 | **KILL** |
| B. Atomic-Obligation Comment-Edit Alignment | 통과 | ARIES의 간접 정렬 난점을 atomic obligation으로 명시적으로 모델링 | 명확 | 가능 | REALM 매우 높음, DocInsights 높음 | **VIABLE RESERVE** |
| C. False-Accusation-Constrained Exact Flaw Localization | 통과 | FindTheFlaws·MR-Ben·BIG-Bench Mistake가 first-error와 false-positive 축을 이미 흡수 | 명확 | 가능 | REALM 높음 | **KILL: PRIOR ABSORPTION** |
| D. Dual-Evidence Routing for PRISMM | 통과 | reviewer-flagged 모순의 두 evidence element retrieval로 한정 | 가능하나 test-only | 가능하지만 촉박 | DocInsights 매우 높음, REALM 중간 | **RESERVE / SPLIT RISK** |
| E. Construction-Aware Scientific Abstention | 통과 | 2022·2026 직접 선행연구가 핵심을 흡수 | 명확 | 가능 | GroundLM 개념 적합, direct deadline 종료 | **KILL: PRIOR ABSORPTION** |
| F. Localization-to-Minimal-Source-Repair on FLAWS | 통과 | detection이 아니라 gold-localized scientific error의 minimal source patch를 검증 | 명확 | 가능 | REALM 중간, document reasoning 높음 | **VIABLE RESERVE** |
| G. Anchored Patch Containment on DELEGATE-52 | permissive subset 통과 | 동일 모델·예산에서 full rewrite, search/replace, anchored patch representation을 격리 비교 | 명확 | 가능 | REALM 높음 | **VIABLE RESERVE** |
| H. Context-Budgeted Failure-Evidence Retrieval on CodeTraceBench | 통과 | 원 논문이 stage·within-stage evidence retrieval과 matched-token 평가를 이미 수행 | 명확 | 가능 | REALM 높음 | **KILL: PRIOR ABSORPTION** |
| I. Evidence-Sufficiency Gates for Budgeted LLM Evaluation | 통과 | 수식이 아니라 실제 paired prediction log의 3-way promotion operating characteristics를 검증 | 명확 | 가능 | UncertaiNLP 매우 높음 | **PROMOTE TO FROZEN PILOT** |

## 후보 A. Artifact-Grounded Revision Closure

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | reviewer comment를 수정·실행·재검증 가능한 obligation으로 변환하고, 검증 실패 시 관련 노드로 backtrack하면 실제 연구 산출물의 closure가 개선되는가 |
| Closest priors | [ReviseBench](https://aclanthology.org/2026.findings-acl.887/)는 실제 paper interpretation, experiment implementation, paper formulation을 평가한다. [FLAWS](https://arxiv.org/abs/2511.21843)는 과학 논문 오류 삽입·탐지·위치화를 다룬다. [PaperBench](https://openai.com/index/paperbench/)는 20개 논문 재현을 8,316개 rubric task로 분해한다. [DELEGATE-52](https://arxiv.org/abs/2604.15597)는 52개 문서 도메인의 장기 편집 corruption을 평가한다. [Mnemosyne](https://arxiv.org/abs/2607.00269)는 제안 action을 deterministic constraint로 admission하고 evidence-preserving repair를 수행한다. |
| 명시적 비중복 기여 | 가능한 차별점은 "reviewer obligation별 실행 receipt와 claim-evidence 상태를 묶어 미충족 obligation만 원인 노드로 되돌리는 연구 revision protocol"이다. 그러나 이 차별점은 현재 공개 gold label로 측정되지 않아 기여가 아니라 설계 주장에 머문다. |
| 공개 데이터 | FLAWS는 다운로드·라이선스 통과지만 실행 closure가 없다. ReviseBench는 task가 가장 가깝지만 코드·데이터 라이선스가 불명확해 사용 불가. AutoLabOS 자체 산출물은 독립 평가 자료가 아니므로 gold로 인정하지 않는다. |
| 가장 강한 현실적 baseline | ReviseBench의 human camera-ready revision과 동일 workspace에서의 frontier revision agent가 개념상 baseline이다. 라이선스 게이트 때문에 허용된 로컬 baseline을 구성할 수 없다. 단순 source-edit validator는 closure 전체의 baseline이 아니다. |
| Candidate-owned primary metric | `obligation closure rate` 최대화: 독립 reviewer obligation 중 수정 diff, 필요한 실행 receipt, 결과 artifact, claim-evidence link를 모두 통과한 비율. 최소 의미 효과는 +10%p, unsupported-claim introduction은 0건이어야 한다. 현재 공개 label로 계산 불가. |
| 통계 설계 | workspace를 독립 cluster로 둔 paired bootstrap과 obligation-level hierarchical model이 필요하다. 12개 workspace만으로는 정밀도가 낮고, 라이선스 문제 이전에도 paper-level 일반화 주장이 어렵다. |
| 예상 자원 | 허용된 benchmark가 생긴다는 가정에서 CPU 4-12시간, GPU 20-80시간, wall time 2-5일. 현재는 데이터 게이트에서 실행 중단. |
| Falsifier | 동일 입력·예산의 deterministic checklist 또는 single-review pass와 비교해 closure가 개선되지 않거나, 개선이 cosmetic edit 증가로만 설명됨 |
| Early kill signal | 이미 발생: execution receipt·review obligation·재검증을 함께 제공하는 허가된 gold가 없음 |
| 실패 시 정보가치 | 새 benchmark가 최소한 제공해야 할 schema를 확정할 수 있음: obligation, required evidence, executable check, expected artifact, allowed claim change, closure label |
| 워크숍 적합성 | [REALM 2026](https://realm-workshop.github.io/call_for_papers/)의 long-horizon agent evaluation과 잘 맞지만, 현재 상태는 system proposal 또는 benchmark design note이지 empirical workshop paper가 아님 |
| 최종 판정 | **KILL AS EMPIRICAL TOPIC**. 별도 데이터 구축 프로젝트로만 재개 가능 |

## 후보 B. Atomic-Obligation Comment-Edit Alignment

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 복합 reviewer comment를 `(action, object, scope, evidence requirement)` 원자 obligation으로 분해하면 실제 저자 편집과의 정렬, 특히 간접 코멘트 정렬이 개선되는가 |
| Closest priors | [ARIES](https://aclanthology.org/2024.acl-long.377/)는 comment-edit alignment를 정의하고 best GPT-4 micro-F1 27.0, human 70.7을 보고하며 간접 코멘트에서 큰 하락을 보인다. [Comment Ranking and Edit Anchoring](https://aclanthology.org/D19-1505/)은 Wikipedia comment-edit 관계를 다룬다. [ReviewScore](https://arxiv.org/abs/2509.21679)는 review point의 explicit·implicit premise를 복원해 factuality를 평가한다. [XtraGPT](https://aclanthology.org/2026.acl-long.47/)는 section-level revision generation을 학습하고, [ReviseBench](https://aclanthology.org/2026.findings-acl.887/)는 full-workspace revision을 평가한다. |
| 명시적 비중복 기여 | generation, full-paper revision, premise factuality가 아니라 **한 reviewer comment의 암묵적 요구를 원자 obligation으로 표준화한 뒤 기존 gold edit set을 찾아내는 alignment 가설**이다. 가장 강한 흡수 반론은 ReviewScore의 premise reconstruction을 retrieval query로 전용하면 같은 효과가 난다는 것이다. 따라서 paraphrase expansion뿐 아니라 premise-decomposition query baseline도 이겨야 비중복성을 인정한다. |
| 공개 데이터 | ARIES 약 342 MB, 196 expert test comments, 4,088 review comments, source/target S2ORC paper text, gold positive와 exhaustive negative edit IDs. 데이터 ODC-BY 1.0, 코드 Apache-2.0. |
| 가장 강한 현실적 baseline | 원 논문의 BM25, SPECTER2, DeBERTa, LinkBERT를 재현하고, 공개 [BGE reranker v2 M3](https://huggingface.co/BAAI/bge-reranker-v2-m3) 0.6B를 동일 candidate set에 적용한다. dev threshold를 고정한 BGE raw, local-model paraphrase expansion, ReviewScore식 premise decomposition + 동일 reranker를 필수 통제로 둔다. |
| Candidate-owned primary metric | expert test의 comment-edit **micro-F1 최대화**. 최소 의미 효과는 strongest baseline 대비 +5%p. Precision은 baseline 대비 2%p 넘게 하락하면 실패. ARIES가 정의한 indirect-comment subset의 F1을 사전 지정 key secondary로 둔다. |
| 통계 설계 | test는 마지막 한 번만 사용. threshold와 prompt는 dev에서 동결. source paper 단위 10,000회 paired cluster bootstrap으로 95% CI 계산. 동일 comment-edit decision에 approximate randomization을 추가. 학습 baseline과 stochastic decomposition은 seed 3개, seed 평균이 아니라 각 seed와 분산을 모두 보고. 여러 baseline 비교는 Holm 보정. |
| 예상 자원 | 데이터 <0.4 GB. CPU 전처리 1-3시간. reranker 재현·추론 2-6 GPU시간, 7B/14B local obligation extraction과 3-seed 비교 12-30 GPU시간. 2 x RTX 4090에서 wall time 약 12-30시간, 분석 포함 1-2일. |
| Falsifier | 효과가 paraphrase expansion control에서 사라지거나 direct comments에만 나타나고 indirect subset에는 개선이 없음 |
| Early kill signal | dev에서 strongest baseline 대비 +3%p 미만이면서 indirect subset 개선이 없거나, obligation tuple의 두 실행 간 exact/semantic agreement가 0.8 미만 |
| 실패 시 정보가치 | 간접 정렬 실패가 lexical mismatch인지, 요구 분해 실패인지, 여러 edit를 묶지 못하는 set prediction 문제인지 분리 가능. negative result도 ARIES의 70.7 human gap을 설명하는 오류 taxonomy가 됨 |
| 워크숍 적합성 | [REALM 2026](https://realm-workshop.github.io/)의 agent quality evaluation, planning, reliable long-horizon action selection과 직접 연결. direct deadline은 2026-08-05. [DocInsights 2026](https://docinsights-workshop.github.io/docinsights-2026/)에도 document intelligence로 적합하지만 2026-08-02 deadline은 더 촉박함 |
| 최종 판정 | **VIABLE RESERVE**. premise·paraphrase controls 대비 1차·precision gate를 통과할 때만 독립 pilot 허용 |

## 후보 C. False-Accusation-Constrained Exact Flaw Localization

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 독립 critic, 반론 defender, abstaining adjudicator가 동일 token budget의 single critic보다 최초 오류 step을 더 정확히 찾으면서 정상 해답에 대한 허위 지적을 늘리지 않는가 |
| Closest priors | [FindTheFlaws](https://ojs.aaai.org/index.php/AAAI/article/view/41123)는 `CORRECT`/`FLAWED` 판정과 첫 오류 explanation grading을 이미 수행하고 critique·debate·prover-verifier를 명시적 사용례로 둔다. [BIG-Bench Mistake](https://arxiv.org/abs/2310.04449)는 reasoning trace의 first error 또는 no-error 식별을 평가한다. [MR-Ben](https://arxiv.org/abs/2406.13975)은 first-error localization과 정상 reasoning에 대한 false-positive bias를 직접 다룬다. [equal-token single vs multi-agent study](https://arxiv.org/abs/2604.02460)는 같은 reasoning-token budget에서 single agent가 multi-agent와 같거나 더 낫다고 보고한다. |
| 명시적 비중복 기여 | deterministic injected-step label은 평가 편의를 주지만, first-error localization, no-error false accusation, equal-token protocol 비교라는 입력·출력·가설은 결합을 제외하면 모두 직접 prior에 존재한다. "세 요소를 한 benchmark에 합쳤다"는 흡수 반론을 이길 독립 방법론 기여가 없다. |
| 공개 데이터 | 암호가 공개된 1.89 MB ZIP, 해제 후 8.96 MB. 전체 1,712행, reliable 1,513행. 공통 exact-step 실험에는 reliable modified GPQA 191행과 TheoremQA 95행, 총 286개 paired correct/flawed solution을 사용 가능. 저장소 CC0와 원천별 MIT/Apache-2.0 확인. |
| 가장 강한 현실적 baseline | 같은 local model과 총 reasoning-token budget을 사용하는 single critic full-budget, self-refine, N-sample majority, free-form debate. 2026 equal-token 결과 때문에 **single critic full-budget**을 약한 baseline이 아니라 우선 baseline으로 취급한다. |
| Candidate-owned primary metric | reliable 286개 flawed solution의 **exact injected-first-step accuracy 최대화**. 최소 의미 효과 +5%p. paired correct solution의 false-accusation rate는 baseline 대비 +2%p 이내라는 hard gate를 둔다. 자유문장 explanation score는 1차 지표에서 제외. |
| 통계 설계 | item-paired McNemar exact test, dataset-stratified paired bootstrap 10,000회, protocol 비교 Holm 보정. 각 protocol은 동일 최대 input/output token과 모델 호출 총량 사용. decoding seed 3개를 모두 공개하고 correct/flawed pair를 같은 split에 유지. |
| 예상 자원 | CPU <1시간. 286 pair x 4-5 protocol x 3 seed 기준 7B는 12-24 GPU시간, 14B는 20-40 GPU시간. 2 x RTX 4090에서 wall time 1-2일. |
| Falsifier | 동일 token budget의 single critic 또는 self-refine이 제안법 이상이며, multi-agent 개선이 더 긴 답변이나 추가 호출에서만 생김 |
| Early kill signal | dev subset에서 +3%p 미만이거나 false-accusation rate가 +2%p 초과, step parser ambiguity가 5% 초과, local model exact-step accuracy가 10% 미만 |
| 실패 시 정보가치 | coordination이 genuine localization을 개선하는지, 아니면 공격적인 오류 지적만 늘리는지 분리. scalable oversight에서 false accusation을 함께 보고해야 한다는 재현 가능한 negative result가 됨 |
| 워크숍 적합성 | REALM의 multi-agent reliability·evaluation과 높게 일치. 다만 최신 직접 prior가 많아 novelty risk가 ARIES 후보보다 큼 |
| 최종 판정 | **KILL: PRIOR ABSORPTION**. 공개 label은 좋지만 fresh workshop claim으로는 부족 |

## 후보 D. Dual-Evidence Routing for PRISMM

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | reviewer가 지적한 과학 논문의 cross-modal inconsistency에서 질문·선택지에 조건화해 충돌하는 두 evidence element를 찾으면, 고정 page budget에서 structured identification accuracy가 개선되는가 |
| Closest priors | [PRISMM-Bench](https://arxiv.org/abs/2510.16505)는 focused/page/document context를 비교하고 21개 LMM을 평가한다. [ColPali](https://arxiv.org/abs/2407.01449)는 page image late-interaction retrieval을 제안한다. [M3DocRAG](https://arxiv.org/abs/2411.04952)는 multi-page·multi-document multimodal RAG를 다룬다. [SimpleDoc](https://aclanthology.org/2025.emnlp-main.1443/)는 dual-cue page retrieval과 iterative refinement로 4개 DocVQA benchmark에서 평균 3.2% 개선을 보고한다. |
| 명시적 비중복 기여 | generic multimodal RAG가 아니라 **실제 reviewer-flagged contradiction을 구성하는 두 요소의 동시 회수**와 그 회수가 downstream structured inconsistency identification에 미치는 효과를 평가한다. 질문만 쓰는 retrieval과 choice-conditioned retrieval을 분리해야 한다. |
| 공개 데이터 | Apache-2.0, ungated, 1.182 GB parquet, 384 test rows, full PDF와 page/bbox/image/text 및 정답 포함. 공식 train/dev가 없고 버전별 행 수가 달라 snapshot 고정과 새 paper-group split이 필수. |
| 가장 강한 현실적 baseline | full-document Qwen2.5-VL-7B, paper의 page context와 oracle focused context, BM25 OCR, ColPali, SimpleDoc식 dual-cue reranking. oracle focused context는 ceiling이며 일반 baseline과 구분. |
| Candidate-owned primary metric | 최대 4개 retrieved page에서 **structured identification exact accuracy 최대화**, strongest non-oracle baseline 대비 +5%p. gold two-element page recall은 mechanism endpoint이며 baseline 대비 2%p 이상 저하하면 실패. |
| 통계 설계 | paper ID로 묶은 stratified development/held-out split을 먼저 공개하고 held-out를 한 번만 평가. paper-cluster paired bootstrap과 paired McNemar 사용. 384 task row를 독립 표본으로 간주하지 않음. category별 결과는 다중 비교 보정 후 secondary로만 보고. |
| 예상 자원 | 다운로드 1.18 GB. PDF/page indexing CPU 3-8시간, visual index 2-6 GPU시간, 7B VLM baseline·ablation 18-45 GPU시간. wall time 2-4일. |
| Falsifier | ColPali 또는 SimpleDoc이 같은 page budget에서 이미 같거나 우수하고, choice conditioning이 shortcut만 강화하거나 downstream accuracy를 높이지 못함 |
| Early kill signal | untouched paper-level holdout을 확보하지 못함, dev에서 두-page recall이 strongest baseline보다 낮음, 24 GB VRAM에서 선택한 VLM의 재현 가능한 batch가 성립하지 않음 |
| 실패 시 정보가치 | 병목이 retrieval인지 retrieved evidence를 비교하는 reasoning인지 분리. 실제 reviewer-flagged multimodal 오류에서 visual retrieval의 한계를 보고할 수 있음 |
| 워크숍 적합성 | [DocInsights 2026](https://docinsights-workshop.github.io/docinsights-2026/)에 가장 잘 맞지만 direct deadline 2026-08-02까지 통계적으로 완결된 실험을 만들기에는 위험. REALM에는 agentic routing으로만 중간 정도 적합 |
| 최종 판정 | **RESERVE / DO NOT START BEFORE SPLIT FREEZE** |

## 후보 E. Construction-Aware Scientific Abstention

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 과학 claim의 필수 조건을 분해하고 evidence 일부가 빠졌을 때 support/refute 대신 abstain하도록 하면 selective risk가 감소하는가 |
| Closest priors | [SciFact](https://aclanthology.org/2020.emnlp-main.609/)와 [MultiVerS](https://aclanthology.org/2022.findings-naacl.6/)가 scientific claim verification과 rationale selection을 제공한다. [Fact Checking with Insufficient Evidence](https://aclanthology.org/2022.tacl-1.43/)는 evidence omission, sufficiency label, contrastive self-learning을 이미 제안한다. [Knowing When Not to Answer](https://arxiv.org/abs/2602.14189)는 claim condition decomposition, NLI audit, selective abstention을 SciFact와 PubMedQA에서 평가한다. [NEI-CAP](https://arxiv.org/abs/2605.26663)은 SciFact-style construction-aware insufficient-evidence 진단을 직접 제안한다. |
| 명시적 비중복 기여 | 확인된 범위에서 방어 가능한 비중복 기여 없음. condition decomposition, missing-evidence construction, abstention, risk-coverage가 모두 직접 prior에 포함됨 |
| 공개 데이터 | SciFact 3.12 MB, train 809, dev 300, unlabeled test 300, corpus 5,183. 라이선스 명확하고 5-fold split 제공. 데이터 문제는 없음 |
| 가장 강한 현실적 baseline | MultiVerS와 2026 abstention-aware framework, NEI-CAP construction controls. 이를 제외하면 의도적으로 약한 baseline이 됨 |
| Candidate-owned primary metric | risk-coverage curve의 AURC 최소화, strongest baseline 대비 상대 10% 감소를 가정할 수 있으나 새 가설이 아님 |
| 통계 설계 | 5-fold CV, claim-level paired bootstrap, coverage grid 사전 고정, construction family별 generalization. 설계 가능하지만 novelty를 회복하지 못함 |
| 예상 자원 | CPU 1-3시간, GPU 6-18시간, wall time 1일 내외 |
| Falsifier | 최신 condition-decomposition/NEI-CAP baseline이 동일하거나 우수함 |
| Early kill signal | 이미 발생: 2026 두 직접 prior가 핵심 방법과 평가축을 흡수 |
| 실패 시 정보가치 | 재현 연구로서 제한적 가치는 있으나 현재 촉박한 워크숍 주제 선택의 opportunity cost를 정당화하지 못함 |
| 워크숍 적합성 | GroundLM의 grounding·abstention 범위에는 맞지만 direct submission은 2026-07-07 종료. 새 direct paper 경로도 없음 |
| 최종 판정 | **KILL: PRIOR ABSORPTION** |

## 후보 F. Localization-to-Minimal-Source-Repair on FLAWS

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 오류 위치와 설명이 주어졌을 때, scientific LaTeX source를 직접 재생성하는 대신 anchored minimal patch를 생성하면 원래 의미를 복구하면서 collateral change와 compile failure를 줄이는가 |
| Closest priors | [FLAWS](https://arxiv.org/abs/2511.21843)는 713개 compiled paper-error pair에서 scientific error detection과 localization을 평가하지만 repair를 평가하지 않는다. [Precise Debugging Benchmark](https://www.microsoft.com/en-us/research/publication/precise-debugging-benchmark-is-your-model-debugging-or-regenerating/?lang=en-us)는 code debugging에서 regeneration과 precise repair를 구별한다. [ReviseBench](https://aclanthology.org/2026.findings-acl.887/)는 full-workspace paper revision을 평가하고, [DELEGATE-52](https://arxiv.org/abs/2604.15597)는 장기 문서 편집의 preservation failure를 측정한다. |
| 흡수 반론과 명시적 비중복 기여 | 가장 강한 반론은 precise debugging을 LaTeX에 옮긴 domain transfer라는 것이다. 남는 기여는 **gold localization 이후의 claim-invalidating scientific error repair를 원본-수정 source diff로 결정론적으로 평가**하는 것이다. generic minimal-edit prompt와 localized-span regeneration을 이기지 못하면 이 차별점도 사라진다. |
| Licensed data/unit | FLAWS data CC BY 4.0, code MIT. 현재 release 기준 compile 가능한 713 paper-error pair가 핵심 단위이며 altered source, 원문·수정문, 위치·설명이 있다. 전체 30.65 GB이고 핵심 compressed archive는 약 11 GB다. 확인된 소형 archive의 48 label과 49 folder 불일치는 전수 reconciliation 전까지 제외한다. |
| 결정론적 endpoint | altered source와 original source의 normalized token/edit-operation diff. judge 없이 exact restoration, patch precision·recall, compile pass, 변경 범위를 계산한다. |
| 가장 강한 현실적 baseline | 같은 공개 local model의 whole-document rewrite, gold-localized span regeneration, direct full-file output, generic minimal-edit prompt, gold diff oracle ceiling. 입력 localization과 최대 output token을 동일하게 고정한다. |
| Candidate-owned primary metric | **patch F0.5 최대화**로 불필요한 edit를 더 강하게 벌한다. strongest non-oracle baseline 대비 +5%p가 최소 효과다. compile pass는 baseline 이상, gold 범위 밖 collateral token edit rate는 1% 이하를 hard gate로 둔다. |
| 통계 설계 | source paper를 독립 cluster로 두고 동일 paper의 여러 insertion을 split 사이에 나누지 않는다. paper-cluster paired bootstrap 10,000회, insertion generator·error category별 층화 sensitivity, 세 decoding seed를 사용한다. exact restoration은 paired McNemar secondary로 둔다. |
| 예상 자원 | 데이터 11-31 GB, local 7B/14B model 15-30 GB, CPU compilation 4-10시간, GPU 10-30시간, 2 x RTX 4090에서 wall time 1-2일. |
| Falsifier | localized span regeneration 또는 generic minimal-edit prompt가 patch F0.5와 collateral-change gate에서 같거나 더 좋음 |
| Early kill signal | label-folder reconciliation 실패가 2%를 넘거나, 50-paper dev에서 +5%p가 없거나, compile pass가 baseline보다 2%p 이상 낮음 |
| 실패 시 정보가치 | repair bottleneck이 localization 이후에도 남는지, strict patch representation이 scientific source에는 부적합한지 분리한다. 효과가 없으면 FLAWS를 repair benchmark로 확장할 근거가 약하다는 결과가 남는다. |
| 워크숍 적합성 | document reasoning과 reliable agent editing에 맞지만 FLAWS·precise debugging 사이의 domain-transfer 비판이 강하다. method novelty보다 deterministic repair benchmark 확장으로 포지셔닝해야 한다. |
| 최종 판정 | **VIABLE RESERVE**. generic minimal-edit control을 이기는 동결 pilot 전에는 주제로 확정하지 않음 |

## 후보 G. Anchored Patch Containment on DELEGATE-52

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 장기 delegated document editing에서 line/hash anchor와 deterministic admission을 갖는 patch interface가 동일 모델·token budget의 full rewrite 또는 search/replace보다 task success를 유지하면서 unrelated content corruption을 줄이는가 |
| Closest priors | [DELEGATE-52](https://arxiv.org/abs/2604.15597)는 52개 전문 문서 domain에서 edit success와 corruption을 평가하고 basic read/write/delete/run agent가 direct output보다 RS@20을 약 6% 낮출 수 있음을 보인다. [Can It Edit?](https://arxiv.org/abs/2312.12450)는 instruction-based text editing을 평가한다. [Mnemosyne](https://arxiv.org/abs/2607.00269)는 evidence-preserving transactional repair를 제안하고, [ContractSkill](https://arxiv.org/abs/2603.20340)은 contract-constrained agent execution을 다룬다. |
| 흡수 반론과 명시적 비중복 기여 | DELEGATE-52가 search-and-replace를 후속 방향으로 언급하고 Mnemosyne이 transactional admission을 이미 제안하므로 개념 자체는 새롭지 않다. 남는 기여는 **같은 local model·input·output token 아래 full-file, generic search/replace, anchored patch를 여러 professional format에서 격리 비교하는 empirical interface study**다. generic search/replace에서 효과가 사라지면 흡수된 것으로 판정한다. |
| Licensed data/unit | 공식 data는 CDLA-Permissive-2.0, code MIT, 다운로드 19.14 MB. release의 234 rows 중 포함 원문 라이선스까지 MIT·Apache·BSD·CC0·Public Domain·ODC-BY·PSF 등 permissive로 확인되는 20 domains, 98 rows만 사용한다. snapshot과 whitelist를 공개한다. |
| 결정론적 endpoint | DELEGATE-52의 domain-specific RS@20과 task checker, instruction success/no-op, gold change region 밖 collateral-change ratio. LLM judge를 사용하지 않는다. |
| 가장 강한 현실적 baseline | 동일 local model의 direct full-file output, 공식 basic agent harness, generic search/replace, unanchored unified diff. 각 조건의 context, maximum generated tokens, retry 수를 고정한다. |
| Candidate-owned primary metric | permissive 20-domain macro **RS@20 최대화**, strongest baseline 대비 +5%p. instruction success는 비열등, collateral-change ratio는 상대 25% 이상 감소해야 한다. |
| 통계 설계 | domain을 독립 cluster로 둔 leave-one-domain-out sensitivity와 domain-cluster paired bootstrap. 동일 environment의 state·prompt를 split 사이에 분리하지 않는다. 20-domain macro를 1차로 하고 98 rows를 독립 n으로 과대계상하지 않는다. seed 3개와 format별 이질성을 모두 공개한다. |
| 예상 자원 | dataset 29.5 MB reported storage, weights 15-25 GB, CPU checker 2-6시간, 7B/24B inference 25-60 GPU시간, wall time 2-3일. |
| Falsifier | generic search/replace가 anchored patch와 같거나 더 좋거나, preservation 개선이 instruction success 저하로만 얻어짐 |
| Early kill signal | permissive subset이 재검사 후 15 domains 미만, 5-domain dev에서 RS@20 +3%p 미만, checker nondeterminism 1% 초과 |
| 실패 시 정보가치 | DELEGATE-52의 corruption이 interface representation이 아니라 planning·state tracking에서 비롯되는지 판별한다. negative result는 patch-only 방어가 장기 문서 작업에 충분하지 않음을 보여준다. |
| 워크숍 적합성 | REALM의 long-horizon reliability와 직접 맞지만, interface ablation으로 보일 위험이 있다. cross-format effect와 corruption mechanism을 함께 제시해야 4-page empirical paper가 된다. |
| 최종 판정 | **VIABLE RESERVE**. permissive whitelist와 same-budget protocol 동결이 선행 조건 |

## 후보 H. Context-Budgeted Failure-Evidence Retrieval on CodeTraceBench

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | agent trajectory의 5% context budget에서 실패를 설명하는 최소 step set을 회수하면 failure localization 정확도와 비용의 frontier가 개선되는가 |
| Closest priors | [CodeTracer/CodeTraceBench](https://arxiv.org/abs/2604.11641)는 stage retrieval과 within-stage evidence retrieval, step precision·recall·F1, matched-token Mini·Bare baselines를 이미 정의한다. [AgentRx](https://arxiv.org/abs/2602.02475)는 execution trace에서 agent failure 원인을 진단한다. [TELBench/DRIFT](https://arxiv.org/abs/2606.02060)는 trace evidence localization과 diagnosis를 다룬다. |
| 흡수 반론과 명시적 비중복 기여 | fixed 5% budget과 AURC를 추가해도 원 논문의 compact evidence retrieval을 다른 operating point에서 다시 그리는 ablation에 가깝다. 새로운 입력·출력·가설이 없고, budget curve만으로 direct prior를 벗어나지 못한다. |
| Licensed data/unit | 데이터·코드 MIT, 전체 약 1.09 GB, 1,000 trajectories와 step labels가 실제 공개되어 있다. 법적·기술적 결함은 없지만 novelty gate가 실패한다. |
| 결정론적 endpoint | gold incorrect/unuseful step ID 대비 retrieval precision·recall·F1과 token cost. judge-independent 계산 가능. |
| 가장 강한 현실적 baseline | 원 논문의 CodeTracer, Mini, Bare와 stage-only, within-stage retrieval. 이 baseline을 제외하면 비교가 무효다. |
| Candidate-owned primary metric | context-budget AURC 최소화를 정의할 수 있으나, 원 논문의 retrieval-cost 가설과 독립된 candidate-owned endpoint가 아니다. |
| 통계 설계 | trajectory-paired bootstrap과 repository split이 가능하지만 통계 설계로 비중복성을 복구할 수 없다. |
| 예상 자원 | storage 1.1 GB, GPU 12-30시간, wall time 1-2일. 실행 가능성은 높다. |
| Falsifier | 원 CodeTracer의 budget sweep가 같거나 우수함 |
| Early kill signal | 이미 발생: stage·within-stage evidence retrieval과 matched-token endpoint가 원 논문에 존재 |
| 실패 시 정보가치 | reproduction 또는 cost ablation으로는 가치가 있으나 fresh workshop topic의 opportunity cost를 정당화하지 못함 |
| 워크숍 적합성 | REALM 범위에는 맞지만 논문 기여가 직접 prior의 추가 curve에 그침 |
| 최종 판정 | **KILL: PRIOR ABSORPTION** |

## 후보 I. Evidence-Sufficiency Gates for Budgeted LLM Evaluation

| 항목 | 적대적 판정 |
|---|---|
| 연구 질문 | 실제 local-model item prediction log에서 평가 subset을 순차적으로 늘릴 때, paired sufficiency gate가 fixed-count, point-estimate, one-item heuristic보다 false promotion과 평가 비용을 낮추면서 false block과 undecided rate를 허용 범위 안에 유지하는가 |
| Closest priors | [Card et al. 2020](https://aclanthology.org/2020.emnlp-main.745/)은 NLP 실험의 power analysis를 체계화한다. [Sample Complexity of LLM Evaluation](https://www.tmls.nyc/research/eval-sample-complexity)은 finite evaluation의 sample bound를 유도하지만 “We run no experiments”라고 명시하고 software·real eval log·decision improvement를 검증하지 않는다. [PAC-Bayes Eval-Set Sufficiency](https://www.tmls.nyc/research/pac-bayes-eval-sufficiency)는 paired slice와 anytime-valid gate를 제안하지만 역시 실험을 수행하지 않는다. [Dycke & Gurevych 2026](https://aclanthology.org/2026.tacl-1.22/)은 133편·931개 reviewer counterfactual로 paired evaluation sensitivity를 보이지만 budget sufficiency gate를 다루지 않는다. |
| 가장 강한 흡수 선행연구 | [How Reliable is Language Model Micro-Benchmarking?](https://arxiv.org/abs/2510.08730)는 full benchmark와 random subset의 pairwise ranking agreement를 반복 측정하고 MDAD를 제안한다. [Cer-Eval](https://arxiv.org/abs/2505.03814)은 single-model score·CI를 adaptive sampling하며 실제 MMLU·AlpacaEval·MATH에서 20-40% 비용 절감을 보고하되 relative model comparison을 future work로 둔다. [CELEUS](https://arxiv.org/abs/2606.20820)는 finite-pool single-model risk를 anytime CI로 추정하고 50-seed 실험에서 54-62% sample 절감을 보고한다. CELEUS 저장소는 현재 LICENSE와 logs가 없어 코드·데이터 재사용은 fail closed하고 논문 식만 clean-room 구현한다. |
| 흡수 반론과 명시적 비중복 기여 | 가장 강한 반론은 “micro-benchmark ranking replay에 TMLS/CELEUS bound를 씌운 simulation wrapper”라는 것이다. 방어 가능한 기여는 수식이 아니라 **실제 paired candidate-incumbent log에서 PROMOTE/BLOCK/UNDECIDED 정책의 false promotion, false block, undecided, cost를 held-out scenario로 검증하는 empirical operating-characteristic audit**다. ranking agreement나 single-model score estimation으로 축소되거나 clean-room CELEUS paired adaptation이 전부 설명하면 신규성은 소멸한다. |
| Licensed data/unit | ARC-Challenge 1,172, TruthfulQA MC 817, MMLU-Pro 12,032, BBH 6,511, GSM8K 1,319로 총 21,851 judge-independent item. 라이선스는 각각 CC BY-SA 4.0, Apache-2.0, MIT/Apache-2.0, MIT, MIT이며 모두 ungated다. 핵심 parquet 표본은 실제 다운로드·해시 검증했다. scientific unit은 resampled prefix가 아니라 `task x model family x system change` scenario다. |
| 자체 real prediction log | Apache-2.0 공개 weights인 [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507), [Mistral-7B-Instruct-v0.3](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3), [OLMo-2-1124-7B-Instruct](https://huggingface.co/allenai/OLMo-2-1124-7B-Instruct)를 사용한다. 모델별 direct baseline, task scaffold, quantized deployment의 세 deterministic configuration을 만들고 baseline 대비 두 paired change를 비교한다. 5 tasks x 3 model families x 2 changes = 30 scenarios, 전체 196,659 item predictions다. 유료 API와 LLM judge를 사용하지 않는다. |
| 결정론적 endpoint | item별 exact correct/incorrect와 candidate-incumbent paired difference `d_i in {-1,0,1}`. full finite benchmark log에서 계산한 delta와 사전 고정 margin으로 reference action을 정하고 subset gate action과 직접 비교한다. |
| 비교 정책 | (1) fixed-N paired exact interval, (2) fixed-N point estimate, (3) 최초 discordant item으로 결정하는 one-item heuristic, (4) TMLS식 discordance-aware paired 3-way sufficiency gate, (5) 논문 식을 clean-room으로 구현한 CELEUS/e-process paired adaptation. 정책별 threshold와 최대 N은 calibration scenarios에서만 동결한다. |
| Candidate-owned primary metric | held-out non-gray scenarios의 **false-promotion rate 최소화**, false-block <=10%와 undecided <=20% 제약. 최소 의미 효과는 strongest valid heuristic 대비 false promotion 절대 5%p 및 상대 30% 이상 감소, 동시에 fixed-N exact보다 평균 평가 item 25% 이상 감소하고 false block은 악화되지 않는 것이다. 어떤 정책도 제약을 만족하지 못하면 route 전체를 실패로 판정한다. |
| Full-log reference의 의미 | full benchmark delta는 해당 고정 benchmark·model pair의 census reference일 뿐 배포 환경이나 무한 item population의 진실이 아니다. noninferiority margin `delta0`와 buffer `epsilon`을 사전 고정해 full delta >= `-delta0 + epsilon`이면 PROMOTE, <= `-delta0 - epsilon`이면 BLOCK, 사이는 gray로 둔다. gray scenario를 삭제해 성능을 부풀리지 않고 별도 공개한다. |
| Finite-population validity | subset은 각 고정 item pool에서 **비복원 추출**한다. binary paired wins/losses에는 exact hypergeometric 또는 finite-population correction을 사용하고, bounded paired mean에는 Serfling형 또는 anytime e-process를 사용한다. iid superpopulation CI를 finite benchmark 보증으로 오인하지 않으며, cross-task 일반화는 scenario-level 결과로만 말한다. |
| Resampling dependence | scenario마다 1,000개 random permutation을 만들고 각 permutation의 prefix가 한 sequential trajectory가 된다. 한 trajectory 안의 prefix decision은 강하게 상관되며 별도 표본이 아니다. 서로 독립적으로 뽑은 permutation은 조건부 Monte Carlo replicate지만 item overlap 때문에 scientific generalization unit도 아니다. trajectory는 within-scenario operating characteristic 추정에만 쓰고 유의확률의 n으로 세지 않는다. |
| 통계 설계 | 전체 scenario를 task·model family·change type 단위로 calibration/held-out에 분리하고 held-out threshold tuning을 금지한다. scenario별 false-promotion·false-block·undecided·expected N을 계산한 뒤 held-out scenario macro 평균과 cluster bootstrap CI를 보고한다. leave-one-task-out와 leave-one-model-family-out sensitivity를 필수로 두며, synthetic known-null coverage test를 구현 검증에만 사용한다. |
| 가장 강한 현실적 baseline | finite-population paired exact fixed-N gate와 clean-room CELEUS/e-process paired adaptation이다. one-item와 point-estimate는 현재 소규모 평가 관행의 취약성을 계량하는 약한 control일 뿐, 주 baseline으로 내세우지 않는다. micro-benchmark MDAD도 동일 prediction logs에서 ranking-reliability comparator로 재현한다. |
| 예상 자원 | 평가 data reported storage 약 0.42 GB, parquet 약 5.71 MB, 세 모델 weights 합계 약 37.14 GB, prediction log와 cache 포함 peak <50 GB. 196,659 deterministic predictions에 25-60 aggregate GPU-hours, replay·통계 CPU 2-6시간. 2 x RTX 4090에서 wall time 1.5-3일. |
| Falsifier | valid paired gate가 matched coverage·cost에서 fixed-N exact를 이기지 못함, CELEUS paired adaptation이 전부 지배함, 효과가 한 task 또는 한 model family에만 존재함, full-reference action이 prompt parser artifact에 따라 뒤집힘 |
| Early kill signal | 12개 미만의 독립 non-gray held-out scenarios, 또는 held-out에 reference PROMOTE와 BLOCK이 각각 4개 미만, full deltas가 margin boundary에 몰림, synthetic null에서 nominal coverage 실패, item parsing failure 1% 초과, 6시간 pilot에서 정책 간 cost 또는 false-promotion 차이가 사실상 없음 |
| 실패 시 정보가치 | one-item·point-estimate gate의 실제 오판 비용을 수치화하거나, 반대로 paired bound가 fixed-N exact보다 실용적 이득이 없음을 보여준다. 후자는 내부 evaluator 설계에는 유용하지만 task·family 전반의 강한 negative result가 없으면 논문으로 승격하지 않는다. |
| 워크숍 적합성 | [UncertaiNLP 2026](https://uncertainlp.github.io/)은 statistical evaluation of language models, calibration, uncertainty, selective decision making을 명시적으로 받으며 direct deadline 2026-08-07, short paper 최대 4쪽이다. 문제·지표·일정이 가장 직접적으로 맞는다. |
| 최종 판정 | **PROMOTE TO FROZEN PILOT, CONDITIONAL**. 새 bound가 아닌 empirical promotion-policy validation으로만 생존. 정량 gate를 못 넘으면 **REJECT** |

## 독립 적대적 리뷰 패널

| 생존 후보 | Novelty critic | Data·statistics critic | Systems·venue critic | 잔존 판정 |
|---|---|---|---|---|
| B. ARIES alignment | ReviewScore식 premise query와 구별이 약함. atomic tuple 자체가 기여가 아님 | 196 expert comments뿐이므로 paper-cluster inference와 test 1회 원칙 필수 | 1-2일 실행 가능, REALM fit 높음 | premise·paraphrase controls 대비 +5%p일 때만 생존 |
| D. PRISMM routing | 기존 visual RAG의 dataset transfer라는 반론이 강함 | 384 rows가 모두 test이고 353 paper가 섞여 있어 split 동결 전 결과 무효 | VLM indexing이 가장 무겁고 DocInsights deadline이 촉박 | untouched paper holdout이 확보될 때만 생존 |
| F. FLAWS repair | precise debugging의 LaTeX transfer일 수 있음 | 713 pair와 gold diff는 좋지만 archive reconciliation 필요 | compile loop는 로컬 가능, document-repair venue story는 보통 | generic minimal-edit보다 patch F0.5 +5%p일 때만 생존 |
| G. DELEGATE patch | DELEGATE 후속 제안과 Mnemosyne의 interface ablation일 수 있음 | heterogeneous source licenses 때문에 20-domain whitelist 밖 사용 금지 | 2-3일, REALM fit 높으나 cross-format checker 관리 필요 | search/replace 대비 RS@20 +5%p와 collateral -25%일 때만 생존 |
| I. Sufficiency gate | micro-benchmarking·CELEUS 결과를 policy table로 재포장할 위험이 가장 큼 | resample은 독립 연구 단위가 아니며 full log는 benchmark census일 뿐 | 자체 logs 3일 이내 가능, UncertaiNLP fit이 가장 직접적 | held-out scenario에서 false promotion -5%p와 item -25%일 때만 생존 |

패널의 공통 결론은 **후보 I가 가장 낫지만 신규성 여유가 크지는 않다**는 것이다. 이론식의 재제안, random-subset rank agreement 재측정, single-model CI 절감으로 서술하면 각각 TMLS, micro-benchmarking, Cer-Eval·CELEUS에 흡수된다. 반대로 실제 paired promotion decision의 3-way operating characteristics, finite-population 보증, held-out scenario generalization을 모두 지키면 좁지만 검증 가능한 공백이 남는다.

## 추천 후보의 동결 Promotion Probe

| 항목 | 사전 고정값 |
|---|---|
| 후보 | Evidence-Sufficiency Gates for Budgeted LLM Evaluation |
| 데이터 snapshots | ARC `210d026faf9955653af8916fad021475a3f00453`, TruthfulQA `741b8276f2d1982aa3d5b832d3ee81ed3b896490`, MMLU-Pro `b189ec765aa7ed75c8acfea42df31fdae71f97be`, BBH `d53c5b10a77edeb29da195f47e6086b29f2f7f74`, GSM8K `740312add88f781978c0658806c59bc2815b9866` |
| 모델·configuration | Qwen3-4B, Mistral-7B, OLMo-2-7B 각각 direct incumbent, task-scaffold candidate, 4-bit deployment candidate. temperature 0, 고정 prompt·parser·maximum tokens |
| scenario split | ARC·TruthfulQA·GSM8K의 18 scenarios에서 policy calibration. MMLU-Pro·BBH의 12 scenarios는 최종 held-out. split은 full delta를 보기 전에 고정 |
| reference action | noninferiority margin `delta0=1.0%p`, gray buffer `epsilon=0.25%p`. full finite log에서 PROMOTE/BLOCK/GRAY 결정. margin sensitivity 0.5·2.0%p는 secondary |
| 필수 정책 | paired exact fixed-N, point estimate, one-item, TMLS paired sufficiency, clean-room CELEUS/e-process paired adaptation, MDAD ranking comparator |
| replay | scenario별 random permutation 1,000개, 비복원 prefix. trajectory 내부 prefix를 독립 표본으로 세지 않음 |
| 1차 endpoint | held-out non-gray scenario macro false-promotion rate, minimize |
| hard constraints | false-block <=10%, undecided <=20%, parsing failure <=1%, nominal synthetic-null coverage 통과 |
| 승격 최소 효과 | strongest valid heuristic 대비 false promotion 절대 -5%p·상대 -30%, paired exact fixed-N 대비 expected evaluated items -25%, false block 비악화 |
| 6시간 조기 probe | 한 calibration task·두 model family의 full log와 replay를 끝내 parser, coverage, discordant-item 수, cost 차이 확인. 이 결과로 threshold를 사후 변경하지 않음 |
| 전체 예산 | 최대 60 aggregate GPU-hours, CPU replay 6시간, peak storage 50 GB, 유료 API 0회 |
| 조기 종료 | held-out non-gray scenarios <12, reference PROMOTE·BLOCK 중 한 class가 4 scenarios 미만, parser failure >1%, coverage failure, 정책 간 false-promotion 또는 cost 차이 없음, 한 task·family 제거 시 효과 소멸 |
| 논문 ceiling | 모든 gate 통과: 4-page empirical workshop paper. robust negative effect: 명시적 negative result. 그 외: research memo로 강등하고 topic kill |

## 워크숍 경로

2026-07-26 기준 [UncertaiNLP 2026](https://uncertainlp.github.io/) direct deadline은 2026-08-07이다. short paper는 최대 4쪽이며 statistical evaluation of language models, calibration, uncertainty estimation, selective decision making을 명시적으로 포함한다. 후보 I의 endpoint와 제출 일정이 가장 직접적으로 맞으며 direct archival 또는 non-archival 경로가 있다.

[REALM @ EMNLP 2026](https://realm-workshop.github.io/) direct deadline은 2026-08-05이고 4-page·8-page paper를 받는다. 후보 B와 G가 reliability, long-horizon agent evaluation 범위에 맞는다. 후보 F는 agent editing으로 포지셔닝할 수 있지만 venue fit이 더 약하다.

[DocInsights @ EMNLP 2026](https://docinsights-workshop.github.io/docinsights-2026/) direct deadline은 2026-08-02다. 후보 D의 주제 적합성은 높지만 test-only split과 VLM 실험을 남은 기간에 완결할 위험이 크다. EMNLP의 [공식 workshop 목록](https://2026.emnlp.org/calls/workshops/)에서 REALM과 DocInsights의 개최 승인을 교차 확인했다.

## 최종 추천과 중단 조건

1. **조건부 선택:** 후보 I, Evidence-Sufficiency Gates for Budgeted LLM Evaluation을 동결 파일럿으로 시작한다.
2. **선택 근거:** 다섯 공개 task의 21,851 judge-independent items, 세 공개 local model, 자체 생성하는 complete item log, 명확한 3-way decision endpoint, 3일 로컬 상한, UncertaiNLP 제출 경로가 동시에 성립한다.
3. **비중복 기여 상한:** 새로운 sample-complexity 수식이 아니라, 실제 paired model-change scenarios에서 promotion gate의 false promotion·false block·undecided·cost를 held-out로 검증한 첫 운영 특성 비교다. “첫”이라는 표현은 최종 검색 갱신 후에만 사용한다.
4. **가장 강한 반박:** ICLR micro-benchmarking이 subset ranking reliability를, Cer-Eval·CELEUS가 adaptive estimation을 이미 실험했다. 따라서 fixed-N exact와 clean-room CELEUS paired adaptation을 이기지 못하면 논문 기여가 없다.
5. **중단 조건:** 최소 효과, coverage, non-gray scenario, cross-task·family robustness 중 하나라도 실패하면 **REJECT**한다. one-item heuristic이 나쁘다는 사실만으로는 승격하지 않는다.
6. **독립 reserve:** B, D, F, G는 실행 가능한 생존 route이지만 자동 전환하지 않는다. 각자의 동결 split·baseline·minimum-effect gate를 별도로 통과해야 한다.
7. **명시적 탈락:** A는 gold 부재, C·E·H는 prior absorption, Dycke counterfactual data는 restricted access로 탈락한다. 공개 데이터가 있다는 이유만으로 이 판정을 되돌리지 않는다.

## 1차 출처 목록

### Evaluation sufficiency and counterfactual evaluation

- [Card et al., With Little Power Comes Great Responsibility, EMNLP 2020](https://aclanthology.org/2020.emnlp-main.745/)
- [Sample Complexity of LLM Evaluation, TMLS 2026](https://www.tmls.nyc/research/eval-sample-complexity)
- [PAC-Bayes Eval-Set Sufficiency, TMLS 2026](https://www.tmls.nyc/research/pac-bayes-eval-sufficiency)
- [Dycke & Gurevych, TACL 2026](https://aclanthology.org/2026.tacl-1.22/)
- [Dycke & Gurevych official code](https://github.com/UKPLab/tacl2026-counter-review-logic)
- [Dycke & Gurevych restricted data record](https://tudatalib.ulb.tu-darmstadt.de/handle/tudatalib/4802)
- [How Reliable is Language Model Micro-Benchmarking?](https://arxiv.org/abs/2510.08730)
- [Micro-benchmarking official code](https://github.com/dill-lab/micro-benchmarking-reliability)
- [Cer-Eval](https://arxiv.org/abs/2505.03814)
- [CELEUS](https://arxiv.org/abs/2606.20820)
- [CELEUS official repository](https://github.com/zyecs/celeus)

### Budgeted-evaluation tasks and local models

- [AI2 ARC official dataset](https://huggingface.co/datasets/allenai/ai2_arc)
- [TruthfulQA official dataset](https://huggingface.co/datasets/truthfulqa/truthful_qa)
- [MMLU-Pro official dataset](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro)
- [BIG-Bench Hard official repository](https://github.com/suzgunmirac/BIG-Bench-Hard)
- [GSM8K official repository](https://github.com/openai/grade-school-math)
- [Qwen3-4B-Instruct-2507](https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507)
- [Mistral-7B-Instruct-v0.3](https://huggingface.co/mistralai/Mistral-7B-Instruct-v0.3)
- [OLMo-2-1124-7B-Instruct](https://huggingface.co/allenai/OLMo-2-1124-7B-Instruct)

### Scientific revision and constrained document repair

- [ARIES, ACL 2024](https://aclanthology.org/2024.acl-long.377/)
- [ARIES official repository](https://github.com/allenai/aries)
- [Modeling the Relationship between User Comments and Edits, ACL 2019](https://aclanthology.org/D19-1505/)
- [ReviewScore](https://arxiv.org/abs/2509.21679)
- [XtraGPT, ACL 2026](https://aclanthology.org/2026.acl-long.47/)
- [ReviseBench, Findings ACL 2026](https://aclanthology.org/2026.findings-acl.887/)
- [ReviseBench official repository](https://github.com/CGCL-codes/ReviseBench)
- [FLAWS paper](https://arxiv.org/abs/2511.21843)
- [FLAWS official data](https://huggingface.co/datasets/xasayi/FLAWS)
- [FLAWS official code](https://github.com/xasayi/FLAWS)
- [Precise Debugging Benchmark](https://www.microsoft.com/en-us/research/publication/precise-debugging-benchmark-is-your-model-debugging-or-regenerating/?lang=en-us)
- [DELEGATE-52 paper](https://arxiv.org/abs/2604.15597)
- [DELEGATE-52 official repository](https://github.com/microsoft/DELEGATE52)
- [DELEGATE-52 official dataset](https://huggingface.co/datasets/microsoft/delegate52)
- [Can It Edit?](https://arxiv.org/abs/2312.12450)
- [Mnemosyne](https://arxiv.org/abs/2607.00269)
- [ContractSkill](https://arxiv.org/abs/2603.20340)

### Scalable oversight and trace evidence

- [FindTheFlaws, AAAI 2026](https://ojs.aaai.org/index.php/AAAI/article/view/41123)
- [FindTheFlaws official repository](https://github.com/modulo-research/findtheflaws)
- [BIG-Bench Mistake](https://arxiv.org/abs/2310.04449)
- [MR-Ben](https://arxiv.org/abs/2406.13975)
- [Single-Agent LLMs Outperform Multi-Agent Systems Under Equal Thinking Token Budgets](https://arxiv.org/abs/2604.02460)
- [CodeTracer and CodeTraceBench](https://arxiv.org/abs/2604.11641)
- [CodeTracer official repository](https://github.com/NJU-LINK/CodeTracer)
- [CodeTraceBench official dataset](https://huggingface.co/datasets/NJU-LINK/CodeTraceBench)
- [AgentRx](https://arxiv.org/abs/2602.02475)
- [TELBench/DRIFT](https://arxiv.org/abs/2606.02060)

### Multimodal documents and scientific claim verification

- [PRISMM-Bench, ICLR 2026](https://openreview.net/forum?id=mjkGXdgm4T)
- [PRISMM-Bench official repository](https://github.com/da-luggas/prismm-bench)
- [PRISMM-Bench official dataset](https://huggingface.co/datasets/daluggas/PRISMM-Bench)
- [ColPali, ICLR 2025](https://arxiv.org/abs/2407.01449)
- [M3DocRAG](https://arxiv.org/abs/2411.04952)
- [SimpleDoc, EMNLP 2025](https://aclanthology.org/2025.emnlp-main.1443/)
- [SciFact, EMNLP 2020](https://aclanthology.org/2020.emnlp-main.609/)
- [Fact Checking with Insufficient Evidence, TACL 2022](https://aclanthology.org/2022.tacl-1.43/)
- [Knowing When Not to Answer](https://arxiv.org/abs/2602.14189)
- [Evidence Absence Is Not Evidence Insufficiency](https://arxiv.org/abs/2605.26663)

### Venue sources

- [UncertaiNLP 2026](https://uncertainlp.github.io/)
- [REALM 2026 call for papers](https://realm-workshop.github.io/call_for_papers/)
- [DocInsights 2026](https://docinsights-workshop.github.io/docinsights-2026/)
- [EMNLP 2026 official workshop list](https://2026.emnlp.org/calls/workshops/)
