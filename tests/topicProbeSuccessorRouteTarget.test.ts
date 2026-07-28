import { describe, expect, it } from "vitest";

import {
  resolveTopicProbeSuccessorTargetSelection
} from "../src/core/topicProbeSuccessorRouteTarget.js";
import type { ActiveTopicProbeContract } from "../src/core/activeTopicProbeContract.js";
import type {
  TopicPortfolio,
  TopicPortfolioCandidate
} from "../src/core/researchFunnel.js";
import type { TopicProbeOutcomeDecision } from "../src/core/topicProbeOutcome.js";

const ACTIVE_ID = "candidate_active";
const DEFERRED_ID = "candidate_deferred";
const REMAINING_ID = "candidate_remaining";

describe("topic-probe successor route target", () => {
  it.each([
    "start_confirmatory_run",
    "repeat_bounded_probe",
    "repair_probe_evidence"
  ] as const)("preserves the active candidate for %s", (nextAction) => {
    const fixture = routeFixture(nextAction);

    expect(resolveTopicProbeSuccessorTargetSelection(fixture)).toEqual({
      policy: "preserve_active_candidate",
      targetCandidate: fixture.activeCandidate,
      forbiddenCandidateIds: [],
      forbiddenTopicIds: [],
      remainingDeferredCandidateIds: [DEFERRED_ID, REMAINING_ID]
    });
  });

  it("selects the first authorized deferred candidate deterministically", () => {
    const fixture = routeFixture("try_deferred_candidate");

    expect(resolveTopicProbeSuccessorTargetSelection(fixture)).toEqual({
      policy: "select_deferred_candidate",
      targetCandidate: fixture.portfolio.candidates[1],
      forbiddenCandidateIds: [ACTIVE_ID],
      forbiddenTopicIds: [fixture.activeCandidate.topic_id],
      remainingDeferredCandidateIds: [REMAINING_ID]
    });
  });

  it("binds portfolio refresh to exclusion of the rejected candidate", () => {
    const fixture = routeFixture("refresh_topic_portfolio");

    expect(resolveTopicProbeSuccessorTargetSelection(fixture)).toEqual({
      policy: "refresh_portfolio_excluding_rejected",
      targetCandidate: null,
      forbiddenCandidateIds: [ACTIVE_ID],
      forbiddenTopicIds: [fixture.activeCandidate.topic_id],
      remainingDeferredCandidateIds: []
    });
  });

  it("fails closed when a deferred candidate is absent or unauthorized", () => {
    const missing = routeFixture("try_deferred_candidate");
    missing.contract.deferred_candidate_ids = [];
    expect(() => resolveTopicProbeSuccessorTargetSelection(missing)).toThrow(
      "topic_probe_successor_route_target_deferred_candidate_missing"
    );

    const unauthorized = routeFixture("try_deferred_candidate");
    unauthorized.portfolio.probe_candidate_ids = [ACTIVE_ID, REMAINING_ID];
    expect(() => resolveTopicProbeSuccessorTargetSelection(unauthorized)).toThrow(
      "topic_probe_successor_route_target_deferred_candidate_not_authorized"
    );
  });
});

function routeFixture(
  nextAction: TopicProbeOutcomeDecision["next_action"]
): {
  portfolio: TopicPortfolio;
  contract: ActiveTopicProbeContract;
  outcome: TopicProbeOutcomeDecision;
  activeCandidate: TopicPortfolioCandidate;
} {
  const activeCandidate = candidate(ACTIVE_ID, "a");
  const deferredCandidate = candidate(DEFERRED_ID, "b");
  const remainingCandidate = candidate(REMAINING_ID, "c");
  return {
    portfolio: {
      candidates: [activeCandidate, deferredCandidate, remainingCandidate],
      probe_candidate_ids: [ACTIVE_ID, DEFERRED_ID, REMAINING_ID]
    } as TopicPortfolio,
    contract: {
      deferred_candidate_ids: [DEFERRED_ID, REMAINING_ID]
    } as ActiveTopicProbeContract,
    outcome: { next_action: nextAction } as TopicProbeOutcomeDecision,
    activeCandidate
  };
}

function candidate(
  sourceCandidateId: string,
  hashPrefix: string
): TopicPortfolioCandidate {
  return {
    topic_id: `topic_${hashPrefix}`,
    source_candidate_id: sourceCandidateId,
    content_sha256: hashPrefix.repeat(64),
    probe_eligible: true
  } as TopicPortfolioCandidate;
}
