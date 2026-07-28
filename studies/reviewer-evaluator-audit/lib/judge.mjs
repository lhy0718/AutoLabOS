import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hashCanonical,
  normalizeComparableText,
  parseIdentifiedErrors,
  parseInsertedError,
  parseLocatedErrors,
} from "./corpus.mjs";
import { changedModifiedSentences } from "./evaluation.mjs";

export const JUDGE_REASON_CODES = [
  "same_excerpt",
  "formatting_equivalent",
  "no_same_excerpt",
];

export function buildBlindedJudgeInstances({ config, corpusRoot }) {
  const maximumDepth = config?.published_evaluation?.top_k;
  if (!Number.isInteger(maximumDepth) || maximumDepth <= 0) {
    throw new Error("judge_maximum_depth_invalid");
  }
  const instances = [];
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
      const focalTruth = uniqueSpans([
        ...changedModifiedSentences(
          inserted.original_text,
          inserted.modified_text,
        ),
        ...located,
      ]);
      if (focalTruth.length === 0) {
        throw new Error(
          `judge_focal_truth_empty:${bundle.bundle_id}:${paperId}:${claimIndex}`,
        );
      }
      const instanceId = `${bundle.bundle_id}:${paperId}:${claimIndex}`;
      const cells = config.identification_models
        .map((identificationModel) => {
          const predictionStem = `${paperId}_${claimIndex}_${identificationModel}`;
          const predictions = parseIdentifiedErrors(
            readFileSync(
              join(
                bundleRoot,
                "evaluation_errors",
                `${predictionStem}.txt`,
              ),
              "utf8",
            ),
          ).slice(0, maximumDepth);
          return {
            identification_model: identificationModel,
            candidates: predictions.map((excerpt, candidateIndex) => ({
              candidate_index: candidateIndex,
              excerpt,
            })),
            order_key: hashCanonical({
              instance_id: instanceId,
              identification_model: identificationModel,
            }),
          };
        })
        .sort((left, right) => left.order_key.localeCompare(right.order_key))
        .map(({ order_key: _orderKey, ...cell }, index) => ({
          ...cell,
          cell_id: `cell_${index + 1}`,
        }));
      const payload = {
        instance_id: instanceId,
        bundle_id: bundle.bundle_id,
        paper_id: paperId,
        claim_index: claimIndex,
        maximum_depth: maximumDepth,
        focal_truth: focalTruth,
        cells,
      };
      instances.push({
        ...payload,
        source_instance_sha256: hashCanonical(payload),
      });
    }
  }
  return instances.sort((left, right) =>
    left.instance_id.localeCompare(right.instance_id));
}

export function buildJudgeRequest({ prompt, instance }) {
  const input = {
    reference_excerpts: instance.focal_truth,
    cells: instance.cells.map((cell) => ({
      cell_id: cell.cell_id,
      candidates: cell.candidates,
    })),
  };
  const outputShape = {
    cells: [{
      cell_id: "opaque cell ID",
      verdicts: [{
        candidate_index: 0,
        match: true,
        reference_index: 0,
        reason_code: "same_excerpt",
      }],
    }],
  };
  const userContent = [
    prompt.user_instructions,
    "",
    `OUTPUT_SHAPE_EXAMPLE: ${JSON.stringify(outputShape)}`,
    "",
    `INPUT_JSON: ${JSON.stringify(input)}`,
  ].join("\n");
  return {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: userContent },
    ],
    format: buildJudgeResponseSchema(instance),
    request_input_sha256: hashCanonical(input),
    request_messages_sha256: hashCanonical({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: userContent },
      ],
    }),
  };
}

export function buildJudgeResponseSchema(instance) {
  const maximumReferenceIndex = Math.max(0, instance.focal_truth.length - 1);
  return {
    type: "object",
    additionalProperties: false,
    required: ["cells"],
    properties: {
      cells: {
        type: "array",
        minItems: instance.cells.length,
        maxItems: instance.cells.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["cell_id", "verdicts"],
          properties: {
            cell_id: { type: "string" },
            verdicts: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "candidate_index",
                  "match",
                  "reference_index",
                  "reason_code",
                ],
                properties: {
                  candidate_index: { type: "integer", minimum: 0 },
                  match: { type: "boolean" },
                  reference_index: {
                    anyOf: [
                      {
                        type: "integer",
                        minimum: 0,
                        maximum: maximumReferenceIndex,
                      },
                      { type: "null" },
                    ],
                  },
                  reason_code: {
                    type: "string",
                    enum: JUDGE_REASON_CODES,
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export function validateJudgeResponse(raw, instance) {
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return { valid: false, reasons: ["judge_response_invalid_json"] };
  }
  if (!isRecord(value) || !Array.isArray(value.cells)) {
    return { valid: false, reasons: ["judge_response_cells_missing"] };
  }
  const reasons = [];
  appendUnexpectedKeys(
    reasons,
    value,
    ["cells"],
    "judge_response_top_level_field_unexpected",
  );
  const expectedCells = new Map(
    instance.cells.map((cell) => [cell.cell_id, cell]),
  );
  const observedCells = new Map();
  for (const cell of value.cells) {
    if (!isRecord(cell) || typeof cell.cell_id !== "string") {
      reasons.push("judge_response_cell_invalid");
      continue;
    }
    appendUnexpectedKeys(
      reasons,
      cell,
      ["cell_id", "verdicts"],
      `judge_response_cell_field_unexpected:${cell.cell_id}`,
    );
    if (observedCells.has(cell.cell_id)) {
      reasons.push(`judge_response_cell_duplicate:${cell.cell_id}`);
      continue;
    }
    observedCells.set(cell.cell_id, cell);
  }
  for (const observedId of observedCells.keys()) {
    if (!expectedCells.has(observedId)) {
      reasons.push(`judge_response_cell_unexpected:${observedId}`);
    }
  }
  const normalizedCells = [];
  for (const [cellId, expectedCell] of expectedCells.entries()) {
    const observed = observedCells.get(cellId);
    if (!observed || !Array.isArray(observed.verdicts)) {
      reasons.push(`judge_response_cell_missing:${cellId}`);
      continue;
    }
    const expectedCandidateIndices = new Set(
      expectedCell.candidates.map((candidate) => candidate.candidate_index),
    );
    const verdictsByIndex = new Map();
    for (const verdict of observed.verdicts) {
      if (!isRecord(verdict) || !Number.isInteger(verdict.candidate_index)) {
        reasons.push(`judge_response_verdict_invalid:${cellId}`);
        continue;
      }
      const candidateIndex = verdict.candidate_index;
      appendUnexpectedKeys(
        reasons,
        verdict,
        ["candidate_index", "match", "reference_index", "reason_code"],
        `judge_response_verdict_field_unexpected:${cellId}:${candidateIndex}`,
      );
      if (!expectedCandidateIndices.has(candidateIndex)) {
        reasons.push(`judge_response_candidate_unexpected:${cellId}:${candidateIndex}`);
        continue;
      }
      if (verdictsByIndex.has(candidateIndex)) {
        reasons.push(`judge_response_candidate_duplicate:${cellId}:${candidateIndex}`);
        continue;
      }
      const match = verdict.match;
      const referenceIndex = verdict.reference_index;
      const reasonCode = verdict.reason_code;
      if (typeof match !== "boolean" || !JUDGE_REASON_CODES.includes(reasonCode)) {
        reasons.push(`judge_response_verdict_fields_invalid:${cellId}:${candidateIndex}`);
        continue;
      }
      if (
        match
        && (
          !Number.isInteger(referenceIndex)
          || referenceIndex < 0
          || referenceIndex >= instance.focal_truth.length
          || reasonCode === "no_same_excerpt"
        )
      ) {
        reasons.push(`judge_response_positive_inconsistent:${cellId}:${candidateIndex}`);
        continue;
      }
      if (!match && (referenceIndex !== null || reasonCode !== "no_same_excerpt")) {
        reasons.push(`judge_response_negative_inconsistent:${cellId}:${candidateIndex}`);
        continue;
      }
      verdictsByIndex.set(candidateIndex, {
        candidate_index: candidateIndex,
        match,
        reference_index: referenceIndex,
        reason_code: reasonCode,
      });
    }
    for (const candidateIndex of expectedCandidateIndices) {
      if (!verdictsByIndex.has(candidateIndex)) {
        reasons.push(`judge_response_candidate_missing:${cellId}:${candidateIndex}`);
      }
    }
    normalizedCells.push({
      cell_id: cellId,
      verdicts: [...verdictsByIndex.values()].sort(
        (left, right) => left.candidate_index - right.candidate_index,
      ),
    });
  }
  if (reasons.length > 0) {
    return { valid: false, reasons: [...new Set(reasons)].sort() };
  }
  return { valid: true, reasons: [], cells: normalizedCells };
}

export function buildDisagreementInstance(instance, first, second) {
  const firstMap = verdictMap(first);
  const secondMap = verdictMap(second);
  const cells = instance.cells
    .map((cell) => ({
      ...cell,
      candidates: cell.candidates.filter((candidate) =>
        firstMap.get(verdictKey(cell.cell_id, candidate.candidate_index))
          !== secondMap.get(verdictKey(cell.cell_id, candidate.candidate_index))),
    }))
    .filter((cell) => cell.candidates.length > 0);
  if (cells.length === 0) return undefined;
  const {
    source_instance_sha256: _sourceInstanceSha256,
    ...sourceInstance
  } = instance;
  const payload = {
    ...sourceInstance,
    instance_id: `${instance.instance_id}:disagreement_tiebreak`,
    cells,
  };
  return {
    ...payload,
    source_instance_sha256: hashCanonical(payload),
  };
}

export function adjudicateJudgeRepeats({ instance, first, second, tiebreak }) {
  const firstMap = verdictMap(first);
  const secondMap = verdictMap(second);
  const tiebreakMap = tiebreak ? verdictMap(tiebreak) : new Map();
  const finalCells = [];
  let disagreementCandidateCount = 0;
  for (const cell of instance.cells) {
    const verdicts = [];
    for (const candidate of cell.candidates) {
      const key = verdictKey(cell.cell_id, candidate.candidate_index);
      const left = firstMap.get(key);
      const right = secondMap.get(key);
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new Error(`judge_repeat_verdict_missing:${key}`);
      }
      let match = left;
      if (left !== right) {
        disagreementCandidateCount += 1;
        const third = tiebreakMap.get(key);
        if (typeof third !== "boolean") {
          throw new Error(`judge_tiebreak_verdict_missing:${key}`);
        }
        match = Number(left) + Number(right) + Number(third) >= 2;
      }
      verdicts.push({ candidate_index: candidate.candidate_index, match });
    }
    const maximumDepth = instance.maximum_depth;
    if (!Number.isInteger(maximumDepth) || maximumDepth <= 0) {
      throw new Error("judge_maximum_depth_invalid");
    }
    const matchByIndex = new Map(
      verdicts.map((verdict) => [verdict.candidate_index, verdict.match]),
    );
    let positive = false;
    const kCurve = [];
    for (let index = 0; index < maximumDepth; index += 1) {
      positive = positive || matchByIndex.get(index) === true;
      kCurve.push(positive);
    }
    finalCells.push({
      cell_id: cell.cell_id,
      identification_model: cell.identification_model,
      verdicts,
      k_curve: kCurve,
    });
  }
  return {
    disagreement_candidate_count: disagreementCandidateCount,
    final_cells: finalCells,
  };
}

function verdictMap(result) {
  const map = new Map();
  for (const cell of result.cells || []) {
    for (const verdict of cell.verdicts || []) {
      map.set(verdictKey(cell.cell_id, verdict.candidate_index), verdict.match);
    }
  }
  return map;
}

function verdictKey(cellId, candidateIndex) {
  return `${cellId}:${candidateIndex}`;
}

function uniqueSpans(values) {
  const spans = new Map();
  for (const value of values) {
    const normalized = normalizeComparableText(value);
    if (normalized && !spans.has(normalized)) spans.set(normalized, value);
  }
  return [...spans.values()];
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function appendUnexpectedKeys(reasons, value, allowedKeys, reasonPrefix) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) reasons.push(`${reasonPrefix}:${key}`);
  }
}
