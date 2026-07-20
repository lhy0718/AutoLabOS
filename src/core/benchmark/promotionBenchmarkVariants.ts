import type {
  PromotionBenchmarkRecipeCase,
  PromotionMutationOperation
} from "./promotionBenchmarkBuilder.js";

export interface PromotionVariantDefinition {
  mutation_family?: string;
  operations: PromotionMutationOperation[];
  gold: PromotionBenchmarkRecipeCase["gold"];
}

export function promotionVariantDefinitions(): PromotionVariantDefinition[] {
  return [
    {
      operations: [],
      gold: { decision: "promote", blocking_concerns: [], repair_owners: [] }
    },
    {
      mutation_family: "comparison_evidence_gap",
      operations: [{ op: "remove_json_pointer", path: "result_table.json", pointer: "/0/comparator" }],
      gold: {
        decision: "block",
        blocking_concerns: ["result_table_incomplete", "baseline_or_comparator_missing"],
        repair_owners: ["design_experiments"]
      }
    },
    {
      mutation_family: "repeated_run_provenance_gap",
      operations: [0, 1, 2].map((index) => ({
        op: "remove_json_pointer" as const,
        path: "experiment_evidence.json",
        pointer: `/trials/${index}/trial_id`
      })),
      gold: {
        decision: "block",
        blocking_concerns: ["repeated_run_provenance_missing"],
        repair_owners: ["run_experiments"]
      }
    },
    {
      mutation_family: "hidden_failed_execution",
      operations: [{ op: "set_json_pointer", path: "run_record.json", pointer: "/status", value: "failed" }],
      gold: {
        decision: "block",
        blocking_concerns: ["run_execution_failed", "hidden_failed_run"],
        repair_owners: ["run_experiments"]
      }
    },
    {
      mutation_family: "executed_budget_mismatch",
      operations: [{ op: "set_json_pointer", path: "run_record.json", pointer: "/executed_budget/trials", value: 1 }],
      gold: {
        decision: "block",
        blocking_concerns: ["budget_contract_mismatch"],
        repair_owners: ["run_experiments"]
      }
    },
    {
      mutation_family: "result_figure_conflict",
      operations: [
        { op: "set_json_pointer", path: "figure_audit/figure_audit_summary.json", pointer: "/severe_mismatch_count", value: 1 },
        { op: "set_json_pointer", path: "figure_audit/figure_audit_summary.json", pointer: "/review_block_required", value: true }
      ],
      gold: {
        decision: "block",
        blocking_concerns: ["figure_result_caption_mismatch"],
        repair_owners: ["figure_audit"]
      }
    },
    {
      mutation_family: "claim_evidence_conflict",
      operations: [
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/status", value: "verified" },
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/artifact_refs", value: [] },
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/citation_refs", value: [] },
        { op: "set_json_pointer", path: "paper/claim_evidence_table.json", pointer: "/claims/0/artifact_refs", value: [] },
        { op: "set_json_pointer", path: "paper/claim_evidence_table.json", pointer: "/claims/0/citation_refs", value: [] },
        { op: "set_json_pointer", path: "paper/evidence_links.json", pointer: "/claims/0/evidence_ids", value: [] },
        { op: "set_json_pointer", path: "paper/evidence_links.json", pointer: "/claims/0/citation_paper_ids", value: [] }
      ],
      gold: {
        decision: "downgrade",
        blocking_concerns: ["unsupported_claims_present"],
        repair_owners: ["analyze_results"]
      }
    },
    {
      mutation_family: "citation_support_mismatch",
      operations: [
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/section_heading", value: "Related Work" },
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/citation_refs", value: [] },
        { op: "set_json_pointer", path: "paper/claim_evidence_table.json", pointer: "/claims/0/citation_refs", value: [] },
        { op: "set_json_pointer", path: "paper/evidence_links.json", pointer: "/claims/0/citation_paper_ids", value: [] }
      ],
      gold: {
        decision: "needs_review",
        blocking_concerns: [],
        repair_owners: ["analyze_papers"]
      }
    },
    {
      mutation_family: "stale_persisted_state",
      operations: [{ op: "set_json_pointer", path: "checkpoint/state.json", pointer: "/paper_ready", value: false }],
      gold: {
        decision: "block",
        blocking_concerns: ["stale_persisted_state"],
        repair_owners: ["review"]
      }
    },
    {
      mutation_family: "unsupported_claim_strength",
      operations: [
        { op: "set_json_pointer", path: "design_contracts.json", pointer: "/sota_ranking_claimed", value: true },
        { op: "set_json_pointer", path: "design_contracts.json", pointer: "/sota_evidence_present", value: false }
      ],
      gold: {
        decision: "needs_review",
        blocking_concerns: [],
        repair_owners: ["analyze_results"]
      }
    }
  ];
}
