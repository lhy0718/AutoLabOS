import {
  HumanInterventionChoice,
  HumanInterventionRequest,
  ResolvedHumanInterventionAnswer,
  resolveHumanInterventionAnswer
} from "./humanIntervention.js";
import { GRAPH_NODE_ORDER } from "../types.js";

export interface HumanInterventionTextClient {
  runForText(opts: {
    prompt: string;
    systemPrompt?: string;
    sandboxMode?: string;
    approvalPolicy?: string;
    abortSignal?: AbortSignal;
  }): Promise<string>;
}

export type AdaptiveHumanInterventionResolution =
  | {
      status: "resolved";
      resolved: ResolvedHumanInterventionAnswer;
      source: "exact" | "model" | "guarded_fallback";
      rationale?: string;
    }
  | {
      status: "followup_required";
      question: string;
      source: "model" | "guarded_fallback";
      rationale?: string;
    };

interface ModelResolution {
  decision?: unknown;
  choice_id?: unknown;
  normalized_answer?: unknown;
  followup_question?: unknown;
  rationale?: unknown;
}

type MetricComparator = ">" | ">=" | "<" | "<=" | "=" | "==" | "!=";

interface VerifiedMetricCriterion {
  metric: string;
  kind: "numeric" | "objective" | "change";
  start: number;
  end: number;
  comparator?: MetricComparator;
  value?: number;
  direction?: string;
}

export async function resolveAdaptiveHumanInterventionAnswer(input: {
  request: HumanInterventionRequest;
  answer: string;
  llm?: HumanInterventionTextClient;
  abortSignal?: AbortSignal;
}): Promise<AdaptiveHumanInterventionResolution> {
  throwIfAborted(input.abortSignal);
  const answer = input.answer.trim();
  if (!answer) {
    return {
      status: "followup_required",
      question: "Please provide an answer before the run continues.",
      source: "guarded_fallback"
    };
  }

  const metricCriteria = extractVerifiedObjectiveMetricCriteria(input.request, answer);
  const hasUnboundMetricCriterion = containsUnboundObjectiveMetricCriterion(
    input.request,
    answer
  );
  const orderedCurrentRoute = resolveExplicitCurrentRouteInOrderedPlan(
    input.request,
    answer
  );
  const hasNonAffirmativeDecision = hasNonAffirmativeDecisionStructure(
    input.request,
    answer
  );
  if (
    looksInterrogative(input.request, answer)
    || hasNonAffirmativeDecision
  ) {
    return {
      status: "followup_required",
      question: buildResolutionFollowup(input.request),
      source: "guarded_fallback",
      rationale: "The answer is tentative or rejects continuation rather than stating one affirmative decision."
    };
  }

  const exactChoice = resolveExactDeclaredChoice(input.request, answer);
  if (exactChoice) {
    return resolvedFromChoice(input.request, answer, exactChoice, "exact");
  }

  if (
    looksExplicitlyUncertain(answer)
    || looksDeferred(answer, Boolean(orderedCurrentRoute))
    || looksChoiceAmbiguous(input.request, answer)
    || negatesOnlyDeclaredDecision(input.request, answer)
    || negatesVerifiedObjectiveMetricCriterion(answer, metricCriteria)
  ) {
    return {
      status: "followup_required",
      question: buildResolutionFollowup(input.request),
      source: "guarded_fallback",
      rationale: "The answer negates, defers, or otherwise leaves the operator intent unresolved."
    };
  }

  if (explicitlyAcceptsDeclaredDefault(input.request, answer)) {
    return {
      status: "resolved",
      resolved: {
        request: input.request,
        answer,
        resumeAction: input.request.resumeAction
      },
      source: "exact",
      rationale: "The operator explicitly accepted the request's declared default action."
    };
  }

  // Explicit route identifiers are already bounded by the request contract and do
  // not need a model round-trip. Natural-language aliases still go through the
  // interpreter first so negation and ambiguity can be handled contextually.
  const explicitRoutes = orderedCurrentRoute
    ? [orderedCurrentRoute]
    : resolveExplicitDeclaredRoutes(input.request, answer);
  const hasMetricCriterion = metricCriteria.length > 0;
  const verifiedMetricCriterion = hasMetricCriterion
    && isAffirmativeMetricCriterionAnswer(answer, metricCriteria);
  const hasMixedMetricAndRouteIntent = hasMetricCriterion && explicitRoutes.length > 0;
  const hasMultipleDeclaredRoutes = explicitRoutes.length > 1;
  const hasAmbiguousMetricCriterion = isAmbiguousMetricCriterion(answer, metricCriteria);
  const needsModelInterpretation = hasMixedMetricAndRouteIntent
    || hasMultipleDeclaredRoutes
    || hasAmbiguousMetricCriterion
    || hasUnboundMetricCriterion
    || (hasMetricCriterion && !verifiedMetricCriterion);
  const explicitIdentifiers = orderedCurrentRoute
    ? [orderedCurrentRoute]
    : resolveExplicitDeclaredIdentifiers(input.request, answer);
  if (
    !needsModelInterpretation
    && explicitRoutes.length === 1
    && explicitIdentifiers.length === 1
  ) {
    return resolvedFromChoice(input.request, answer, explicitIdentifiers[0]!, "guarded_fallback");
  }

  if (!needsModelInterpretation && verifiedMetricCriterion) {
    return {
      status: "resolved",
      resolved: {
        request: input.request,
        answer,
        resumeAction: input.request.resumeAction
      },
      source: "guarded_fallback",
      rationale: "The answer names an available metric and provides a bounded evaluation criterion."
    };
  }

  if (input.llm) {
    try {
      const raw = await input.llm.runForText({
        prompt: buildResolverPrompt(input.request, answer),
        systemPrompt:
          "Interpret the operator's answer inside the declared AutoLabOS intervention contract. "
          + "You may select only declared choices, accept the request's default action, or ask one follow-up question. "
          + "Never invent a graph target, waive a blocker, approve an external action, or return prose outside the JSON object.",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        abortSignal: input.abortSignal
      });
      throwIfAborted(input.abortSignal);
      const modelResolution = parseModelResolution(raw);
      const validated = validateModelResolution(input.request, answer, modelResolution);
      if (validated && (!needsModelInterpretation || validated.status === "followup_required")) {
        throwIfAborted(input.abortSignal);
        return validated;
      }
    } catch {
      throwIfAborted(input.abortSignal);
    }
  }

  if (needsModelInterpretation) {
    return {
      status: "followup_required",
      question: buildResolutionFollowup(input.request),
      source: "guarded_fallback",
      rationale: hasMixedMetricAndRouteIntent
        ? "The answer combines a metric criterion with a declared recovery route and needs one explicit decision."
        : hasMultipleDeclaredRoutes
          ? "The answer names more than one declared recovery route and needs one explicit decision."
          : hasUnboundMetricCriterion
            ? "The answer uses a metric criterion that is not bound to an available metric."
            : "The answer provides conflicting or alternative metric criteria and needs one explicit decision."
    };
  }

  if (input.request.inputMode === "free_text") {
    return {
      status: "followup_required",
      question: buildResolutionFollowup(input.request),
      source: "guarded_fallback",
      rationale: "The answer could not be safely matched to a verified criterion or one declared recovery route."
    };
  }

  return {
    status: "followup_required",
    question: buildChoiceFollowup(input.request),
    source: "guarded_fallback",
    rationale: "The answer did not identify one of the declared recovery choices."
  };
}

function buildResolverPrompt(request: HumanInterventionRequest, answer: string): string {
  const choices = (request.choices || []).map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.description || "",
    aliases: choice.answerAliases || [],
    resume_action: choice.resumeAction || request.resumeAction,
    target_node: choice.targetNode || ""
  }));
  return [
    "Return STRICT JSON only.",
    "Decide whether the operator answered the question, selected a declared route, or needs one clarification.",
    "Use decision=accept_default only when the answer directly addresses the question and does not request another declared route.",
    "Use decision=select_choice only with an exact choice_id from declared_choices.",
    "Use decision=ask_followup when the answer is ambiguous, contradictory, or does not provide enough information to continue safely.",
    "Keep normalized_answer faithful to the operator. Do not add facts.",
    "Schema: {\"decision\":\"accept_default|select_choice|ask_followup\",\"choice_id\":\"\",\"normalized_answer\":\"\",\"followup_question\":\"\",\"rationale\":\"\"}",
    `request_kind: ${request.kind}`,
    `source_node: ${request.sourceNode}`,
    `question: ${request.question}`,
    `context: ${JSON.stringify(request.context)}`,
    `input_mode: ${request.inputMode}`,
    `default_resume_action: ${request.resumeAction}`,
    `declared_choices: ${JSON.stringify(choices)}`,
    `prior_conversation: ${JSON.stringify(request.conversation || [])}`,
    `operator_answer: ${answer}`
  ].join("\n");
}

function validateModelResolution(
  request: HumanInterventionRequest,
  rawAnswer: string,
  model: ModelResolution | undefined
): AdaptiveHumanInterventionResolution | undefined {
  if (!model) {
    return undefined;
  }
  const decision = typeof model.decision === "string" ? model.decision.trim() : "";
  const rationale = sanitizeLine(model.rationale, 320);
  const hasNonAffirmativeDecision = hasNonAffirmativeDecisionStructure(request, rawAnswer);

  if (decision === "select_choice") {
    const choiceId = typeof model.choice_id === "string" ? model.choice_id.trim() : "";
    const choice = (request.choices || []).find((item) => item.id === choiceId);
    if (
      !choice
      || hasNonAffirmativeDecision
      || isDeclaredChoiceReferenceNegated(request, choice, rawAnswer)
    ) {
      return undefined;
    }
    return resolvedFromChoice(request, rawAnswer, choice, "model", rationale);
  }

  if (
    decision === "accept_default"
    && request.inputMode === "free_text"
    && !hasNonAffirmativeDecision
    && !isDeclaredDefaultNegated(request, rawAnswer)
    && !(request.choices || []).some((choice) => (
      isDeclaredChoiceReferenceNegated(request, choice, rawAnswer)
    ))
    && resolveExplicitDeclaredRoutes(request, rawAnswer).length === 0
  ) {
    return {
      status: "resolved",
      resolved: {
        request,
        answer: rawAnswer,
        resumeAction: request.resumeAction
      },
      source: "model",
      rationale
    };
  }

  if (decision === "ask_followup") {
    const question = sanitizeLine(model.followup_question, 500);
    if (!question) {
      return undefined;
    }
    return {
      status: "followup_required",
      question,
      source: "model",
      rationale
    };
  }

  return undefined;
}

function resolvedFromChoice(
  request: HumanInterventionRequest,
  answer: string,
  choice: HumanInterventionChoice,
  source: "exact" | "model" | "guarded_fallback",
  rationale?: string
): AdaptiveHumanInterventionResolution {
  return {
    status: "resolved",
    resolved: {
      request,
      answer,
      selectedChoice: choice,
      resumeAction: choice.resumeAction || request.resumeAction,
      targetNode: choice.targetNode
    },
    source,
    rationale
  };
}

function resolveExactDeclaredChoice(
  request: HumanInterventionRequest,
  answer: string
): HumanInterventionChoice | undefined {
  const choices = request.choices || [];
  if (choices.length === 0) {
    return undefined;
  }
  const choiceRequest: HumanInterventionRequest = {
    ...request,
    inputMode: "single_choice"
  };
  const resolved = resolveHumanInterventionAnswer(choiceRequest, answer);
  if ("error" in resolved) {
    return undefined;
  }
  const selectedChoice = resolved.selectedChoice;
  if (!selectedChoice || isDeclaredChoiceReferenceNegated(request, selectedChoice, answer)) {
    return undefined;
  }
  return selectedChoice;
}

function resolveExplicitDeclaredRoutes(
  request: HumanInterventionRequest,
  answer: string
): HumanInterventionChoice[] {
  const normalized = normalizeForMatch(answer);
  if (!normalized) {
    return [];
  }
  return (request.choices || []).filter((choice) => {
    const stableCandidates = [choice.id, choice.label, choice.targetNode || ""]
      .map(normalizeForMatch)
      .filter((value) => value.length >= 4);
    const declaredAliases = (choice.answerAliases || [])
      .map(normalizeForMatch)
      .filter((value) => [...value].length >= 2);
    const candidates = [...stableCandidates, ...declaredAliases];
    return (
      !isDeclaredChoiceNegated(choice, answer)
      && candidates.some((candidate) => containsNormalizedCandidate(normalized, candidate))
    );
  });
}

function resolveExplicitDeclaredIdentifiers(
  request: HumanInterventionRequest,
  answer: string
): HumanInterventionChoice[] {
  const normalized = normalizeForMatch(answer);
  if (!normalized) {
    return [];
  }
  return (request.choices || []).filter((choice) =>
    [choice.id, choice.targetNode || ""]
      .map(normalizeForMatch)
      .filter((candidate) => candidate.length >= 4)
      .some((candidate) => isAffirmativeIdentifierCommand(normalized, candidate))
  );
}

function isAffirmativeIdentifierCommand(normalizedAnswer: string, candidate: string): boolean {
  return (
    normalizedAnswer === candidate
    || isAffirmativeRouteCommand(normalizedAnswer, candidate)
    || new RegExp(
      `^(?:please )?(?:select|choose|use) ${escapeRegExp(candidate)}$`,
      "u"
    ).test(normalizedAnswer)
  );
}

function isAffirmativeRouteCommand(normalizedAnswer: string, candidate: string): boolean {
  const escapedCandidate = escapeRegExp(candidate);
  return (
    new RegExp(
      `^(?:please )?(?:(?:could|can|would|will) you (?:please |kindly )?)?(?:return|go|jump|move|switch|backtrack) (?:back )?(?:to )?${escapedCandidate}(?: and (?:repair|revise|inspect|check|update|fix) (?:the )?[\\p{L}\\p{N}_ ]{1,80})?$`,
      "u"
    ).test(normalizedAnswer)
    || new RegExp(
      `^${escapedCandidate}(?:(?:으로|로)| (?:으로|로)) (?:돌아가|이동해|전환해) (?:주세요|주십시오|줘)$`,
      "u"
    ).test(normalizedAnswer)
  );
}

function resolveExplicitCurrentRouteInOrderedPlan(
  request: HumanInterventionRequest,
  answer: string
): HumanInterventionChoice | undefined {
  const normalized = normalizeForMatch(answer);
  if (
    !normalized
    || /\b(?:or|versus|vs|either|maybe|perhaps|possibly|might)\b|(?:또는|혹은|아마|어쩌면)/u.test(normalized)
  ) {
    return undefined;
  }

  const routeAction = "(?:return|go|jump|move|switch|backtrack)";
  const matches: HumanInterventionChoice[] = [];
  for (const choice of request.choices || []) {
    if (isDeclaredChoiceNegated(choice, answer)) {
      continue;
    }
    const candidates = [choice.id, choice.targetNode || "", ...(choice.answerAliases || [])]
      .map(normalizeForMatch)
      .filter((candidate) => candidate.length >= 4);
    const isMarkedCurrentRoute = candidates.some((candidate) => {
      const escapedCandidate = escapeRegExp(candidate);
      const firstBefore = new RegExp(
        `(?:^| )(?:please )?first ${routeAction} (?:back )?(?:to )?${escapedCandidate}(?=$| )`,
        "u"
      ).exec(normalized);
      if (firstBefore) {
        const tail = normalized.slice((firstBefore.index || 0) + firstBefore[0].length).trim();
        if (/^(?:then|after that)\b|^and\b.*\blater\b/u.test(tail)) {
          return true;
        }
      }

      const koreanFirst = new RegExp(
        `(?:^| )먼저 ${escapedCandidate}(?:(?:으로|로)| (?:으로|로)) (?:돌아간|이동한|전환한)(?=$| )`,
        "u"
      ).exec(normalized);
      if (koreanFirst) {
        const tail = normalized.slice((koreanFirst.index || 0) + koreanFirst[0].length).trim();
        if (/^다음(?:에)?(?: 나중에)?(?: |$)/u.test(tail)) {
          return true;
        }
      }

      const markerAfter = new RegExp(
        `(?:^| )(?:please )?${routeAction} (?:back )?(?:to )?${escapedCandidate} (now|first)(?=$| )`,
        "u"
      ).exec(normalized);
      if (!markerAfter) {
        return false;
      }
      const marker = markerAfter[1];
      const tail = normalized.slice((markerAfter.index || 0) + markerAfter[0].length).trim();
      return marker === "first"
        ? /^(?:then|after that)\b|^and\b.*\blater\b/u.test(tail)
        : /^(?:then|after that)\b|^and\b.*\blater\b|^(?:i|we) (?:can|could|will|would|may|should)\b.*\blater\b/u.test(tail);
    });
    if (isMarkedCurrentRoute) {
      matches.push(choice);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function looksExplicitlyUncertain(answer: string): boolean {
  const normalized = normalizeForMatch(answer);
  return [
    /\b(?:not sure|do not know|don t know|uncertain|either one|cannot decide|whichever|you decide|do whatever|whatever you think|either (?:route|path) works|one of (?:the )?(?:available )?(?:routes|paths|options|choices)|neither (?:of )?(?:the )?(?:routes?|paths?|options?|choices?)|none of (?:(?:them|those|these)|the (?:routes|paths|options|choices)))\b/u,
    /(?:잘 모르|모르겠|확신이 없|애매|결정 못|둘 다|어느 쪽)/u
  ].some((pattern) => pattern.test(normalized));
}

function looksDeferred(answer: string, hasOrderedCurrentRoute = false): boolean {
  const normalized = normalizeForMatch(answer);
  if (
    /\b(?:maybe|perhaps|possibly|might|someday|eventually|tbd|to be determined|undecided|unsure)\b/u.test(normalized)
    || /(?:보류|언젠가|아마|어쩌면|미정|결정 전|확정 전)/u.test(normalized)
  ) {
    return true;
  }
  return (/\blater\b/u.test(normalized) || /나중/u.test(normalized))
    && !hasOrderedCurrentRoute;
}

function looksInterrogative(request: HumanInterventionRequest, answer: string): boolean {
  const hasQuestionMark = /[?？]\s*$/u.test(answer);
  const normalized = normalizeForMatch(answer.replace(/[?？]\s*$/u, ""));
  if (
    /^(?:should (?:i|we|you)|(?:can|could|would|will|may) (?:i|we)|(?:do|does|did) (?:i|we)|(?:is|are|was|were)\b|(?:what|which|where|why|how|when)\b)/u.test(normalized)
    || /^would (?:the )?[\p{L}\p{N}_]+(?: [\p{L}\p{N}_]+){0,5} be (?:better|safer|preferred|acceptable)\b/u.test(normalized)
    || /(?:돌아갈까요|이동할까요|전환할까요|선택할까요|사용할까요|진행할까요)$/u.test(normalized)
  ) {
    return true;
  }
  if (!hasQuestionMark) {
    return false;
  }
  const candidates = (request.choices || []).flatMap((choice) => [
    choice.id,
    choice.targetNode || "",
    ...(choice.answerAliases || [])
  ]);
  return !candidates
    .map(normalizeForMatch)
    .filter((candidate) => candidate.length >= 2)
    .some((candidate) => isAffirmativeRouteCommand(normalized, candidate));
}

function hasNonAffirmativeDecisionStructure(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  return (
    looksLikeStandaloneRefusal(request, answer)
    || looksDecisionHedged(request, answer)
    || looksLikeDelegatedChoice(request, answer)
  );
}

function looksDecisionHedged(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const normalized = normalizeForMatch(answer);
  const englishHedge = (
    /^(?:probably|possibly|perhaps|maybe)\b/u.test(normalized)
    || /\b(?:i guess|i suppose|i think|probably|possibly|perhaps|maybe)$/u.test(normalized)
  );
  const koreanHedge = /(?:인 것 같아요|인 듯해요|일 수도 있어요|일지도 몰라요)$/u.test(normalized);
  return englishHedge || (koreanHedge && answerReferencesDeclaredChoice(request, normalized));
}

function looksLikeDelegatedChoice(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  if ((request.choices || []).length < 2) {
    return false;
  }
  const normalized = normalizeForMatch(answer);
  return (
    /(?:둘|두 (?:개|가지)|선택지) 중 (?:아무거나|어느 것이나|하나(?:를)?) (?:해|선택해) (?:주세요|주십시오|줘)$/u.test(normalized)
    || /^(?:둘 중 )?아무거나 (?:해|선택해) (?:주세요|주십시오|줘)$/u.test(normalized)
  );
}

function answerReferencesDeclaredChoice(
  request: HumanInterventionRequest,
  normalizedAnswer: string
): boolean {
  return (request.choices || []).some((choice) => (
    [choice.id, choice.label, choice.targetNode || "", ...(choice.answerAliases || [])]
      .map(normalizeForMatch)
      .filter((candidate) => candidate.length >= 2)
      .some((candidate) => new RegExp(
        `(?:^| )${escapeRegExp(candidate)}(?:(?:으로|로)(?:은|는)?|(?:을|를|은|는|인|일))?(?:$| )`,
        "u"
      ).test(normalizedAnswer))
  ));
}

function looksLikeStandaloneRefusal(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const normalized = normalizeForMatch(answer);
  const genericRefusal = (
    /^(?:please )?(?:do not|don t|dont|never) (?:continue|proceed|retry|go on|carry on|move forward)(?: .*)?$/u.test(normalized)
    || /^(?:i|we) (?:[\p{L}\p{N}_-]+ ){0,3}(?:refuse|decline) to (?:continue|proceed)(?: .*)?$/u.test(normalized)
    || /^(?:i|we) (?:do not|don t|dont) (?:want|agree) to (?:continue|proceed)(?: .*)?$/u.test(normalized)
    || /^(?:no (?:thanks|thank you)|(?:please )?(?:stop|cancel|abort|pause|wait)(?: now| please)?)$/u.test(normalized)
  );
  const koreanGenericRefusal = (
    /^(?:(?:(?:이 실행을|절대(?:로)?|더 이상) )*계속 진행하지 (?:마세요|마십시오)|(?:저는|나는|우리는)(?: [\p{L}\p{N}_]+){0,6} 계속 진행하는 것을 거부합니다)$/u.test(normalized)
    || /^(?:아니요|아니요 괜찮습니다|이제 그만(?:할게요|하겠습니다)|(?:계속 )?진행하지 (?:말아|마) 주세요|진행을 중단해 주세요)$/u.test(normalized)
  );
  const hasAffirmativeRouteAfterBoundary = hasAffirmativeDeclaredRouteAfterRefusal(
    request,
    answer
  );
  return (
    /^(?:no|no thanks|no thank you|stop|stop now|please stop|cancel|abort|pause|wait|i refuse|do not continue|don t continue|dont continue|do not proceed|don t proceed|dont proceed|do not retry|don t retry|dont retry)(?: please)?$/u.test(normalized)
    || (genericRefusal && !hasAffirmativeRouteAfterBoundary)
    || (koreanGenericRefusal && !hasAffirmativeRouteAfterBoundary)
    || /^(?:아니|아니요|중단|중단해|취소|취소해|멈춰|기다려|거부|진행하지 마|계속하지 마)(?: 주세요| 줘)?$/u.test(normalized)
  );
}

function hasAffirmativeDeclaredRouteAfterRefusal(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const refusalPrefix = "(?:"
    + "(?:please\\s+)?(?:do\\s+not|don't|dont|never)\\s+(?:continue|proceed|retry|go\\s+on|carry\\s+on|move\\s+forward)\\b[^;.!?,]*"
    + "|(?:i|we)\\s+(?:[\\p{L}\\p{N}_-]+\\s+){0,3}(?:refuse|decline)\\s+to\\s+(?:continue|proceed)\\b[^;.!?,]*"
    + "|(?:please\\s+)?(?:stop|cancel|abort|pause|wait)(?:\\s+now|\\s+please)?"
    + "|no\\s+(?:thanks|thank\\s+you)"
    + "|(?:(?:(?:이\\s+실행을|절대(?:로)?|더\\s+이상)\\s+)*계속\\s+진행하지\\s+(?:마세요|마십시오))"
    + "|(?:(?:저는|나는|우리는)(?:\\s+[\\p{L}\\p{N}_]+){0,6}\\s+계속\\s+진행하는\\s+것을\\s+거부합니다)"
    + "|(?:아니요(?:\\s*,?\\s*괜찮습니다)?)"
    + "|(?:이제\\s+그만(?:할게요|하겠습니다))"
    + "|(?:(?:계속\\s+)?진행하지\\s+(?:말아|마)\\s+주세요)"
    + "|(?:진행을\\s+중단해\\s+주세요)"
    + ")";
  const boundary = "(?:\\s*[;.!]\\s*|\\s*,\\s*|\\s+(?:but|so|therefore|then|however|대신|그래서)\\s+)";
  const match = new RegExp(`^\\s*${refusalPrefix}${boundary}(.+)$`, "iu").exec(answer);
  if (!match?.[1]) {
    return false;
  }
  const suffix = match[1].trim().replace(/^(?:instead|대신|그래서)\s+/iu, "");
  const ordered = resolveExplicitCurrentRouteInOrderedPlan(request, suffix);
  if (ordered) {
    return true;
  }
  const routes = resolveExplicitDeclaredRoutes(request, suffix);
  if (routes.length !== 1) {
    return false;
  }
  const normalizedSuffix = normalizeForMatch(suffix);
  return [routes[0]!.id, routes[0]!.targetNode || "", ...(routes[0]!.answerAliases || [])]
    .map(normalizeForMatch)
    .filter((candidate) => candidate.length >= 2)
    .some((candidate) => isAffirmativeRouteCommand(normalizedSuffix, candidate));
}

function looksChoiceAmbiguous(request: HumanInterventionRequest, answer: string): boolean {
  const normalized = normalizeForMatch(answer);
  return (
    (
      (request.choices || []).length >= 2
      && (
        /^(?:both |either )?(?:(?:choice|option) )?(?:\d+|one|two|three|first|second|third)(?: (?:choice|option))? (?:(?:and|or|versus|vs) )?(?:(?:choice|option) )?(?:\d+|one|two|three|first|second|third)(?: (?:choice|option))?$/u.test(normalized)
        || /\bbetween (?:(?:choice|option) )?(?:1|one|first) and (?:(?:choice|option) )?(?:2|two|second)(?: option| choice)?\b/u.test(normalized)
        || /\b(?:the )?first (?:option )?(?:or|versus|vs) (?:the )?second option\b/u.test(normalized)
        || /\b(?:one|either) of (?:those|the) (?:two|options|choices)\b/u.test(normalized)
        || /\b(?:both|all) (?:of )?(?:the )?(?:routes|paths|options|choices)\b/u.test(normalized)
        || /\b(?:the )?former or (?:the )?latter\b/u.test(normalized)
        || /(?:둘 중 (?:하나|어느)|첫 ?번째(?:나| 또는| 혹은) 두 ?번째|1 ?번(?:이나| 또는| 혹은) 2 ?번|전자(?:나| 또는| 혹은) 후자)/u.test(normalized)
      )
    )
    || /^(?:both )?(?:(?:revise|repair|redesign) (?:and|then) (?:inspect|implement)|(?:inspect|implement) (?:and|then) (?:revise|repair|redesign))$/u.test(normalized)
    || /^(?:neither )(?:(?:revise|repair|redesign) nor (?:inspect|implement)|(?:inspect|implement) nor (?:revise|repair|redesign))$/u.test(normalized)
    || hasActionAlternative(request, normalized)
  );
}

function hasActionAlternative(
  request: HumanInterventionRequest,
  normalizedAnswer: string
): boolean {
  const alternatives = normalizedAnswer
    .split(/\s+(?:or|versus|vs)\s+|\s*(?:또는|혹은)\s*/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (alternatives.length < 2) {
    return false;
  }
  const candidates = (request.choices || []).flatMap((choice) => [
    choice.id,
    choice.targetNode || "",
    ...(choice.answerAliases || [])
  ])
    .map(normalizeForMatch)
    .filter((candidate) => candidate.length >= 2);
  const defaultAction = normalizeForMatch(request.resumeAction);
  const expressesAction = (part: string): boolean => (
    /\b(?:declared )?default(?: action)?\b/u.test(part)
    || part === defaultAction
    || candidates.some((candidate) => containsNormalizedCandidate(part, candidate))
    || GRAPH_NODE_ORDER.some((node) => part === normalizeForMatch(node))
    || /\b(?:return|go|jump|move|switch|backtrack)\b(?: [\p{L}\p{N}_]+){1,8}$/u.test(part)
    || /^(?:please )?(?:retry|continue|approve|apply|revise|inspect)$/u.test(part)
    || /^(?:stay|remain)(?: here)?$/u.test(part)
    || /(?:돌아가|이동해|전환해|선택해|적용해|재시도|계속해)$/u.test(part)
  );
  return alternatives.filter(expressesAction).length >= 2;
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
}

function containsNormalizedCandidate(normalizedAnswer: string, normalizedCandidate: string): boolean {
  if (!normalizedAnswer || !normalizedCandidate) {
    return false;
  }
  return new RegExp(
    `(?:^| )${escapeRegExp(normalizedCandidate)}(?:(?:으로|로)(?:은|는)?|(?:을|를|은|는))?(?:$| )`,
    "u"
  ).test(normalizedAnswer);
}

function isDeclaredChoiceNegated(
  choice: HumanInterventionChoice,
  answer: string
): boolean {
  const candidates = [
    choice.id,
    choice.label,
    choice.targetNode || "",
    ...(choice.answerAliases || [])
  ]
    .map(normalizeForMatch)
    .filter((candidate) => candidate.length >= 2);
  return candidates.some((candidate) => (
    candidateAppearsInNegatedClause(answer, candidate)
    || (
      !candidate.includes(" ")
      && candidateAppearsInNegatedClause(answer, `re${candidate}`)
    )
  ));
}

function isDeclaredChoiceReferenceNegated(
  request: HumanInterventionRequest,
  choice: HumanInterventionChoice,
  answer: string
): boolean {
  if (isDeclaredChoiceNegated(choice, answer)) {
    return true;
  }
  const index = (request.choices || []).indexOf(choice);
  const ordinals = ["first", "second", "third"];
  if (index < 0 || index >= ordinals.length) {
    return false;
  }
  const position = String(index + 1);
  const ordinal = ordinals[index]!;
  return [
    `option ${position}`,
    `choice ${position}`,
    `${ordinal} option`,
    `${ordinal} choice`,
    `the ${ordinal} option`,
    `the ${ordinal} choice`
  ].some((candidate) => candidateAppearsInNegatedClause(answer, candidate));
}

function isDeclaredDefaultNegated(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const candidates = [
    "declared default",
    "the declared default",
    "default action",
    request.resumeAction
  ]
    .map(normalizeForMatch)
    .filter((candidate) => candidate.length >= 2);
  return candidates.some((candidate) => candidateAppearsInNegatedClause(answer, candidate));
}

function negatesOnlyDeclaredDecision(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const hasNegatedChoice = (request.choices || []).some((choice) => (
    isDeclaredChoiceReferenceNegated(request, choice, answer)
  ));
  const hasNegatedDefault = isDeclaredDefaultNegated(request, answer);
  if (!hasNegatedChoice && !hasNegatedDefault) {
    return false;
  }
  return resolveExplicitDeclaredRoutes(request, answer).length === 0;
}

function negatesVerifiedObjectiveMetricCriterion(
  answer: string,
  criteria: VerifiedMetricCriterion[]
): boolean {
  return criteria.some((criterion) => {
    const prefix = answer
      .slice(0, criterion.start)
      .split(DECISION_CLAUSE_SEPARATOR)
      .at(-1) || "";
    const suffix = answer
      .slice(criterion.end)
      .split(DECISION_CLAUSE_SEPARATOR)[0] || "";
    return hasNegatedContext(normalizeForMatch(prefix), normalizeForMatch(suffix));
  });
}

function candidateAppearsInNegatedSpan(normalizedAnswer: string, candidate: string): boolean {
  return candidateMatchesWithContext(normalizedAnswer, candidate, hasNegatedContext);
}

function candidateAppearsInNegatedClause(answer: string, candidate: string): boolean {
  return splitDecisionClauses(answer).some((clause) => (
    candidateAppearsInNegatedSpan(clause, candidate)
  ));
}

const DECISION_CLAUSE_SEPARATOR = /[;:!?]+|(?<!\d)\.|\.(?!\d)|\b(?:but|so|therefore|then|however)\b|(?:그래서|따라서|하지만|그러므로)/iu;

function splitDecisionClauses(answer: string): string[] {
  const scopedComma = answer.replace(
    /^(\s*(?:(?:please\s+)?(?:do\s+not|don't|dont|never)\s+(?:continue|proceed|retry|go\s+on|carry\s+on|move\s+forward)\b[^,;.!?]*|(?:i|we)\s+(?:[\p{L}\p{N}_-]+\s+){0,3}(?:refuse|decline)\s+to\s+(?:continue|proceed)\b[^,;.!?]*|(?:please\s+)?(?:stop|cancel|abort|pause|wait)(?:\s+now|\s+please)?|no\s+(?:thanks|thank\s+you)|(?:(?:(?:이\s+실행을|절대(?:로)?)\s+)*계속\s+진행하지\s+(?:마세요|마십시오))|(?:(?:저는|나는|우리는)(?:\s+[\p{L}\p{N}_]+){0,6}\s+계속\s+진행하는\s+것을\s+거부합니다)|(?:아니요(?:\s*,?\s*괜찮습니다)?)|(?:이제\s+그만(?:할게요|하겠습니다))|(?:(?:계속\s+)?진행하지\s+(?:말아|마)\s+주세요))),\s*(?=(?:(?:instead|대신|그래서)\s+)?(?:(?:please\s+)?(?:return|go|jump|move|switch|backtrack)\b|[\p{L}\p{N}_]+(?:으로|로)\s*(?:돌아가|이동해|전환해)))/iu,
    "$1; "
  );
  return scopedComma
    .split(DECISION_CLAUSE_SEPARATOR)
    .map(normalizeForMatch)
    .filter(Boolean);
}

function hasNegatedContext(prefix: string, suffix: string): boolean {
  const scopedPrefix = prefix
    .split(/(?:^| )(?:but|so|therefore|then|however|그래서|따라서|하지만|그러므로)(?: |$)/u)
    .at(-1)
    ?.trim() || prefix;
  return (
    /(?:^| )(?:no|do not|don t|dont|never|not|avoid|avoiding|exclude|excluding|reject|decline|skip|cannot|can t|cant|won t|wont|without|except|instead of|refrain(?:ing)? from)(?: [\p{L}\p{N}_]+){0,7}$/u.test(scopedPrefix)
    || hasLongRangeNegatedRoutePrefix(scopedPrefix)
    || /^(?:is|are|was|were|should|must|can|could|may|will|would) (?:[\p{L}\p{N}_-]+ ){0,4}(?:not|never)(?: be)? (?:used|selected|chosen|accepted|acceptable|allowed|wanted|approved)\b/u.test(suffix)
    || /^(?:(?:is|are|was|were|should|must|can|could|may|will|would) ){0,2}(?:not|never)(?: be)? (?:used|selected|chosen|accepted|acceptable|allowed|wanted|approved)\b/u.test(suffix)
    || /^(?:(?:should|must|can|could|may|will|would) )?under no circumstances (?:be )?(?:used|selected|chosen|accepted|allowed|wanted|approved)\b/u.test(suffix)
    || /^(?:isn t|isnt|aren t|arent|wasn t|wasnt|weren t|werent|shouldn t|shouldnt|mustn t|mustnt|can t|cant|couldn t|couldnt|won t|wont|wouldn t|wouldnt) (?:be )?(?:used|selected|chosen|accepted|acceptable|allowed|wanted|approved)\b/u.test(suffix)
    || /^(?:(?:is|are|was|were|should|must|can|could|may|will|would) ){0,2}(?:be )?(?:avoided|rejected|declined|unacceptable|disallowed|forbidden)\b/u.test(suffix)
    || /^(?:is|are|was|were)? ?(?:a )?bad idea\b/u.test(suffix)
    || /^(?:does not|doesn t|doesnt|did not|didn t|didnt) (?:work|fit|apply)\b/u.test(suffix)
    || /^(?:is|are|was|were) wrong\b/u.test(suffix)
    || /^(?:is |was )?off the table(?:$| )/u.test(suffix)
    || /^(?:절대|절대로) (?:선택|사용)(?:하면|해서)? 안 (?:됩니다|돼|됨)(?:$| )/u.test(suffix)
    || /^(?:선택|사용)(?:하면|해서) 안 (?:됩니다|돼요|돼|됨)(?:$| )/u.test(suffix)
    || /^(?:돌아가|이동하|전환하)면 안 (?:됩니다|돼요|돼|됨)(?:$| )/u.test(suffix)
    || /^안 (?:됩니다|돼|됨)(?:$| )/u.test(suffix)
    || /^대신(?:$| )/u.test(suffix)
    || /^(?:[\p{L}\p{N}_]+ ){0,5}[\p{L}\p{N}_]*지 ?(?:마|않|말)/u.test(suffix)
    || /^(?:[\p{L}\p{N}_]+ ){0,5}말고/u.test(suffix)
  );
}

function hasLongRangeNegatedRoutePrefix(prefix: string): boolean {
  const negations = [...prefix.matchAll(
    /(?:^| )(?:do not|don t|dont|never|under no circumstances)(?: |$)/gu
  )];
  const negation = negations.at(-1);
  if (!negation) {
    return false;
  }
  const tail = prefix.slice((negation.index || 0) + negation[0].length).trim();
  if (
    !tail
    || /^(?:hesitate|fail|forget|wait)\b/u.test(tail)
    || /\b(?:but|so|therefore|however|instead)\b/u.test(tail)
  ) {
    return false;
  }
  const actions = [...tail.matchAll(
    /\b(?:return|go|jump|move|switch|backtrack|select|choose|use)\b/gu
  )];
  if (actions.length === 0) {
    return false;
  }
  const action = actions.at(-1)!;
  const afterAction = tail.slice((action.index || 0) + action[0].length).trim();
  return /^(?:back(?: to)?|to)?$/u.test(afterAction);
}

function containsUnboundObjectiveMetricCriterion(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  if (request.kind !== "objective_metric_clarification") {
    return false;
  }
  const available = new Set(
    extractAvailableMetricKeys(request.context).map((metric) => metric.toLowerCase())
  );
  return extractMetricLikeCriterionKeys(answer).some((rawKey) => {
    const key = rawKey.toLowerCase();
    if (available.has(key)) {
      return false;
    }
    const withoutKoreanParticle = key.replace(/(?:은|는|을|를)$/u, "");
    return !available.has(withoutKoreanParticle);
  });
}

function extractMetricLikeCriterionKeys(answer: string): string[] {
  const identifier = "[\\p{L}\\p{N}_][\\p{L}\\p{N}_.:/-]{0,127}";
  const number = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const keys: string[] = [];
  const collect = (pattern: RegExp): void => {
    for (const match of answer.matchAll(pattern)) {
      if (match[2]) {
        keys.push(match[2]);
      }
    }
  };
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${identifier})(?:은|는|을|를)?\\s*(?:>=|<=|==|!=|>|<|=)\\s*${number}%?`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${identifier})\\s+(?:should\\s+be\\s+)?(?:not\\s+less\\s+than|not\\s+greater\\s+than|at\\s+least|at\\s+most|above|below|greater\\s+than|less\\s+than)\\s+${number}%?`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${identifier})(?:은|는|을|를)?\\s*${number}%?\\s*(?:이상|이하|초과|미만|증가|감소|개선)`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(?:maximize|minimize)\\s+(?:the\\s+)?(${identifier})`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${identifier})\\s+(?:should\\s+be\\s+)?(?:maximized|minimized)\\b`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(?:increase|decrease|improve|reduce)\\s+(?:the\\s+)?(${identifier})\\s+by\\s+${number}%?`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(${identifier})\\s+(?:should\\s+)?(?:increase|decrease|improve|reduce)\\s+by\\s+${number}%?`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(?:set\\s+)(?:the\\s+)?(${identifier})\\s+(?:threshold|target|cutoff)\\s+to\\s+${number}%?`,
    "giu"
  ));
  collect(new RegExp(
    `(^|[^\\p{L}\\p{N}_])(?:use|select|set)\\s+(?:the\\s+)?(${identifier})\\s+as\\s+(?:the\\s+)?(?:metric|objective\\s+metric)\\b`,
    "giu"
  ));
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}

function candidateMatchesWithContext(
  normalizedAnswer: string,
  normalizedCandidate: string,
  predicate: (prefix: string, suffix: string) => boolean
): boolean {
  if (!normalizedAnswer || !normalizedCandidate) {
    return false;
  }
  const matcher = new RegExp(
    `(^| )${escapeRegExp(normalizedCandidate)}(?:(?:으로|로)(?:은|는)?|(?:을|를|은|는))?(?=$| )`,
    "gu"
  );
  for (const match of normalizedAnswer.matchAll(matcher)) {
    const leadingLength = match[1]?.length || 0;
    const candidateStart = (match.index || 0) + leadingLength;
    const candidateEnd = (match.index || 0) + match[0].length;
    const prefix = normalizedAnswer.slice(0, candidateStart).trim();
    const suffix = normalizedAnswer.slice(candidateEnd).trim();
    if (predicate(prefix, suffix)) {
      return true;
    }
  }
  return false;
}

function explicitlyAcceptsDeclaredDefault(
  request: HumanInterventionRequest,
  answer: string
): boolean {
  const normalized = normalizeForMatch(answer);
  const resumeAction = normalizeForMatch(request.resumeAction);
  return new Set([
    "use the declared default",
    "use declared default",
    "accept the declared default",
    "accept declared default",
    "apply the declared default",
    "apply declared default",
    "기본 동작으로 진행",
    "선언된 기본 동작으로 진행",
    "기본 동작 적용",
    "선언된 기본 동작 적용",
    resumeAction,
    `use ${resumeAction}`,
    `accept ${resumeAction}`,
    `apply ${resumeAction}`
  ]).has(normalized);
}

function extractVerifiedObjectiveMetricCriteria(
  request: HumanInterventionRequest,
  answer: string
): VerifiedMetricCriterion[] {
  if (request.kind !== "objective_metric_clarification") {
    return [];
  }
  const availableMetrics = extractAvailableMetricKeys(request.context);
  if (availableMetrics.length === 0) {
    return [];
  }
  const criteria: VerifiedMetricCriterion[] = [];
  const numberSource = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";

  for (const metric of availableMetrics) {
    const metricSource = escapeRegExp(metric);
    const metricToken = `(${metricSource})(?:은|는|을|를)?(?=$|[^\\p{L}\\p{N}_])`;
    const collect = (
      pattern: RegExp,
      build: (match: RegExpMatchArray) => Omit<VerifiedMetricCriterion, "metric" | "start" | "end">
    ): void => {
      for (const match of answer.matchAll(pattern)) {
        const leadingLength = match[1]?.length || 0;
        criteria.push({
          metric,
          start: (match.index || 0) + leadingLength,
          end: (match.index || 0) + match[0].length,
          ...build(match)
        });
      }
    };

    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s*(>=|<=|==|!=|>|<|=)\\s*(${numberSource})%?`,
        "giu"
      ),
      (match) => ({
        kind: "numeric",
        comparator: match[3] as MetricComparator,
        value: Number(match[4])
      })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s+(?:should\\s+be\\s+)?(not\\s+less\\s+than|not\\s+greater\\s+than|at\\s+least|at\\s+most|above|below|greater\\s+than|less\\s+than)\\s+(${numberSource})%?`,
        "giu"
      ),
      (match) => ({
        kind: "numeric",
        comparator: naturalMetricComparator(match[3] || ""),
        value: Number(match[4])
      })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s*(${numberSource})%?\\s*(이상|이하|초과|미만)`,
        "gu"
      ),
      (match) => ({
        kind: "numeric",
        comparator: koreanMetricComparator(match[4] || ""),
        value: Number(match[3])
      })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])(maximize|minimize)\\s+(?:the\\s+)?${metricToken}`,
        "giu"
      ),
      (match) => ({ kind: "objective", direction: match[2]?.toLowerCase() })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s+(?:should\\s+be\\s+)?(maximized|minimized)\\b`,
        "giu"
      ),
      (match) => ({
        kind: "objective",
        direction: match[3]?.toLowerCase().replace(/d$/u, "")
      })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])(increase|decrease|improve|reduce)\\s+(?:the\\s+)?${metricToken}\\s+by\\s+(${numberSource})%?`,
        "giu"
      ),
      (match) => ({ kind: "change", direction: match[2]?.toLowerCase(), value: Number(match[4]) })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s+(?:should\\s+)?(increase|decrease|improve|reduce)\\s+by\\s+(${numberSource})%?`,
        "giu"
      ),
      (match) => ({ kind: "change", direction: match[3]?.toLowerCase(), value: Number(match[4]) })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s*(최대화|최소화)`,
        "gu"
      ),
      (match) => ({ kind: "objective", direction: match[3] })
    );
    collect(
      new RegExp(
        `(^|[^\\p{L}\\p{N}_])${metricToken}\\s*(${numberSource})%?\\s*(증가|감소|개선)`,
        "gu"
      ),
      (match) => ({ kind: "change", direction: match[4], value: Number(match[3]) })
    );
  }

  return criteria.filter((criterion, index, all) => all.findIndex((candidate) => (
    candidate.metric.toLowerCase() === criterion.metric.toLowerCase()
    && candidate.kind === criterion.kind
    && candidate.start === criterion.start
    && candidate.end === criterion.end
    && candidate.comparator === criterion.comparator
    && candidate.direction === criterion.direction
    && candidate.value === criterion.value
  )) === index);
}

function isAffirmativeMetricCriterionAnswer(
  answer: string,
  criteria: VerifiedMetricCriterion[]
): boolean {
  if (criteria.some((criterion) => (
    (criterion.value !== undefined && !Number.isFinite(criterion.value))
    || (criterion.kind === "change" && criterion.value! <= 0)
  ))) {
    return false;
  }
  const ordered = [...criteria].sort((left, right) => left.start - right.start || left.end - right.end);
  if (ordered.length === 0) {
    return false;
  }
  const prefix = normalizeForMatch(
    answer.slice(0, ordered[0]!.start).split(DECISION_CLAUSE_SEPARATOR).at(-1) || ""
  );
  if (![
    "",
    "use",
    "apply",
    "set",
    "please use",
    "please apply",
    "let s use",
    "lets use"
  ].includes(prefix)) {
    return false;
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (current.start < previous.end) {
      return false;
    }
    const conjunction = normalizeForMatch(answer.slice(previous.end, current.start));
    if (!["and", "그리고", "및"].includes(conjunction)) {
      return false;
    }
  }
  const suffix = normalizeForMatch(
    answer.slice(ordered[ordered.length - 1]!.end).split(DECISION_CLAUSE_SEPARATOR)[0] || ""
  );
  return (
    !suffix
    || /^without (?:exceeding|violating) (?:the )?[\p{L}\p{N}_]+(?: [\p{L}\p{N}_]+){0,5}$/u.test(suffix)
    || /^as (?:the|our) (?:(?:success|acceptance|evaluation|decision) )?(?:target|threshold|criterion)$/u.test(suffix)
    || /^(?:because it is|since (?:it|that) is) the (?:primary outcome|success threshold)$/u.test(suffix)
    || /^(?:으로|로) (?:해 ?주세요|설정해 ?주세요)$/u.test(suffix)
  );
}

function naturalMetricComparator(value: string): MetricComparator {
  switch (normalizeForMatch(value)) {
    case "not less than":
    case "at least":
      return ">=";
    case "not greater than":
    case "at most":
      return "<=";
    case "above":
    case "greater than":
      return ">";
    default:
      return "<";
  }
}

function koreanMetricComparator(value: string): MetricComparator {
  switch (value) {
    case "이상":
      return ">=";
    case "이하":
      return "<=";
    case "초과":
      return ">";
    default:
      return "<";
  }
}

function isAmbiguousMetricCriterion(
  answer: string,
  criteria: VerifiedMetricCriterion[]
): boolean {
  if (criteria.length === 0) {
    return false;
  }
  if (/\b(?:or|either)\b|(?:또는|혹은)/iu.test(answer)) {
    return true;
  }

  const grouped = new Map<string, VerifiedMetricCriterion[]>();
  for (const criterion of criteria) {
    const key = criterion.metric.toLowerCase();
    grouped.set(key, [...(grouped.get(key) || []), criterion]);
  }
  return [...grouped.values()].some((items) => metricCriteriaConflict(items));
}

function metricCriteriaConflict(criteria: VerifiedMetricCriterion[]): boolean {
  const changeMagnitudes = new Set(criteria
    .filter((item) => item.kind === "change" && Number.isFinite(item.value))
    .map((item) => item.value!));
  if (changeMagnitudes.size > 1) {
    return true;
  }

  const directionalPolarities = new Set(criteria
    .filter((item) => item.kind === "objective" || item.kind === "change")
    .map((item) => ["minimize", "최소화", "decrease", "reduce", "감소"].includes(item.direction || "")
      ? -1
      : 1));
  if (directionalPolarities.size > 1) {
    return true;
  }

  const numeric = criteria.filter((item) => (
    item.kind === "numeric" && item.comparator && Number.isFinite(item.value)
  ));
  const equalValues = new Set(numeric
    .filter((item) => item.comparator === "=" || item.comparator === "==")
    .map((item) => item.value!));
  if (equalValues.size > 1) {
    return true;
  }

  let lower: { value: number; inclusive: boolean } | undefined;
  let upper: { value: number; inclusive: boolean } | undefined;
  const excluded = new Set<number>();
  for (const criterion of numeric) {
    const value = criterion.value!;
    if (criterion.comparator === ">" || criterion.comparator === ">=") {
      const candidate = { value, inclusive: criterion.comparator === ">=" };
      if (!lower || candidate.value > lower.value || (
        candidate.value === lower.value && !candidate.inclusive && lower.inclusive
      )) {
        lower = candidate;
      }
    } else if (criterion.comparator === "<" || criterion.comparator === "<=") {
      const candidate = { value, inclusive: criterion.comparator === "<=" };
      if (!upper || candidate.value < upper.value || (
        candidate.value === upper.value && !candidate.inclusive && upper.inclusive
      )) {
        upper = candidate;
      }
    } else if (criterion.comparator === "!=") {
      excluded.add(value);
    }
  }

  const equalValue = equalValues.size === 1 ? [...equalValues][0] : undefined;
  if (equalValue !== undefined) {
    return excluded.has(equalValue)
      || Boolean(lower && (equalValue < lower.value || (equalValue === lower.value && !lower.inclusive)))
      || Boolean(upper && (equalValue > upper.value || (equalValue === upper.value && !upper.inclusive)));
  }
  if (
    lower
    && upper
    && lower.value === upper.value
    && lower.inclusive
    && upper.inclusive
    && excluded.has(lower.value)
  ) {
    return true;
  }
  return Boolean(lower && upper && (
    lower.value > upper.value
    || (lower.value === upper.value && (!lower.inclusive || !upper.inclusive))
  ));
}

function extractAvailableMetricKeys(context: string[]): string[] {
  const metrics: string[] = [];
  for (const line of context) {
    const match = line.match(/^\s*available\s+(?:numeric\s+)?metrics?\s*:\s*(.+)$/iu)
      || line.match(/^\s*사용 가능한(?:\s+수치형)?\s+지표\s*:\s*(.+)$/u);
    if (!match?.[1]) {
      continue;
    }
    for (const candidate of match[1].replace(/[.!?]+$/u, "").split(/[,;]/u)) {
      const metric = candidate.trim();
      if (/^[\p{L}\p{N}_][\p{L}\p{N}_.:/-]{0,127}$/u.test(metric)) {
        metrics.push(metric);
      }
    }
  }
  return [...new Set(metrics)];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildResolutionFollowup(request: HumanInterventionRequest): string {
  if (request.kind === "objective_metric_clarification" && request.inputMode === "free_text") {
    const choices = request.choices || [];
    const routeSuffix = choices.length > 0
      ? ` or choose one declared option: ${choices.map((choice) => choice.label).join("; ")}`
      : "";
    return `Please provide a metric criterion using an available metric (for example, "metric_name >= target")${routeSuffix}.`;
  }
  return buildChoiceFollowup(request);
}

function buildChoiceFollowup(request: HumanInterventionRequest): string {
  const choices = request.choices || [];
  if (choices.length === 0) {
    return "Please clarify what should happen next without changing the declared governance boundary.";
  }
  return `Which declared option do you mean: ${choices.map((choice) => choice.label).join("; ")}?`;
}

function parseModelResolution(raw: string): ModelResolution | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
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
      const parsed = JSON.parse(candidate) as ModelResolution;
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Try the next bounded representation.
    }
  }
  return undefined;
}

function sanitizeLine(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.slice(0, maxLength);
}

function throwIfAborted(abortSignal: AbortSignal | undefined): void {
  if (abortSignal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}
