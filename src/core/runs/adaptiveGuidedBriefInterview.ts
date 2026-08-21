import type {
  GuidedBriefInterviewCopy,
  GuidedBriefInterviewLanguage,
  GuidedBriefResearchMode
} from "./guidedBriefInterview.js";
import type { GuidedResearchBriefAnswers } from "./researchBriefFiles.js";
import { isCodexOAuthCompletionError } from "../../integrations/codex/oauthCompletionError.js";

export interface GuidedBriefInterviewTextClient {
  runForText(opts: {
    prompt: string;
    systemPrompt?: string;
    sandboxMode?: string;
    approvalPolicy?: string;
    abortSignal?: AbortSignal;
  }): Promise<string>;
}

export type GuidedBriefField = Exclude<keyof GuidedResearchBriefAnswers, "researchMode">;
export type GuidedBriefOptionalField =
  | "secondaryMetrics"
  | "manuscriptTemplate"
  | "appendixPrefer"
  | "appendixKeepMain"
  | "notes"
  | "questionsRisks";

export type AdaptiveGuidedBriefFallbackReason =
  | "empty_answer"
  | "explicit_uncertainty"
  | "model_unavailable"
  | "provider_auth_unavailable"
  | "provider_request_rejected"
  | "provider_quota_exhausted"
  | "provider_rate_limited"
  | "provider_timeout"
  | "provider_transport_error"
  | "provider_empty_response"
  | "provider_error"
  | "invalid_model_json"
  | "invalid_model_schema";

export interface AdaptiveGuidedBriefTurn {
  question: string;
  answer: string;
  field?: GuidedBriefField;
  acceptedFields: GuidedBriefField[];
  source: "labeled_input" | "model" | "guarded_fallback" | "operator_control";
  fallbackReason?: AdaptiveGuidedBriefFallbackReason;
  followupQuestion?: string;
}

export interface AdaptiveGuidedBriefState {
  language: GuidedBriefInterviewLanguage;
  researchMode: GuidedBriefResearchMode;
  answers: Partial<Record<GuidedBriefField, string>>;
  skippedOptionalFields: GuidedBriefOptionalField[];
  optionalMode: "undecided" | "collect" | "skipped";
  followupQuestion?: string;
  conversation: AdaptiveGuidedBriefTurn[];
}

export type AdaptiveGuidedBriefPrompt =
  | {
      kind: "field";
      field: GuidedBriefField;
      question: string;
      required: boolean;
      defaultValue: string;
    }
  | {
      kind: "optional_gate";
      question: string;
      required: false;
      defaultValue: string;
    }
  | {
      kind: "complete";
      question: "";
      required: false;
      defaultValue: "";
    };

export interface AdaptiveGuidedBriefResolution {
  state: AdaptiveGuidedBriefState;
  status: "advanced" | "followup_required" | "complete";
  acceptedFields: GuidedBriefField[];
  source: AdaptiveGuidedBriefTurn["source"];
  fallbackReason?: AdaptiveGuidedBriefFallbackReason;
}

interface ModelExtraction {
  field?: unknown;
  quote?: unknown;
}

interface ModelAnswerResolution {
  answer_adequate?: unknown;
  extractions?: unknown;
  followup_question?: unknown;
  rationale?: unknown;
}

const BASE_REQUIRED_FIELDS: GuidedBriefField[] = [
  "topic",
  "primaryMetric",
  "meaningfulImprovement",
  "constraints",
  "researchQuestion",
  "whySmallExperiment",
  "baselineComparator",
  "datasetTaskBench",
  "targetComparison",
  "minimumAcceptableEvidence",
  "disallowedShortcuts",
  "allowedBudgetedPasses",
  "paperCeiling",
  "minimumExperimentPlan",
  "failureConditions"
];

const DISCOVERY_SCOPE_FIELDS: GuidedBriefField[] = [
  "topic",
  "scientificObject",
  "empiricalProblems",
  "priorWorkProbes"
];

export const GUIDED_BRIEF_OPTIONAL_FIELDS: GuidedBriefOptionalField[] = [
  "secondaryMetrics",
  "manuscriptTemplate",
  "appendixPrefer",
  "appendixKeepMain",
  "notes",
  "questionsRisks"
];

const FIELD_ALIASES: Array<[GuidedBriefField, string[]]> = [
  ["topic", ["topic", "research topic", "주제", "연구 주제"]],
  ["scientificObject", ["scientific object", "과학적 대상", "문헌 검색 대상"]],
  ["empiricalProblems", ["empirical problems", "경험적 문제", "검증 문제"]],
  ["priorWorkProbes", ["prior work probes", "prior work", "선행연구 질문", "선행연구 프로브"]],
  ["primaryMetric", ["primary metric", "metric", "주요 평가 지표", "주요 지표"]],
  ["meaningfulImprovement", ["meaningful improvement", "improvement threshold", "의미 있는 개선 기준", "개선 기준"]],
  ["constraints", ["constraints", "budget", "제약 조건", "제약", "예산"]],
  ["researchQuestion", ["research question", "연구 질문"]],
  ["whySmallExperiment", ["small experiment", "why small experiment", "작은 실험", "소규모 실험"]],
  ["baselineComparator", ["baseline", "comparator", "baseline comparator", "베이스라인", "비교 대상", "비교군"]],
  ["datasetTaskBench", ["dataset", "task", "bench", "dataset task bench", "데이터셋", "벤치마크"]],
  ["targetComparison", ["target comparison", "목표 비교", "비교 구조"]],
  ["minimumAcceptableEvidence", ["minimum evidence", "minimum acceptable evidence", "최소 증거", "최소 허용 증거"]],
  ["disallowedShortcuts", ["disallowed shortcuts", "forbidden shortcuts", "금지되는 지름길", "금지 사항"]],
  ["allowedBudgetedPasses", ["allowed passes", "budgeted passes", "허용 패스", "추가 패스"]],
  ["paperCeiling", ["paper ceiling", "논문 상한"]],
  ["minimumExperimentPlan", ["minimum experiment plan", "최소 실험 계획"]],
  ["failureConditions", ["failure conditions", "실패 조건"]],
  ["secondaryMetrics", ["secondary metrics", "보조 지표"]],
  ["manuscriptTemplate", ["manuscript template", "template", "원고 템플릿"]],
  ["appendixPrefer", ["prefer appendix", "appendix prefer", "부록 선호", "부록 항목"]],
  ["appendixKeepMain", ["keep in main", "main body", "본문 유지", "본문 항목"]],
  ["notes", ["notes", "메모"]],
  ["questionsRisks", ["questions risks", "risks", "질문 리스크", "리스크"]]
];

const QUESTION_KEY_BY_FIELD: Record<GuidedBriefField, keyof GuidedBriefInterviewCopy["questions"]> = {
  topic: "topic",
  scientificObject: "scientificObject",
  empiricalProblems: "empiricalProblems",
  priorWorkProbes: "priorWorkProbes",
  primaryMetric: "primaryMetric",
  meaningfulImprovement: "meaningfulImprovement",
  constraints: "constraints",
  researchQuestion: "researchQuestion",
  whySmallExperiment: "whySmallExperiment",
  baselineComparator: "baselineComparator",
  datasetTaskBench: "datasetTaskBench",
  targetComparison: "targetComparison",
  minimumAcceptableEvidence: "minimumAcceptableEvidence",
  disallowedShortcuts: "disallowedShortcuts",
  allowedBudgetedPasses: "allowedBudgetedPasses",
  paperCeiling: "paperCeiling",
  minimumExperimentPlan: "minimumExperimentPlan",
  failureConditions: "failureConditions",
  secondaryMetrics: "secondaryMetrics",
  manuscriptTemplate: "manuscriptTemplate",
  appendixPrefer: "appendixPrefer",
  appendixKeepMain: "appendixKeepMain",
  notes: "notes",
  questionsRisks: "questionsRisks"
};

const DEFAULT_BY_FIELD: Partial<Record<GuidedBriefField, string>> = {
  allowedBudgetedPasses: "one bounded repair pass; rerun only failed conditions after a concrete fix",
  paperCeiling: "research_memo",
  appendixPrefer: "hyperparameter_grids; extended_error_analysis",
  appendixKeepMain: "main_result_tables"
};

export function createAdaptiveGuidedBriefState(input: {
  language: GuidedBriefInterviewLanguage;
  researchMode: GuidedBriefResearchMode;
}): AdaptiveGuidedBriefState {
  return {
    language: input.language,
    researchMode: input.researchMode,
    answers: {},
    skippedOptionalFields: [],
    optionalMode: "undecided",
    conversation: []
  };
}

export function getGuidedBriefRequiredFields(researchMode: GuidedBriefResearchMode): GuidedBriefField[] {
  if (researchMode === "topic_discovery") {
    return [...DISCOVERY_SCOPE_FIELDS, ...BASE_REQUIRED_FIELDS.slice(1)];
  }
  return [...BASE_REQUIRED_FIELDS];
}

export function getNextAdaptiveGuidedBriefPrompt(
  state: AdaptiveGuidedBriefState,
  copy: GuidedBriefInterviewCopy,
  templateDefault = ""
): AdaptiveGuidedBriefPrompt {
  const requiredFields = getGuidedBriefRequiredFields(state.researchMode);
  const field = requiredFields.find((candidate) => !hasSubstantiveAnswer(state.answers[candidate]));
  if (field) {
    return {
      kind: "field",
      field,
      question: state.followupQuestion || buildFieldQuestion(state, copy, field),
      required: true,
      defaultValue: DEFAULT_BY_FIELD[field] || ""
    };
  }

  if (state.optionalMode === "undecided") {
    return {
      kind: "optional_gate",
      question: state.followupQuestion || buildOptionalGateQuestion(state.language),
      required: false,
      defaultValue: state.language === "ko" ? "아니요" : "no"
    };
  }

  if (state.optionalMode === "collect") {
    const optionalField = GUIDED_BRIEF_OPTIONAL_FIELDS.find(
      (candidate) => !hasSubstantiveAnswer(state.answers[candidate]) && !state.skippedOptionalFields.includes(candidate)
    );
    if (optionalField) {
      const defaultValue = optionalField === "manuscriptTemplate"
        ? templateDefault
        : DEFAULT_BY_FIELD[optionalField] || "";
      return {
        kind: "field",
        field: optionalField,
        question: state.followupQuestion || buildFieldQuestion(state, copy, optionalField),
        required: false,
        defaultValue
      };
    }
  }

  return { kind: "complete", question: "", required: false, defaultValue: "" };
}

export async function resolveAdaptiveGuidedBriefAnswer(input: {
  state: AdaptiveGuidedBriefState;
  copy: GuidedBriefInterviewCopy;
  answer: string;
  templateDefault?: string;
  llm?: GuidedBriefInterviewTextClient;
  abortSignal?: AbortSignal;
}): Promise<AdaptiveGuidedBriefResolution> {
  const prompt = getNextAdaptiveGuidedBriefPrompt(input.state, input.copy, input.templateDefault);
  if (prompt.kind === "complete") {
    return {
      state: input.state,
      status: "complete",
      acceptedFields: [],
      source: "operator_control"
    };
  }

  const answer = input.answer.trim();
  if (prompt.kind === "optional_gate") {
    return resolveOptionalGate(input.state, prompt.question, answer);
  }

  if (!prompt.required && (answer === "" || looksLikeSkip(answer) || looksLikeDone(answer))) {
    const skipAll = looksLikeDone(answer);
    const optionalField = prompt.field as GuidedBriefOptionalField;
    const nextState: AdaptiveGuidedBriefState = {
      ...input.state,
      optionalMode: skipAll ? "skipped" : input.state.optionalMode,
      skippedOptionalFields: skipAll
        ? [...GUIDED_BRIEF_OPTIONAL_FIELDS]
        : uniqueFields([...input.state.skippedOptionalFields, optionalField]),
      followupQuestion: undefined,
      conversation: [...input.state.conversation, {
        question: prompt.question,
        answer,
        field: prompt.field,
        acceptedFields: [],
        source: "operator_control"
      }]
    };
    return advanceResult(nextState, [], "operator_control");
  }

  if (!answer) {
    const followupQuestion = buildGuardedFollowup(input.state.language, input.copy, prompt.field);
    return followupResult(
      input.state,
      prompt,
      answer,
      followupQuestion,
      "guarded_fallback",
      [],
      "empty_answer"
    );
  }

  const deterministic = extractLabeledFields(answer, input.state.researchMode);
  if (deterministic.size > 0) {
    const currentValue = deterministic.get(prompt.field);
    if (!currentValue || looksExplicitlyUncertain(currentValue)) {
      deterministic.delete(prompt.field);
      const partialState = mergeAnswerValues(input.state, deterministic);
      const acceptedFields = changedFields(input.state, partialState, deterministic.keys());
      const followupQuestion = buildGuardedFollowup(input.state.language, input.copy, prompt.field);
      return followupResult(partialState, prompt, answer, followupQuestion, "labeled_input", acceptedFields);
    }
    const values = new Map<GuidedBriefField, string>(deterministic);
    const nextState = mergeAcceptedAnswers(input.state, values, prompt, answer, "labeled_input");
    return advanceResult(nextState, changedFields(input.state, nextState, values.keys()), "labeled_input");
  }

  if (looksExplicitlyUncertain(answer)) {
    const followupQuestion = buildGuardedFollowup(input.state.language, input.copy, prompt.field);
    return followupResult(
      input.state,
      prompt,
      answer,
      followupQuestion,
      "guarded_fallback",
      [],
      "explicit_uncertainty"
    );
  }

  let fallbackReason: AdaptiveGuidedBriefFallbackReason = "model_unavailable";
  if (input.llm) {
    try {
      const raw = await input.llm.runForText({
        prompt: buildModelPrompt(input.state, input.copy, prompt.field, prompt.question, answer),
        systemPrompt:
          "Interpret one guided Research Brief answer. Fill only declared fields using exact quotes from the operator answer. "
          + "Never invent research facts, approve a run, weaken a required field, or return text outside the JSON object.",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        abortSignal: input.abortSignal
      });
      if (!raw.trim()) {
        fallbackReason = "provider_empty_response";
      } else {
        const model = parseModelResolution(raw);
        if (!model) {
          fallbackReason = "invalid_model_json";
        }
        const validated = validateModelExtractions(model, answer, input.state.researchMode);
        if (validated) {
          if (!validated.answerAdequate) {
            validated.values.delete(prompt.field);
            const partialState = mergeAnswerValues(input.state, validated.values);
            const acceptedFields = changedFields(input.state, partialState, validated.values.keys());
            const followupQuestion = validated.followupQuestion
              || buildGuardedFollowup(input.state.language, input.copy, prompt.field);
            return followupResult(partialState, prompt, answer, followupQuestion, "model", acceptedFields);
          }
          if (!validated.values.has(prompt.field)) {
            validated.values.set(prompt.field, answer);
          }
          const nextState = mergeAcceptedAnswers(input.state, validated.values, prompt, answer, "model");
          return advanceResult(nextState, changedFields(input.state, nextState, validated.values.keys()), "model");
        }
        if (model) {
          fallbackReason = "invalid_model_schema";
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      fallbackReason = classifyAdaptiveGuidedBriefProviderError(error);
    }
  }

  const values = new Map<GuidedBriefField, string>([[prompt.field, answer]]);
  const nextState = mergeAcceptedAnswers(
    input.state,
    values,
    prompt,
    answer,
    "guarded_fallback",
    fallbackReason
  );
  return advanceResult(
    nextState,
    changedFields(input.state, nextState, values.keys()),
    "guarded_fallback",
    fallbackReason
  );
}

export function buildAdaptiveGuidedBriefAnswers(state: AdaptiveGuidedBriefState): GuidedResearchBriefAnswers {
  const missing = getGuidedBriefRequiredFields(state.researchMode).filter(
    (field) => !hasSubstantiveAnswer(state.answers[field])
  );
  if (missing.length > 0) {
    throw new Error(`Adaptive guided brief is incomplete: ${missing.join(", ")}`);
  }
  return {
    researchMode: state.researchMode,
    topic: state.answers.topic!,
    scientificObject: state.answers.scientificObject,
    empiricalProblems: state.answers.empiricalProblems,
    priorWorkProbes: state.answers.priorWorkProbes,
    primaryMetric: state.answers.primaryMetric!,
    secondaryMetrics: state.answers.secondaryMetrics,
    meaningfulImprovement: state.answers.meaningfulImprovement!,
    constraints: state.answers.constraints!,
    researchQuestion: state.answers.researchQuestion!,
    whySmallExperiment: state.answers.whySmallExperiment!,
    baselineComparator: state.answers.baselineComparator!,
    datasetTaskBench: state.answers.datasetTaskBench!,
    targetComparison: state.answers.targetComparison!,
    minimumAcceptableEvidence: state.answers.minimumAcceptableEvidence!,
    disallowedShortcuts: state.answers.disallowedShortcuts!,
    allowedBudgetedPasses: state.answers.allowedBudgetedPasses!,
    paperCeiling: state.answers.paperCeiling!,
    minimumExperimentPlan: state.answers.minimumExperimentPlan!,
    failureConditions: state.answers.failureConditions!,
    manuscriptTemplate: state.answers.manuscriptTemplate,
    appendixPrefer: state.answers.appendixPrefer,
    appendixKeepMain: state.answers.appendixKeepMain,
    notes: state.answers.notes,
    questionsRisks: state.answers.questionsRisks
  };
}

export function summarizeAdaptiveGuidedBriefCoverage(state: AdaptiveGuidedBriefState): {
  answered: number;
  required: number;
  remainingFields: GuidedBriefField[];
} {
  const required = getGuidedBriefRequiredFields(state.researchMode);
  const remainingFields = required.filter((field) => !hasSubstantiveAnswer(state.answers[field]));
  return {
    answered: required.length - remainingFields.length,
    required: required.length,
    remainingFields
  };
}

function buildFieldQuestion(
  state: AdaptiveGuidedBriefState,
  copy: GuidedBriefInterviewCopy,
  field: GuidedBriefField
): string {
  const label = questionForField(copy, field);
  if (field !== "topic") {
    return label;
  }
  if (state.language === "ko") {
    return `${label} — 이미 정한 지표, 개선 기준, 비교 대상, 데이터, 제약도 함께 설명하셔도 됩니다. 답한 항목은 다시 묻지 않습니다.`;
  }
  if (state.language === "en") {
    return `${label} — You may also include any metric, improvement threshold, comparator, data, and constraints already decided. Answered fields will be skipped.`;
  }
  return label;
}

function buildOptionalGateQuestion(language: GuidedBriefInterviewLanguage): string {
  return language === "ko"
    ? "보조 지표, 원고 템플릿, 부록 선호, 메모 또는 리스크 같은 선택 항목도 추가하시겠습니까? (예/아니요)"
    : "Would you like to add optional details such as secondary metrics, a manuscript template, appendix preferences, notes, or risks? (yes/no)";
}

function buildGuardedFollowup(
  language: GuidedBriefInterviewLanguage,
  copy: GuidedBriefInterviewCopy,
  field: GuidedBriefField
): string {
  const label = questionForField(copy, field);
  return language === "ko"
    ? `아직 확정되지 않았다면 판단 기준이나 확인 방법을 포함해 '${label}'에 대한 현재 답을 구체화해 주세요.`
    : `Please clarify your current answer for '${label}', including the decision rule or verification path if it is not settled yet.`;
}

function questionForField(copy: GuidedBriefInterviewCopy, field: GuidedBriefField): string {
  const value = copy.questions[QUESTION_KEY_BY_FIELD[field]];
  return typeof value === "string" && value.trim() ? value : field;
}

function resolveOptionalGate(
  state: AdaptiveGuidedBriefState,
  question: string,
  answer: string
): AdaptiveGuidedBriefResolution {
  if (looksLikeNo(answer)) {
    const nextState: AdaptiveGuidedBriefState = {
      ...state,
      optionalMode: "skipped",
      skippedOptionalFields: [...GUIDED_BRIEF_OPTIONAL_FIELDS],
      followupQuestion: undefined,
      conversation: [...state.conversation, {
        question,
        answer,
        acceptedFields: [],
        source: "operator_control"
      }]
    };
    return { state: nextState, status: "complete", acceptedFields: [], source: "operator_control" };
  }
  if (looksLikeYes(answer)) {
    const nextState: AdaptiveGuidedBriefState = {
      ...state,
      optionalMode: "collect",
      followupQuestion: undefined,
      conversation: [...state.conversation, {
        question,
        answer,
        acceptedFields: [],
        source: "operator_control"
      }]
    };
    return { state: nextState, status: "advanced", acceptedFields: [], source: "operator_control" };
  }
  const followupQuestion = state.language === "ko"
    ? "선택 항목을 추가하려면 '예', 바로 완료하려면 '아니요'라고 답해 주세요."
    : "Answer 'yes' to add optional details or 'no' to finish the brief.";
  return followupResult(
    state,
    { kind: "optional_gate", question, required: false, defaultValue: "no" },
    answer,
    followupQuestion,
    "operator_control"
  );
}

function mergeAcceptedAnswers(
  state: AdaptiveGuidedBriefState,
  values: Map<GuidedBriefField, string>,
  prompt: Extract<AdaptiveGuidedBriefPrompt, { kind: "field" }>,
  answer: string,
  source: AdaptiveGuidedBriefTurn["source"],
  fallbackReason?: AdaptiveGuidedBriefFallbackReason
): AdaptiveGuidedBriefState {
  const merged = mergeAnswerValues(state, values);
  const acceptedFields = changedFields(state, merged, values.keys());
  return {
    ...merged,
    followupQuestion: undefined,
    conversation: [...state.conversation, {
      question: prompt.question,
      answer,
      field: prompt.field,
      acceptedFields,
      source,
      fallbackReason
    }]
  };
}

function followupResult(
  state: AdaptiveGuidedBriefState,
  prompt: Exclude<AdaptiveGuidedBriefPrompt, { kind: "complete" }>,
  answer: string,
  followupQuestion: string,
  source: AdaptiveGuidedBriefTurn["source"],
  acceptedFields: GuidedBriefField[] = [],
  fallbackReason?: AdaptiveGuidedBriefFallbackReason
): AdaptiveGuidedBriefResolution {
  const nextState: AdaptiveGuidedBriefState = {
    ...state,
    followupQuestion,
    conversation: [...state.conversation, {
      question: prompt.question,
      answer,
      field: prompt.kind === "field" ? prompt.field : undefined,
      acceptedFields,
      source,
      fallbackReason,
      followupQuestion
    }]
  };
  return {
    state: nextState,
    status: "followup_required",
    acceptedFields,
    source,
    fallbackReason
  };
}

function advanceResult(
  state: AdaptiveGuidedBriefState,
  acceptedFields: GuidedBriefField[],
  source: AdaptiveGuidedBriefTurn["source"],
  fallbackReason?: AdaptiveGuidedBriefFallbackReason
): AdaptiveGuidedBriefResolution {
  return {
    state,
    status: isAdaptiveInterviewComplete(state) ? "complete" : "advanced",
    acceptedFields,
    source,
    fallbackReason
  };
}

function mergeAnswerValues(
  state: AdaptiveGuidedBriefState,
  values: Map<GuidedBriefField, string>
): AdaptiveGuidedBriefState {
  const answers = { ...state.answers };
  const allowed = new Set(getAllowedFields(state.researchMode));
  for (const [field, value] of values) {
    const trimmed = value.trim();
    if (!allowed.has(field) || !trimmed || hasSubstantiveAnswer(answers[field])) {
      continue;
    }
    answers[field] = trimmed;
  }
  return { ...state, answers };
}

function changedFields(
  before: AdaptiveGuidedBriefState,
  after: AdaptiveGuidedBriefState,
  candidates: Iterable<GuidedBriefField>
): GuidedBriefField[] {
  return [...new Set(candidates)].filter((field) => before.answers[field] !== after.answers[field]);
}

function isAdaptiveInterviewComplete(state: AdaptiveGuidedBriefState): boolean {
  if (getGuidedBriefRequiredFields(state.researchMode).some((field) => !hasSubstantiveAnswer(state.answers[field]))) {
    return false;
  }
  if (state.optionalMode === "undecided") {
    return false;
  }
  if (state.optionalMode === "skipped") {
    return true;
  }
  return GUIDED_BRIEF_OPTIONAL_FIELDS.every(
    (field) => hasSubstantiveAnswer(state.answers[field]) || state.skippedOptionalFields.includes(field)
  );
}

function extractLabeledFields(answer: string, researchMode: GuidedBriefResearchMode): Map<GuidedBriefField, string> {
  const allowed = new Set(getAllowedFields(researchMode));
  const result = new Map<GuidedBriefField, string>();
  for (const segment of answer.split(/[;\n]+/u)) {
    const separator = segment.search(/[:=]/u);
    if (separator <= 0) {
      continue;
    }
    const rawLabel = segment.slice(0, separator).trim();
    const value = segment.slice(separator + 1).trim();
    if (!value) {
      continue;
    }
    const normalizedLabel = normalizeLabel(rawLabel);
    const matched = FIELD_ALIASES.find(([, aliases]) =>
      aliases.some((alias) => normalizeLabel(alias) === normalizedLabel)
    )?.[0];
    if (matched && allowed.has(matched) && !result.has(matched)) {
      result.set(matched, value);
    }
  }
  return result;
}

function buildModelPrompt(
  state: AdaptiveGuidedBriefState,
  copy: GuidedBriefInterviewCopy,
  currentField: GuidedBriefField,
  question: string,
  answer: string
): string {
  const allowedFields = getAllowedFields(state.researchMode);
  const unanswered = allowedFields.filter((field) => !hasSubstantiveAnswer(state.answers[field]));
  return [
    "Return STRICT JSON only.",
    "Decide whether the operator substantively answered current_field and extract any other declared brief fields already stated.",
    "Every extraction.quote must be an exact contiguous substring of operator_answer. Do not paraphrase or infer missing facts.",
    "Use answer_adequate=false only when current_field remains genuinely unknown, ambiguous, or non-substantive.",
    "Schema: {\"answer_adequate\":true|false,\"extractions\":[{\"field\":\"declared_field\",\"quote\":\"exact substring\"}],\"followup_question\":\"\",\"rationale\":\"\"}",
    `language: ${state.language}`,
    `research_mode: ${state.researchMode}`,
    `current_field: ${currentField}`,
    `current_question: ${question}`,
    `current_field_label: ${questionForField(copy, currentField)}`,
    `already_answered: ${JSON.stringify(state.answers)}`,
    `unanswered_declared_fields: ${JSON.stringify(unanswered)}`,
    `operator_answer: ${answer}`
  ].join("\n");
}

function validateModelExtractions(
  model: ModelAnswerResolution | undefined,
  answer: string,
  researchMode: GuidedBriefResearchMode
): { answerAdequate: boolean; values: Map<GuidedBriefField, string>; followupQuestion?: string } | undefined {
  if (!model || typeof model.answer_adequate !== "boolean" || !Array.isArray(model.extractions)) {
    return undefined;
  }
  const allowed = new Set(getAllowedFields(researchMode));
  const values = new Map<GuidedBriefField, string>();
  const usedQuotes = new Set<string>();
  for (const item of model.extractions as ModelExtraction[]) {
    const field = typeof item?.field === "string" ? item.field as GuidedBriefField : undefined;
    const quote = typeof item?.quote === "string" ? item.quote.trim() : "";
    if (!field || !allowed.has(field) || !quote || values.has(field)) {
      continue;
    }
    const exact = findExactQuote(answer, quote);
    const normalizedQuote = exact ? normalizeLabel(exact) : "";
    if (exact && [...exact].length >= 2 && normalizedQuote && !usedQuotes.has(normalizedQuote)) {
      values.set(field, exact);
      usedQuotes.add(normalizedQuote);
    }
  }
  const followupQuestion = sanitizeQuestion(model.followup_question);
  return { answerAdequate: model.answer_adequate, values, followupQuestion };
}

function parseModelResolution(raw: string): ModelAnswerResolution | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  if (fenced) {
    candidates.push(fenced);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ModelAnswerResolution;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next bounded JSON representation.
    }
  }
  return undefined;
}

function getAllowedFields(researchMode: GuidedBriefResearchMode): GuidedBriefField[] {
  return [...getGuidedBriefRequiredFields(researchMode), ...GUIDED_BRIEF_OPTIONAL_FIELDS];
}

function findExactQuote(answer: string, quote: string): string | undefined {
  const index = answer.toLocaleLowerCase().indexOf(quote.toLocaleLowerCase());
  return index >= 0 ? answer.slice(index, index + quote.length) : undefined;
}

function sanitizeQuestion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const question = value.replace(/\s+/gu, " ").trim().slice(0, 500);
  return question || undefined;
}

function normalizeLabel(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function hasSubstantiveAnswer(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function looksExplicitlyUncertain(answer: string): boolean {
  const normalized = normalizeLabel(answer);
  return [
    /\b(?:not sure|do not know|don t know|uncertain|cannot decide)\b/u,
    /(?:잘 모르|모르겠|확신이 없|애매|결정 못)/u
  ].some((pattern) => pattern.test(normalized));
}

function looksLikeYes(answer: string): boolean {
  return /^(?:y|yes|sure|ok|okay|예|네|응|좋아요)$/iu.test(answer.trim());
}

function looksLikeNo(answer: string): boolean {
  return answer.trim() === "" || /^(?:n|no|none|skip|아니요|아니오|없음|건너뛰기)$/iu.test(answer.trim());
}

function looksLikeSkip(answer: string): boolean {
  return /^(?:skip|none|없음|건너뛰기)$/iu.test(answer.trim());
}

function looksLikeDone(answer: string): boolean {
  return /^(?:done|finish|skip all|완료|모두 건너뛰기)$/iu.test(answer.trim());
}

function uniqueFields(fields: GuidedBriefOptionalField[]): GuidedBriefOptionalField[] {
  return [...new Set(fields)];
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort/iu.test(error.message);
}

function classifyAdaptiveGuidedBriefProviderError(error: unknown): AdaptiveGuidedBriefFallbackReason {
  if (isCodexOAuthCompletionError(error)) {
    switch (error.code) {
      case "auth_unavailable":
        return "provider_auth_unavailable";
      case "request_rejected":
        return "provider_request_rejected";
      case "quota_exhausted":
        return "provider_quota_exhausted";
      case "rate_limited":
        return "provider_rate_limited";
      case "transport_error":
        return "provider_transport_error";
      case "incomplete_response":
      case "empty_response":
        return "provider_empty_response";
      default:
        return "provider_error";
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b429\b|rate.?limit|too many requests/iu.test(message)) {
    return "provider_rate_limited";
  }
  if (/\b(?:401|403)\b/iu.test(message)) {
    return "provider_auth_unavailable";
  }
  if (/\b(?:400|404|409|422)\b|unsupported.*model|invalid.*model|request rejected/iu.test(message)) {
    return "provider_request_rejected";
  }
  if (/required.*login|oauth.*required|\bauth(?:entication|orization)?\b|access token|credentials?/iu.test(message)) {
    return "provider_auth_unavailable";
  }
  if (/time(?:d)?\s*out|timeout|progress stall/iu.test(message)) {
    return "provider_timeout";
  }
  if (/without text output|empty (?:output|response)|missing output/iu.test(message)) {
    return "provider_empty_response";
  }
  if (/before receiving an http response|network|fetch|econn|enotfound|socket|dns/iu.test(message)) {
    return "provider_transport_error";
  }
  return "provider_error";
}
