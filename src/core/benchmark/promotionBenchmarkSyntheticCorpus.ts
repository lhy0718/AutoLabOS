import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import type {
  PromotionBenchmarkRecipe,
  PromotionBenchmarkRecipeCase,
  PromotionMutationOperation
} from "./promotionBenchmarkBuilder.js";

export interface GenerateSyntheticPromotionCorpusInput {
  cwd: string;
  outDir: string;
}

export interface GenerateSyntheticPromotionCorpusResult {
  corpus_id: string;
  base_bundle_count: number;
  case_count: number;
  output_dir: string;
  recipe_path: string;
  corpus_manifest_path: string;
}

interface VariantDefinition {
  mutation_family?: string;
  operations: PromotionMutationOperation[];
  gold: PromotionBenchmarkRecipeCase["gold"];
}

const CORPUS_ID = "promotion-governance-synthetic-development-v1";

export async function generateSyntheticPromotionCorpus(
  input: GenerateSyntheticPromotionCorpusInput
): Promise<GenerateSyntheticPromotionCorpusResult> {
  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(cwd, input.outDir);
  if (await pathExists(outDir)) throw new Error(`Synthetic promotion corpus output already exists: ${portableRef(cwd, outDir)}`);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const cases: PromotionBenchmarkRecipeCase[] = [];
    const variants = variantDefinitions();
    const deltas = [0.1, 0, -0.05, 0.02];
    for (const [baseIndex, delta] of deltas.entries()) {
      const baseId = `base-development-${baseIndex + 1}`;
      const sourceRoot = path.join(stagingRoot, "base-bundles", baseId);
      await writeCleanBaseBundle(sourceRoot, baseId, delta, baseIndex);
      for (const [variantIndex, variant] of variants.entries()) {
        cases.push({
          case_id: `development-${baseIndex + 1}-${variantIndex + 1}`,
          base_bundle_id: baseId,
          split: "development",
          source_root: `base-bundles/${baseId}`,
          ...(variant.mutation_family ? { mutation_family: variant.mutation_family } : {}),
          operations: variant.operations,
          gold: variant.gold
        });
      }
    }
    const recipe: PromotionBenchmarkRecipe = {
      schema_version: "1.0",
      suite_id: CORPUS_ID,
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      cases
    };
    await writeJsonFile(path.join(stagingRoot, "recipe.json"), recipe);
    await writeJsonFile(path.join(stagingRoot, "corpus-manifest.json"), {
      schema_version: "1.0",
      corpus_id: CORPUS_ID,
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      base_bundle_count: deltas.length,
      case_count: cases.length,
      clean_control_count: deltas.length,
      mutation_family_count: variants.filter((variant) => variant.mutation_family).length,
      use_boundary: "Development, evaluator debugging, and node-strengthening only. Not confirmatory evidence."
    });
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    corpus_id: CORPUS_ID,
    base_bundle_count: 4,
    case_count: 40,
    output_dir: portableRef(cwd, outDir),
    recipe_path: portableRef(cwd, path.join(outDir, "recipe.json")),
    corpus_manifest_path: portableRef(cwd, path.join(outDir, "corpus-manifest.json"))
  };
}

function variantDefinitions(): VariantDefinition[] {
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
        pointer: `/trials/${index}/seed`
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
        { op: "set_json_pointer", path: "paper/claim_status_table.json", pointer: "/claims/0/status", value: "blocked" },
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

async function writeCleanBaseBundle(root: string, baseId: string, delta: number, baseIndex: number): Promise<void> {
  await fs.mkdir(path.join(root, "figure_audit"), { recursive: true });
  await fs.mkdir(path.join(root, "review"), { recursive: true });
  await fs.mkdir(path.join(root, "paper"), { recursive: true });
  await fs.mkdir(path.join(root, "checkpoint"), { recursive: true });
  const baseline = 0.5 + baseIndex * 0.02;
  await writeJsonFile(path.join(root, "result_table.json"), [
    {
      metric: `primary_score_${baseIndex + 1}`,
      baseline,
      comparator: baseline + delta,
      delta,
      direction: "higher_better"
    }
  ]);
  await fs.writeFile(
    path.join(root, "evidence_store.jsonl"),
    `${JSON.stringify({ id: `evidence-${baseIndex + 1}`, metric: `primary_score_${baseIndex + 1}`, metric_evidence_present: true })}\n`,
    "utf8"
  );
  await writeJsonFile(path.join(root, "experiment_evidence.json"), {
    trials: [
      { seed: 101 + baseIndex, score: baseline + delta - 0.01 },
      { seed: 211 + baseIndex, score: baseline + delta },
      { seed: 307 + baseIndex, score: baseline + delta + 0.01 }
    ]
  });
  await writeJsonFile(path.join(root, "run_config.json"), { planned_budget: { trials: 3 } });
  await writeJsonFile(path.join(root, "run_record.json"), {
    id: baseId,
    status: "completed",
    executed_budget: { trials: 3 }
  });
  await writeJsonFile(path.join(root, "checkpoint", "state.json"), { paper_ready: true, run_status: "completed" });
  await writeJsonFile(path.join(root, "design_contracts.json"), {
    sota_ranking_claimed: false,
    sota_evidence_present: false
  });
  await writeJsonFile(path.join(root, "figure_audit", "figure_audit_summary.json"), {
    audited_at: "2026-07-16T00:00:00.000Z",
    figure_count: 1,
    issues: [],
    severe_mismatch_count: 0,
    review_block_required: false
  });
  await writeJsonFile(path.join(root, "review", "paper_critique.json"), {
    paper_readiness_state: "paper_ready",
    claim_ceiling_applied: true
  });
  await writeJsonFile(path.join(root, "review", "decision.json"), { outcome: "accept" });
  await fs.writeFile(
    path.join(root, "paper", "main.tex"),
    `\\section{Results}\nThe measured comparison for record ${baseIndex + 1} is reported without a superiority claim.\n`,
    "utf8"
  );
  await writeJsonFile(path.join(root, "paper", "paper_readiness.json"), {
    paper_ready: true,
    readiness_state: "paper_ready"
  });
  const claim = {
    claim_id: "claim-primary",
    statement: "The measured comparison is reported.",
    section_heading: "Results",
    status: "verified",
    artifact_refs: ["result_table.json"],
    citation_refs: ["source-primary"],
    reproduction_trace_present: true
  };
  await writeJsonFile(path.join(root, "paper", "claim_evidence_table.json"), {
    claims: [{
      claim_id: claim.claim_id,
      statement: claim.statement,
      section_heading: claim.section_heading,
      artifact_refs: claim.artifact_refs,
      citation_refs: claim.citation_refs,
      strength: "measured"
    }]
  });
  await writeJsonFile(path.join(root, "paper", "claim_status_table.json"), { claims: [claim] });
  await writeJsonFile(path.join(root, "paper", "evidence_links.json"), {
    claims: [{ claim_id: claim.claim_id, evidence_ids: ["evidence-primary"], citation_paper_ids: ["source-primary"] }]
  });
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
