import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SECTION_PATTERN = /:(explanation|claim|modified_text|original_text):\s*(.*?)(?=\n:\w+:|$)/gsu;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonical(value) {
  return sha256(canonicalJson(value));
}

export function parseInsertedError(raw) {
  const sections = {
    original_text: [],
    modified_text: [],
    explanation: [],
    claim: [],
  };
  for (const match of raw.matchAll(SECTION_PATTERN)) {
    sections[match[1]].push(match[2].trim());
  }
  return sections;
}

export function parseLocatedErrors(raw) {
  return raw.split("error:").slice(1).map((value) => value.trim()).filter(Boolean);
}

export function parseIdentifiedErrors(raw) {
  return raw.split("error_text:").slice(1).map((value) => value.trim()).filter(Boolean);
}

export function parsePublishedScore(raw, topK = 10, threshold = 0.5) {
  const forward = parseScoreArray(raw, "subsets of ground vs pred").slice(0, topK);
  const reverse = parseScoreArray(raw, "subsets of pred vs ground").slice(0, topK);
  const maximum = Math.max(0, ...forward, ...reverse);
  return {
    forward,
    reverse,
    maximum,
    identified: maximum >= threshold,
  };
}

export function parsePublishedJudgeDecision(raw, topK = 10) {
  const token = "CORRECTLY IDENTIFIED";
  const parts = raw.split(token);
  const retained = [
    ...parts.slice(0, Math.min(topK, parts.length - 1)),
    parts.at(-1) ?? "",
  ].join(token);
  return /(?<!IN)CORRECTLY IDENTIFIED/u.test(retained);
}

export function parseStructuredJudgeVerdicts(raw, topK = 10) {
  return [...raw.matchAll(/\b(INCORRECTLY|CORRECTLY) IDENTIFIED\b/gu)]
    .slice(0, topK)
    .map((match) => match[1] === "CORRECTLY");
}

export function normalizeComparableText(text) {
  return String(text)
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function groundTruthContextProfile(originalTexts, modifiedTexts) {
  const pairCount = Math.min(originalTexts.length, modifiedTexts.length);
  let modifiedWordCount = 0;
  let unchangedModifiedWordCount = 0;
  let changedModifiedSentenceCount = 0;
  for (let index = 0; index < pairCount; index += 1) {
    const originalSentences = new Set(
      splitSentences(originalTexts[index]).map(normalizeComparableText),
    );
    for (const sentence of splitSentences(modifiedTexts[index])) {
      const normalized = normalizeComparableText(sentence);
      const wordCount = countWords(sentence);
      modifiedWordCount += wordCount;
      if (originalSentences.has(normalized)) {
        unchangedModifiedWordCount += wordCount;
      } else {
        changedModifiedSentenceCount += 1;
      }
    }
  }
  return {
    pair_count: pairCount,
    modified_word_count: modifiedWordCount,
    unchanged_modified_word_count: unchangedModifiedWordCount,
    unchanged_modified_word_ratio:
      modifiedWordCount > 0 ? unchangedModifiedWordCount / modifiedWordCount : null,
    changed_modified_sentence_count: changedModifiedSentenceCount,
  };
}

export function auditCorpus({ config, corpusRoot }) {
  validateConfig(config);
  const missingArtifacts = [];
  const paperIds = new Set();
  const paperBundleCounts = new Map();
  const contextProfiles = [];
  const bundleSummaries = [];
  const evaluatorCells = [];

  for (const bundle of config.bundles) {
    const bundleRoot = join(corpusRoot, bundle.root_directory);
    const metadataPath = join(bundleRoot, bundle.metadata_file);
    if (!existsSync(metadataPath)) {
      missingArtifacts.push(`${bundle.bundle_id}/${bundle.metadata_file}`);
      bundleSummaries.push({
        bundle_id: bundle.bundle_id,
        expected_instance_count: bundle.expected_instance_count,
        observed_instance_count: 0,
      });
      continue;
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
      throw new Error(`${bundle.bundle_id} metadata must be an object`);
    }
    const entries = Object.entries(metadata);
    bundleSummaries.push({
      bundle_id: bundle.bundle_id,
      expected_instance_count: bundle.expected_instance_count,
      observed_instance_count: entries.length,
    });

    for (const [paperId, claimIndexValue] of entries) {
      const claimIndex = String(claimIndexValue);
      paperIds.add(paperId);
      paperBundleCounts.set(paperId, (paperBundleCounts.get(paperId) ?? 0) + 1);
      const instanceStem = `${paperId}_${claimIndex}_${bundle.insertion_model}`;
      const insertedPath = join(bundleRoot, "inserted_error", `${instanceStem}.txt`);
      const locationPath = join(bundleRoot, "location_error", `${instanceStem}.txt`);
      if (!existsSync(insertedPath)) {
        missingArtifacts.push(`${bundle.bundle_id}/inserted_error/${instanceStem}.txt`);
      }
      if (!existsSync(locationPath)) {
        missingArtifacts.push(`${bundle.bundle_id}/location_error/${instanceStem}.txt`);
      }
      if (existsSync(insertedPath)) {
        const inserted = parseInsertedError(readFileSync(insertedPath, "utf8"));
        contextProfiles.push({
          bundle_id: bundle.bundle_id,
          paper_id: paperId,
          claim_index: claimIndex,
          ...groundTruthContextProfile(inserted.original_text, inserted.modified_text),
        });
      }

      for (const model of config.identification_models) {
        const predictionStem = `${paperId}_${claimIndex}_${model}`;
        const paths = {
          prediction: join(bundleRoot, "evaluation_errors", `${predictionStem}.txt`),
          score: join(bundleRoot, "evaluation_errors", `${predictionStem}_score.txt`),
          comparison: join(bundleRoot, "evaluation_errors", `${predictionStem}_comparison.txt`),
        };
        const missing = Object.entries(paths)
          .filter(([, artifactPath]) => !existsSync(artifactPath))
          .map(([kind]) => kind);
        for (const kind of missing) {
          missingArtifacts.push(
            `${bundle.bundle_id}/evaluation_errors/${predictionStem}:${kind}`,
          );
        }
        if (missing.length > 0) continue;
        const score = parsePublishedScore(
          readFileSync(paths.score, "utf8"),
          config.published_evaluation.top_k,
          config.published_evaluation.lexical_threshold,
        );
        const comparisonRaw = readFileSync(paths.comparison, "utf8");
        const publishedJudge = parsePublishedJudgeDecision(
          comparisonRaw,
          config.published_evaluation.top_k,
        );
        const structuredJudge = parseStructuredJudgeVerdicts(
          comparisonRaw,
          config.published_evaluation.top_k,
        ).some(Boolean);
        evaluatorCells.push({
          bundle_id: bundle.bundle_id,
          model,
          lexical: score.identified,
          published_judge: publishedJudge,
          structured_judge: structuredJudge,
          combined: score.identified || publishedJudge,
        });
      }
    }
  }

  const instanceCount = bundleSummaries.reduce(
    (sum, bundle) => sum + bundle.observed_instance_count,
    0,
  );
  const thresholds = config.corpus_gates;
  const gates = {
    minimum_error_instances: gate(instanceCount, thresholds.minimum_error_instances, "minimum"),
    minimum_unique_papers: gate(paperIds.size, thresholds.minimum_unique_papers, "minimum"),
    minimum_insertion_families: gate(bundleSummaries.filter((item) => item.observed_instance_count > 0).length, thresholds.minimum_insertion_families, "minimum"),
    minimum_complete_prediction_cells: gate(evaluatorCells.length, thresholds.minimum_complete_prediction_cells, "minimum"),
    maximum_missing_required_artifacts: gate(missingArtifacts.length, thresholds.maximum_missing_required_artifacts, "maximum"),
    declared_bundle_counts_match: {
      observed: bundleSummaries.every(
        (item) => item.observed_instance_count === item.expected_instance_count,
      ),
      required: true,
      comparison: "exact",
      pass: bundleSummaries.every(
        (item) => item.observed_instance_count === item.expected_instance_count,
      ),
    },
  };
  const contextSummary = summarizeContextProfiles(contextProfiles);
  const evaluatorSummary = summarizeEvaluatorCells(evaluatorCells);
  const corpusEligible = Object.values(gates).every((item) => item.pass);
  const decision = corpusEligible
    ? "protocol_freeze_may_proceed"
    : "kill_candidate_for_incomplete_or_insufficient_corpus";
  const payload = {
    schema_version: 1,
    artifact_kind: "reviewer_evaluator_corpus_preflight",
    generated_without_new_model_outputs: true,
    config_sha256: hashCanonical(config),
    source: config.source,
    bundle_summaries: bundleSummaries,
    instance_count: instanceCount,
    unique_paper_count: paperIds.size,
    papers_present_in_multiple_bundles: [...paperBundleCounts.values()].filter((count) => count > 1).length,
    complete_prediction_cell_count: evaluatorCells.length,
    expected_prediction_cell_count: instanceCount * config.identification_models.length,
    missing_required_artifact_count: missingArtifacts.length,
    missing_required_artifacts: missingArtifacts.slice(0, 100),
    ground_truth_context: contextSummary,
    published_evaluator_components: evaluatorSummary,
    gates,
    corpus_eligible: corpusEligible,
    decision,
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload),
  };
}

function parseScoreArray(raw, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = raw.match(new RegExp(`${escaped}:\\s*(\\[[^\\]]*\\])`, "su"));
  if (!match) return [];
  const value = JSON.parse(match[1]);
  if (!Array.isArray(value) || value.some((item) => !Number.isFinite(item))) {
    throw new Error(`Invalid score array for ${label}`);
  }
  return value;
}

function countWords(text) {
  const normalized = normalizeComparableText(text);
  return normalized ? normalized.split(/\s+/u).length : 0;
}

function gate(observed, required, mode) {
  return {
    observed,
    required,
    comparison: mode,
    pass: mode === "minimum" ? observed >= required : observed <= required,
  };
}

function quantile(values, probability) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(probability * sorted.length))];
}

function summarizeContextProfiles(profiles) {
  const ratios = profiles
    .map((profile) => profile.unchanged_modified_word_ratio)
    .filter((value) => value !== null);
  const modifiedWords = profiles.reduce((sum, item) => sum + item.modified_word_count, 0);
  const unchangedWords = profiles.reduce(
    (sum, item) => sum + item.unchanged_modified_word_count,
    0,
  );
  return {
    audited_instance_count: profiles.length,
    paired_modified_block_count: profiles.reduce((sum, item) => sum + item.pair_count, 0),
    aggregate_unchanged_modified_word_ratio:
      modifiedWords > 0 ? unchangedWords / modifiedWords : null,
    instance_ratio_q25: quantile(ratios, 0.25),
    instance_ratio_median: quantile(ratios, 0.5),
    instance_ratio_q75: quantile(ratios, 0.75),
    instances_over_half_unchanged: profiles.filter(
      (item) => (item.unchanged_modified_word_ratio ?? 0) > 0.5,
    ).length,
    instances_without_changed_modified_sentence: profiles.filter(
      (item) => item.changed_modified_sentence_count === 0,
    ).length,
  };
}

function summarizeEvaluatorCells(cells) {
  const byModel = {};
  for (const cell of cells) {
    const summary = byModel[cell.model] ?? {
      count: 0,
      lexical_positive: 0,
      insertion_judge_positive: 0,
      combined_positive: 0,
      lexical_only_positive: 0,
      insertion_judge_only_positive: 0,
      judge_parser_disagreement: 0,
    };
    summary.count += 1;
    summary.lexical_positive += Number(cell.lexical);
    summary.insertion_judge_positive += Number(cell.published_judge);
    summary.combined_positive += Number(cell.combined);
    summary.lexical_only_positive += Number(cell.lexical && !cell.published_judge);
    summary.insertion_judge_only_positive += Number(!cell.lexical && cell.published_judge);
    summary.judge_parser_disagreement += Number(
      cell.published_judge !== cell.structured_judge,
    );
    byModel[cell.model] = summary;
  }
  return Object.fromEntries(
    Object.entries(byModel).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function validateConfig(config) {
  if (!config || !Array.isArray(config.bundles) || config.bundles.length === 0) {
    throw new Error("Preflight config must declare at least one bundle");
  }
  if (!Array.isArray(config.identification_models) || config.identification_models.length === 0) {
    throw new Error("Preflight config must declare identification models");
  }
  if (!config.published_evaluation || !config.corpus_gates) {
    throw new Error("Preflight config is missing evaluation or corpus gates");
  }
}
