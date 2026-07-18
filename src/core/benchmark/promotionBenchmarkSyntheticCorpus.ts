import path from "node:path";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import type {
  PromotionBenchmarkRecipe,
  PromotionBenchmarkRecipeCase
} from "./promotionBenchmarkBuilder.js";
import { promotionVariantDefinitions } from "./promotionBenchmarkVariants.js";

export interface GenerateSyntheticPromotionCorpusInput {
  cwd: string;
  outDir: string;
  baseBundleCount?: number;
}

export interface GenerateSyntheticPromotionCorpusResult {
  corpus_id: string;
  base_bundle_count: number;
  case_count: number;
  output_dir: string;
  recipe_path: string;
  corpus_manifest_path: string;
}

const CORPUS_ID = "promotion-governance-synthetic-development-v1";
const DEFAULT_BASE_BUNDLE_COUNT = 4;
const MAXIMUM_BASE_BUNDLE_COUNT = 1_000;

export async function generateSyntheticPromotionCorpus(
  input: GenerateSyntheticPromotionCorpusInput
): Promise<GenerateSyntheticPromotionCorpusResult> {
  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(cwd, input.outDir);
  const baseBundleCount = input.baseBundleCount ?? DEFAULT_BASE_BUNDLE_COUNT;
  if (!Number.isInteger(baseBundleCount) || baseBundleCount < 1 || baseBundleCount > MAXIMUM_BASE_BUNDLE_COUNT) {
    throw new Error(`Synthetic promotion corpus baseBundleCount must be an integer from 1 to ${MAXIMUM_BASE_BUNDLE_COUNT}.`);
  }
  const corpusId = baseBundleCount === DEFAULT_BASE_BUNDLE_COUNT
    ? CORPUS_ID
    : `${CORPUS_ID}-${baseBundleCount}-bases`;
  const variants = promotionVariantDefinitions();
  if (await pathExists(outDir)) throw new Error(`Synthetic promotion corpus output already exists: ${portableRef(cwd, outDir)}`);
  await fs.mkdir(path.dirname(outDir), { recursive: true });
  const stagingRoot = await fs.mkdtemp(path.join(path.dirname(outDir), `.${path.basename(outDir)}.tmp-`));
  try {
    const cases: PromotionBenchmarkRecipeCase[] = [];
    const deltas = [0.1, 0, -0.05, 0.02];
    for (let baseIndex = 0; baseIndex < baseBundleCount; baseIndex += 1) {
      const delta = deltas[baseIndex % deltas.length];
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
      suite_id: corpusId,
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "unverified",
      cases
    };
    await writeJsonFile(path.join(stagingRoot, "recipe.json"), recipe);
    await writeJsonFile(path.join(stagingRoot, "corpus-manifest.json"), {
      schema_version: "1.0",
      corpus_id: corpusId,
      evidence_class: "synthetic_development",
      paper_claim_eligible: false,
      adjudication_status: "unreviewed",
      mutation_isolation_status: "unreviewed",
      execution_provenance_status: "unverified",
      base_bundle_count: baseBundleCount,
      case_count: cases.length,
      clean_control_count: baseBundleCount,
      mutation_family_count: variants.filter((variant) => variant.mutation_family).length,
      use_boundary: "Development, evaluator debugging, and node-strengthening only. Not confirmatory evidence."
    });
    await fs.rename(stagingRoot, outDir);
  } catch (error) {
    await fs.rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    corpus_id: corpusId,
    base_bundle_count: baseBundleCount,
    case_count: baseBundleCount * variants.length,
    output_dir: portableRef(cwd, outDir),
    recipe_path: portableRef(cwd, path.join(outDir, "recipe.json")),
    corpus_manifest_path: portableRef(cwd, path.join(outDir, "corpus-manifest.json"))
  };
}

async function writeCleanBaseBundle(root: string, baseId: string, delta: number, baseIndex: number): Promise<void> {
  await fs.mkdir(path.join(root, "figure_audit"), { recursive: true });
  await fs.mkdir(path.join(root, "review"), { recursive: true });
  await fs.mkdir(path.join(root, "paper"), { recursive: true });
  await fs.mkdir(path.join(root, "checkpoint"), { recursive: true });
  const baseline = 0.5 + (baseIndex % 4) * 0.02;
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
      { trial_id: `trial-${baseIndex + 1}-a`, score: baseline + delta - 0.01 },
      { trial_id: `trial-${baseIndex + 1}-b`, score: baseline + delta },
      { trial_id: `trial-${baseIndex + 1}-c`, score: baseline + delta + 0.01 }
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
