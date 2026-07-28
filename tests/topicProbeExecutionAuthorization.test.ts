import { describe, expect, it } from "vitest";

import {
  composeTopicProbeExecutionAuthorization,
  type TopicProbeExecutionAuthorizationInput
} from "../src/core/topicProbeExecutionAuthorization.js";

describe("topic probe execution authorization", () => {
  it("authorizes only when every selected candidate is covered by a valid direct-prior receipt", () => {
    const input = passingInput();

    expect(composeTopicProbeExecutionAuthorization(input)).toEqual({
      status: "authorized",
      trusted: true,
      authorized: true,
      base_funnel_authorized: true,
      candidate_prior_search_authorized: true,
      estimator_authorized: true,
      required_candidate_ids: ["candidate_primary"],
      covered_candidate_ids: ["candidate_primary"],
      reason_codes: []
    });
  });

  it("blocks a valid receipt that belongs to a different candidate", () => {
    const input = passingInput();
    input.candidatePriorSearch.coveredCandidateIds = ["candidate_other"];

    expect(composeTopicProbeExecutionAuthorization(input)).toMatchObject({
      status: "blocked",
      trusted: true,
      authorized: false,
      candidate_prior_search_authorized: false,
      reason_codes: [
        "effective_execution_candidate_prior_search_coverage_missing:candidate_primary"
      ]
    });
  });

  it("keeps unmeasured direct-prior search and estimator preflight pending", () => {
    const input = passingInput();
    input.candidatePriorSearch = {
      status: "unmeasured",
      trusted: false,
      currentReceiptStatus: "unmeasured",
      coveredCandidateIds: []
    };
    input.estimator = {
      status: "unmeasured",
      trusted: false,
      executionAuthorized: false
    };

    const result = composeTopicProbeExecutionAuthorization(input);
    expect(result).toMatchObject({
      status: "pending",
      trusted: false,
      authorized: false
    });
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "effective_execution_candidate_prior_search_unmeasured",
      "effective_execution_estimator_unmeasured"
    ]));
  });

  it("blocks a trusted estimator rejection and a non-promoted executable contract", () => {
    const input = passingInput();
    input.estimator = {
      status: "blocked",
      trusted: true,
      executionAuthorized: false
    };

    const result = composeTopicProbeExecutionAuthorization(input);
    expect(result).toMatchObject({
      status: "blocked",
      trusted: true,
      authorized: false,
      estimator_authorized: false
    });
    expect(result.reason_codes).toEqual(expect.arrayContaining([
      "effective_execution_estimator_not_passed:blocked",
      "effective_execution_executable_contract_not_promoted"
    ]));
  });

  it("treats a hash-untrusted component as an invalid authorization chain", () => {
    const input = passingInput();
    input.candidatePriorSearch.trusted = false;

    expect(composeTopicProbeExecutionAuthorization(input)).toMatchObject({
      status: "invalid",
      trusted: false,
      authorized: false,
      candidate_prior_search_authorized: false
    });
  });
});

function passingInput(): TopicProbeExecutionAuthorizationInput {
  return {
    baseFunnel: {
      measured: true,
      trusted: true,
      authorized: true
    },
    candidatePriorSearch: {
      status: "complete",
      trusted: true,
      action: "already_searched",
      currentReceiptStatus: "valid",
      coveredCandidateIds: ["candidate_primary"]
    },
    estimator: {
      status: "pass",
      trusted: true,
      executionAuthorized: true
    },
    requiredCandidateIds: ["candidate_primary"]
  };
}
