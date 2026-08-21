export type TopicProbeExecutionAuthorizationStatus =
  | "unmeasured"
  | "pending"
  | "authorized"
  | "blocked"
  | "invalid";

export interface TopicProbeExecutionAuthorization {
  status: TopicProbeExecutionAuthorizationStatus;
  trusted: boolean;
  authorized: boolean;
  base_funnel_authorized: boolean;
  candidate_prior_search_authorized: boolean;
  estimator_authorized: boolean;
  required_candidate_ids: string[];
  covered_candidate_ids: string[];
  reason_codes: string[];
}

export interface TopicProbeExecutionAuthorizationInput {
  baseFunnel: {
    measured: boolean;
    trusted: boolean;
    authorized: boolean;
  };
  candidatePriorSearch: {
    status: "unmeasured" | "search_required" | "complete" | "exhausted" | "blocked";
    trusted: boolean;
    action?:
      | "request_collection"
      | "already_searched"
      | "exhausted"
      | "not_required"
      | "blocked_invalid_lineage";
    currentReceiptStatus: "unmeasured" | "not_applicable" | "valid" | "invalid";
    coveredCandidateIds: string[];
  };
  estimator: {
    status: "unmeasured" | "pass" | "blocked" | "invalid";
    trusted: boolean;
    executionAuthorized: boolean;
  };
  requiredCandidateIds: string[];
}

export function composeTopicProbeExecutionAuthorization(
  input: TopicProbeExecutionAuthorizationInput
): TopicProbeExecutionAuthorization {
  const requiredCandidateIds = uniqueStrings(input.requiredCandidateIds);
  const coveredCandidateIds = uniqueStrings(input.candidatePriorSearch.coveredCandidateIds);
  const coveredSet = new Set(coveredCandidateIds);
  const missingCandidateIds = requiredCandidateIds.filter(
    (candidateId) => !coveredSet.has(candidateId)
  );
  const baseFunnelAuthorized = input.baseFunnel.trusted && input.baseFunnel.authorized;
  const candidatePriorSearchAuthorized = Boolean(
    requiredCandidateIds.length > 0
    && input.candidatePriorSearch.status === "complete"
    && input.candidatePriorSearch.trusted
    && input.candidatePriorSearch.action === "already_searched"
    && input.candidatePriorSearch.currentReceiptStatus === "valid"
    && missingCandidateIds.length === 0
  );
  const estimatorAuthorized = Boolean(
    input.estimator.status === "pass"
    && input.estimator.trusted
    && input.estimator.executionAuthorized
  );
  const authorized = Boolean(
    baseFunnelAuthorized
    && candidatePriorSearchAuthorized
    && estimatorAuthorized
  );
  const reasons: string[] = [];

  if (!input.baseFunnel.measured) {
    reasons.push("effective_execution_base_funnel_unmeasured");
  } else if (!input.baseFunnel.trusted) {
    reasons.push("effective_execution_base_funnel_untrusted");
  } else if (!input.baseFunnel.authorized) {
    reasons.push("effective_execution_base_funnel_not_authorized");
  }

  if (requiredCandidateIds.length === 0) {
    reasons.push("effective_execution_selected_candidate_missing");
  }
  if (input.candidatePriorSearch.status === "unmeasured") {
    reasons.push("effective_execution_candidate_prior_search_unmeasured");
  } else {
    if (!input.candidatePriorSearch.trusted) {
      reasons.push("effective_execution_candidate_prior_search_untrusted");
    }
    if (input.candidatePriorSearch.status !== "complete") {
      reasons.push(
        `effective_execution_candidate_prior_search_not_complete:${input.candidatePriorSearch.status}`
      );
    }
    if (input.candidatePriorSearch.action !== "already_searched") {
      reasons.push(
        `effective_execution_candidate_prior_search_action_invalid:${input.candidatePriorSearch.action || "unmeasured"}`
      );
    }
    if (input.candidatePriorSearch.currentReceiptStatus !== "valid") {
      reasons.push(
        `effective_execution_candidate_prior_search_receipt_invalid:${input.candidatePriorSearch.currentReceiptStatus}`
      );
    }
  }
  if (missingCandidateIds.length > 0) {
    reasons.push(
      `effective_execution_candidate_prior_search_coverage_missing:${missingCandidateIds.join(",")}`
    );
  }

  if (input.estimator.status === "unmeasured") {
    reasons.push("effective_execution_estimator_unmeasured");
  } else {
    if (!input.estimator.trusted) {
      reasons.push("effective_execution_estimator_untrusted");
    }
    if (input.estimator.status !== "pass") {
      reasons.push(`effective_execution_estimator_not_passed:${input.estimator.status}`);
    }
    if (!input.estimator.executionAuthorized) {
      reasons.push("effective_execution_executable_contract_not_promoted");
    }
  }

  const hasInvalidComponent = Boolean(
    (input.baseFunnel.measured && !input.baseFunnel.trusted)
    || (
      input.candidatePriorSearch.status !== "unmeasured"
      && !input.candidatePriorSearch.trusted
    )
    || input.estimator.status === "invalid"
    || (input.estimator.status !== "unmeasured" && !input.estimator.trusted)
  );
  const hasPendingComponent = Boolean(
    !input.baseFunnel.measured
    || input.candidatePriorSearch.status === "unmeasured"
    || input.candidatePriorSearch.status === "search_required"
    || input.estimator.status === "unmeasured"
  );
  const status: TopicProbeExecutionAuthorizationStatus = authorized
    ? "authorized"
    : hasInvalidComponent
      ? "invalid"
      : hasPendingComponent
        ? input.baseFunnel.measured ? "pending" : "unmeasured"
        : "blocked";

  return {
    status,
    trusted: Boolean(
      input.baseFunnel.trusted
      && input.candidatePriorSearch.trusted
      && input.estimator.trusted
    ),
    authorized,
    base_funnel_authorized: baseFunnelAuthorized,
    candidate_prior_search_authorized: candidatePriorSearchAuthorized,
    estimator_authorized: estimatorAuthorized,
    required_candidate_ids: requiredCandidateIds,
    covered_candidate_ids: coveredCandidateIds,
    reason_codes: uniqueStrings(reasons)
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort(
    (left, right) => left.localeCompare(right)
  );
}
