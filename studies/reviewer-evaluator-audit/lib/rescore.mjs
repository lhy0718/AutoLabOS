import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hashCanonical,
  normalizeComparableText,
  parseIdentifiedErrors,
  parseInsertedError,
  parseLocatedErrors,
  parsePublishedJudgeDecision,
  parsePublishedScore,
} from "./corpus.mjs";
import {
  changedModifiedSentences,
  paperSpecifiedDetection,
  publishedCodeDetection,
} from "./evaluation.mjs";

export function rescorePublicPredictions({ config, corpusRoot }) {
  const rows = [];
  for (const bundle of config.bundles) {
    const bundleRoot = join(corpusRoot, bundle.root_directory);
    const metadata = JSON.parse(
      readFileSync(join(bundleRoot, bundle.metadata_file), "utf8"),
    );
    for (const [paperId, claimIndexValue] of Object.entries(metadata)) {
      const claimIndex = String(claimIndexValue);
      const insertedStem = `${paperId}_${claimIndex}_${bundle.insertion_model}`;
      const inserted = parseInsertedError(
        readFileSync(
          join(bundleRoot, "inserted_error", `${insertedStem}.txt`),
          "utf8",
        ),
      );
      const located = parseLocatedErrors(
        readFileSync(
          join(bundleRoot, "location_error", `${insertedStem}.txt`),
          "utf8",
        ),
      );
      const changedModified = changedModifiedSentences(
        inserted.original_text,
        inserted.modified_text,
      );
      const broadTruth = uniqueSpans([...inserted.modified_text, ...located]);
      const focalTruth = uniqueSpans([...changedModified, ...located]);

      for (const model of config.identification_models) {
        const predictionStem = `${paperId}_${claimIndex}_${model}`;
        const evaluationRoot = join(bundleRoot, "evaluation_errors");
        const predictions = parseIdentifiedErrors(
          readFileSync(join(evaluationRoot, `${predictionStem}.txt`), "utf8"),
        );
        const scoreRaw = readFileSync(
          join(evaluationRoot, `${predictionStem}_score.txt`),
          "utf8",
        );
        const comparisonRaw = readFileSync(
          join(evaluationRoot, `${predictionStem}_comparison.txt`),
          "utf8",
        );
        const retrievalDepths = Array.from(
          { length: config.published_evaluation.top_k },
          (_, index) => index + 1,
        );
        const kCurves = {
          stored_published_lexical: retrievalDepths.map((topK) =>
            parsePublishedScore(
              scoreRaw,
              topK,
              config.published_evaluation.lexical_threshold,
            ).identified),
          replayed_published_code_lexical: cumulativeCandidateCurve({
            predictions,
            maximumDepth: retrievalDepths.length,
            emptyValue: true,
            identify: (prediction) => publishedCodeDetection({
              truthSpans: broadTruth,
              predictions: [prediction],
              topK: 1,
              threshold: config.published_evaluation.lexical_threshold,
            }).identified,
          }),
          paper_specified_broad_truth_lexical: cumulativeCandidateCurve({
            predictions,
            maximumDepth: retrievalDepths.length,
            emptyValue: false,
            identify: (prediction) => paperSpecifiedDetection({
              truthSpans: broadTruth,
              predictions: [prediction],
              topK: 1,
              threshold: config.published_evaluation.lexical_threshold,
            }).identified,
          }),
          paper_specified_focal_truth_lexical: cumulativeCandidateCurve({
            predictions,
            maximumDepth: retrievalDepths.length,
            emptyValue: false,
            identify: (prediction) => paperSpecifiedDetection({
              truthSpans: focalTruth,
              predictions: [prediction],
              topK: 1,
              threshold: config.published_evaluation.lexical_threshold,
            }).identified,
          }),
          insertion_model_judge: retrievalDepths.map((topK) =>
            parsePublishedJudgeDecision(comparisonRaw, topK)),
        };
        kCurves.published_combined = retrievalDepths.map(
          (_, index) =>
            kCurves.stored_published_lexical[index]
            || kCurves.insertion_model_judge[index],
        );
        const topKIndex = retrievalDepths.length - 1;
        rows.push({
          bundle_id: bundle.bundle_id,
          paper_id: paperId,
          claim_index: claimIndex,
          identification_model: model,
          prediction_count: predictions.length,
          broad_truth_span_count: broadTruth.length,
          changed_modified_sentence_count: changedModified.length,
          official_location_span_count: located.length,
          focal_truth_span_count: focalTruth.length,
          stored_published_lexical:
            kCurves.stored_published_lexical[topKIndex],
          replayed_published_code_lexical:
            kCurves.replayed_published_code_lexical[topKIndex],
          replayed_empty_prediction_fail_open: predictions.length === 0,
          paper_specified_broad_truth_lexical:
            kCurves.paper_specified_broad_truth_lexical[topKIndex],
          paper_specified_focal_truth_lexical:
            kCurves.paper_specified_focal_truth_lexical[topKIndex],
          insertion_model_judge:
            kCurves.insertion_model_judge[topKIndex],
          published_combined:
            kCurves.published_combined[topKIndex],
          k_curves: kCurves,
        });
      }
    }
  }

  const conditions = [
    "stored_published_lexical",
    "replayed_published_code_lexical",
    "paper_specified_broad_truth_lexical",
    "paper_specified_focal_truth_lexical",
    "insertion_model_judge",
    "published_combined",
  ];
  const modelSummaries = Object.fromEntries(
    [...new Set(rows.map((row) => row.identification_model))]
      .sort()
      .map((model) => {
        const modelRows = rows.filter((row) => row.identification_model === model);
        return [model, summarizeConditions(modelRows, conditions)];
      }),
  );
  const diagnostics = {
    stored_vs_replayed_code_decision_disagreement_count: rows.filter(
      (row) => row.stored_published_lexical !== row.replayed_published_code_lexical,
    ).length,
    code_vs_paper_spec_broad_decision_disagreement_count: rows.filter(
      (row) => row.replayed_published_code_lexical
        !== row.paper_specified_broad_truth_lexical,
    ).length,
    broad_vs_focal_truth_decision_disagreement_count: rows.filter(
      (row) => row.paper_specified_broad_truth_lexical
        !== row.paper_specified_focal_truth_lexical,
    ).length,
    empty_prediction_fail_open_count: rows.filter(
      (row) => row.replayed_empty_prediction_fail_open,
    ).length,
    lexical_only_published_combined_count: rows.filter(
      (row) => row.stored_published_lexical && !row.insertion_model_judge,
    ).length,
    insertion_judge_only_published_combined_count: rows.filter(
      (row) => !row.stored_published_lexical && row.insertion_model_judge,
    ).length,
  };
  const payload = {
    schema_version: 2,
    artifact_kind: "reviewer_evaluator_public_prediction_rescore",
    analysis_class: "exploratory_measurement_audit",
    generated_without_new_model_outputs: true,
    config_sha256: hashCanonical(config),
    cell_count: rows.length,
    retrieval_depths: Array.from(
      { length: config.published_evaluation.top_k },
      (_, index) => index + 1,
    ),
    conditions,
    model_summaries: modelSummaries,
    diagnostics,
    rows,
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload),
  };
}

function uniqueSpans(values) {
  const spans = new Map();
  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (normalized && !spans.has(normalized)) spans.set(normalized, value);
  }
  return [...spans.values()];
}

function cumulativeCandidateCurve({
  predictions,
  maximumDepth,
  emptyValue,
  identify,
}) {
  if (predictions.length === 0) return Array(maximumDepth).fill(emptyValue);
  const curve = [];
  let identified = false;
  for (let index = 0; index < maximumDepth; index += 1) {
    if (!identified && index < predictions.length) {
      identified = Boolean(identify(predictions[index]));
    }
    curve.push(identified);
  }
  return curve;
}

function summarizeConditions(rows, conditions) {
  const summary = { count: rows.length };
  for (const condition of conditions) {
    const positive = rows.filter((row) => row[condition]).length;
    summary[condition] = {
      positive,
      rate: rows.length > 0 ? positive / rows.length : null,
    };
  }
  return summary;
}
