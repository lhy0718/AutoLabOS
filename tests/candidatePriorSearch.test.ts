import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HypothesisCandidate } from "../src/core/analysis/researchPlanning.js";
import {
  buildCandidatePriorSearchPlan,
  buildCandidatePriorSearchReceipt,
  validateCandidatePriorSearchPlanIntegrity,
  validateCandidatePriorSearchReceipt,
  validateCandidatePriorSearchPlan,
  type CandidatePriorSearchCandidateInput,
  type CandidatePriorSearchPlanInput
} from "../src/core/candidatePriorSearch.js";
import { hashCanonical } from "../src/core/canonicalHash.js";
import type { PriorAbsorptionCandidateContract } from "../src/core/priorAbsorption.js";

const SOURCE_CORPUS_RAW = `${JSON.stringify({
  paper_id: "paper_source",
  title: "Source reference",
  query_families: ["family_original"]
})}\n`;

describe("candidate-conditioned direct-prior search planning", () => {
  it("builds a deterministic, versioned, hash-bound plan", () => {
    const input = planInput([
      candidateInput("candidate_beta", "archival records", "causal tracing"),
      candidateInput("candidate_alpha", "technical reports", "typed provenance")
    ]);

    const first = buildCandidatePriorSearchPlan(input);
    const second = buildCandidatePriorSearchPlan({
      ...input,
      candidates: [...input.candidates].reverse()
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema_version: 1,
      artifact_kind: "candidate_prior_search_plan",
      run_id: "run_fixture",
      research_cycle: 4,
      generated_at: "2026-07-28T08:30:00.000Z",
      as_of_date: "2026-07-28"
    });
    expect(first.source_corpus).toEqual({
      collect_attempt_id: "collect_fixture",
      sha256: createHash("sha256")
        .update(SOURCE_CORPUS_RAW, "utf8")
        .digest("hex"),
      byte_length: Buffer.byteLength(SOURCE_CORPUS_RAW, "utf8")
    });
    expect(first.candidates.map((item) => item.candidate_id)).toEqual([
      "candidate_alpha",
      "candidate_beta"
    ]);
    expect(first.candidates.every((item) => item.families.length === 3)).toBe(true);
    const { content_sha256: _contentSha256, ...payload } = first;
    expect(first.content_sha256).toBe(hashCanonical(payload));
    expect(validateCandidatePriorSearchPlan(first, input)).toMatchObject({
      valid: true,
      reasons: []
    });
  });

  it("binds every planned lane and selected paper to a tamper-evident corpus receipt", () => {
    const input = planInput([
      candidateInput("candidate_receipt", "structured records", "contract tracing")
    ]);
    const plan = buildCandidatePriorSearchPlan(input);
    const rows = plan.candidates[0].families.map((family, index) => ({
      paper_id: `paper_${index + 1}`,
      title: `Reference ${index + 1}`,
      query_families: [family.family_id]
    }));
    const corpusRaw = `${SOURCE_CORPUS_RAW}${rows
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`;
    const attempts = plan.candidates[0].families.flatMap((family, index) =>
      family.lanes.map((lane) => ({
        familyId: family.family_id,
        retrievalLane: lane.retrieval_lane,
        query: family.query,
        fetched: 4,
        selected: lane.retrieval_lane === "broad_relevance" ? 1 : 0,
        selectedPaperIds:
          lane.retrieval_lane === "broad_relevance" ? [`paper_${index + 1}`] : []
      }))
    );
    const receipt = buildCandidatePriorSearchReceipt({
      plan,
      collectAttemptId: "collect_augmentation",
      generatedAt: "2026-07-28T09:00:00Z",
      resultCorpusSha256: createHash("sha256")
        .update(corpusRaw, "utf8")
        .digest("hex"),
      resultCorpusByteLength: Buffer.byteLength(corpusRaw, "utf8"),
      attempts
    });

    expect(validateCandidatePriorSearchPlanIntegrity(plan)).toMatchObject({
      valid: true,
      reasons: []
    });
    expect(validateCandidatePriorSearchReceipt(receipt, {
      plan,
      expectedCollectAttemptId: "collect_augmentation",
      sourceCorpusRaw: SOURCE_CORPUS_RAW,
      resultCorpusRaw: corpusRaw
    })).toMatchObject({ valid: true, reasons: [] });

    const tampered = structuredClone(receipt);
    tampered.result_corpus.byte_length += 1;
    expect(validateCandidatePriorSearchReceipt(tampered, {
      plan,
      expectedCollectAttemptId: "collect_augmentation",
      sourceCorpusRaw: SOURCE_CORPUS_RAW,
      resultCorpusRaw: corpusRaw
    }).reasons).toEqual(expect.arrayContaining([
      "candidate_prior_search_receipt_content_hash_mismatch",
      "candidate_prior_search_receipt_result_corpus_mismatch"
    ]));
  });

  it("invalidates changed contracts and rejects an invalid supplied contract hash", () => {
    const input = planInput([
      candidateInput("candidate_primary", "document collections", "constraint tracing")
    ]);
    const plan = buildCandidatePriorSearchPlan(input);
    const changed = structuredClone(input);
    changed.candidates[0].candidateContract = contract({
      contribution_object: "document collections",
      method_mechanism: "dependency tracing",
      data_task_scope: "held out document collections",
      evaluation_protocol: "paired validation under declared error criteria",
      claim_ceiling: "bounded improvement in supported findings",
      falsifier: "no measurable change in unsupported findings",
      comparator: "post hoc verification"
    });

    expect(validateCandidatePriorSearchPlan(plan, changed)).toMatchObject({
      valid: false,
      reasons: ["candidate_prior_search_plan_recomputed_mismatch"]
    });

    const invalid = structuredClone(input);
    invalid.candidates[0].candidateContract.content_sha256 = "0".repeat(64);
    expect(() => buildCandidatePriorSearchPlan(invalid)).toThrow(
      "candidate_prior_search_contract_hash_mismatch"
    );
  });

  it("fails closed for duplicate, empty, and malformed candidates", () => {
    const duplicate = candidateInput(
      "candidate_repeated",
      "structured archives",
      "lineage checking"
    );
    expect(() =>
      buildCandidatePriorSearchPlan(planInput([duplicate, structuredClone(duplicate)]))
    ).toThrow("candidate_prior_search_candidate_duplicate");

    expect(() =>
      buildCandidatePriorSearchPlan(planInput([]))
    ).toThrow("candidate_prior_search_candidates_empty");

    const malformed = candidateInput(
      "candidate_malformed",
      "structured archives",
      "lineage checking"
    );
    malformed.candidate.text = " ";
    expect(() =>
      buildCandidatePriorSearchPlan(planInput([malformed]))
    ).toThrow("candidate_prior_search_text_empty:candidate_text");
  });

  it("derives both retrieval lanes and the recent window only from asOfDate", () => {
    const input = planInput([
      candidateInput("candidate_window", "research artifacts", "relation auditing")
    ]);
    input.asOfDate = "2031-03-14T23:59:00-05:00";
    const plan = buildCandidatePriorSearchPlan(input);

    expect(plan.as_of_date).toBe("2031-03-15");
    expect(plan.recent_window).toEqual({
      policy: "previous_calendar_year_start",
      start_date: "2030-01-01",
      end_date: "2031-03-15"
    });
    for (const family of plan.candidates[0].families) {
      expect(family.lanes).toEqual([
        {
          retrieval_lane: "broad_relevance",
          sort: { field: "relevance", order: "desc" },
          publication_date_range: null
        },
        {
          retrieval_lane: "recent_direct_prior",
          sort: { field: "publicationDate", order: "desc" },
          publication_date_range: {
            start_date: "2030-01-01",
            end_date: "2031-03-15"
          }
        }
      ]);
    }
  });

  it("keeps the core-question family object-free and caps public query text", () => {
    const input = planInput([
      candidateInput(
        "candidate_neutral",
        "versioned evidence bundles",
        "contract lineage validation with deterministic reconciliation"
      )
    ]);
    const plan = buildCandidatePriorSearchPlan(input);
    const families = plan.candidates[0].families;
    const coreFamily = families.find(
      (family) =>
        family.query_intent === "object_free_core_question_evaluation_protocol"
    );

    expect(coreFamily).toBeDefined();
    expect(coreFamily?.query).not.toContain("evidence");
    expect(coreFamily?.query).not.toContain("bundle");
    expect(
      families.every(
        (family) =>
          family.query.length <= 240
          && [...family.anchor_terms, ...family.axis_terms]
            .every((term) => term.length <= 36)
      )
    ).toBe(true);
  });

  it("contains no local path or reusable numeric-condition identifiers", () => {
    const moduleText = readFileSync(
      fileURLToPath(new URL("../src/core/candidatePriorSearch.ts", import.meta.url)),
      "utf8"
    );
    const planText = JSON.stringify(
      buildCandidatePriorSearchPlan(planInput([
        candidateInput("candidate_public", "evidence graphs", "invariant checking")
      ]))
    );
    const prohibitedPatterns = [
      /(?:^|[\\/])home[\\/][^/\\]+/iu,
      /\b(?:rank|dropout)[_-]?\d+(?:[_-]\d+)*\b/iu,
      /\b(?:model|dataset|benchmark)[_-]\d+(?:[_-]\d+)*\b/iu,
      /https?:\/\//iu
    ];

    for (const pattern of prohibitedPatterns) {
      expect(moduleText).not.toMatch(pattern);
      expect(planText).not.toMatch(pattern);
    }
  });
});

function planInput(
  candidates: CandidatePriorSearchCandidateInput[]
): CandidatePriorSearchPlanInput {
  return {
    runId: "run_fixture",
    researchCycle: 4,
    generatedAt: "2026-07-28T08:30:00Z",
    asOfDate: "2026-07-28",
    sourceCorpus: {
      collect_attempt_id: "collect_fixture",
      sha256: createHash("sha256")
        .update(SOURCE_CORPUS_RAW, "utf8")
        .digest("hex"),
      byte_length: Buffer.byteLength(SOURCE_CORPUS_RAW, "utf8")
    },
    candidates
  };
}

function candidateInput(
  id: string,
  contributionObject: string,
  mechanism: string
): CandidatePriorSearchCandidateInput {
  return {
    candidate: {
      id,
      text: `${mechanism} tests a falsifiable relation over ${contributionObject}.`,
      novelty: 0.7,
      feasibility: 0.8,
      testability: 0.9,
      cost: 0.3,
      expected_gain: 0.2,
      evidence_links: ["evidence_reference"],
      contribution_claim: `Improved support for findings over ${contributionObject}.`,
      primary_metric: "supported finding rate",
      meaningful_effect: "a prespecified reduction in unsupported findings"
    } satisfies HypothesisCandidate,
    candidateContract: contract({
      contribution_object: contributionObject,
      method_mechanism: mechanism,
      data_task_scope: `held out ${contributionObject}`,
      evaluation_protocol: "paired validation with cluster aware uncertainty",
      claim_ceiling: "bounded improvement in supported findings",
      falsifier: "no measurable change in unsupported findings",
      comparator: "post hoc verification"
    })
  };
}

function contract(
  payload: Omit<PriorAbsorptionCandidateContract, "content_sha256">
): PriorAbsorptionCandidateContract {
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}
