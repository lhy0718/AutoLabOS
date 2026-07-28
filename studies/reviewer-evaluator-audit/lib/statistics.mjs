const DEFAULT_TIE_TOLERANCE = 1e-10;
const DEFAULT_MAX_ITERATIONS = 100;
const DEFAULT_GRADIENT_TOLERANCE = 1e-8;
const DEFAULT_STEP_TOLERANCE = 1e-9;
const DEFAULT_COEFFICIENT_LIMIT = 30;

export class StatisticsInputError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "StatisticsInputError";
    this.code = code;
    this.details = details;
  }
}

export function validateKCurveRows({
  rows,
  conditionIds,
  retrievalDepths,
  requireInsertionModel = true,
}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new StatisticsInputError(
      "missing_data",
      "rows must be a non-empty array",
    );
  }
  const conditions = validateStringList(conditionIds, "conditionIds");
  const depths = validateRetrievalDepths(retrievalDepths);
  const seenCells = new Set();
  const models = new Set();
  const families = new Set();
  const papers = new Set();

  for (const [rowIndex, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new StatisticsInputError(
        "missing_data",
        `row ${rowIndex} must be an object`,
      );
    }
    const paperId = requiredString(row.paper_id, `rows[${rowIndex}].paper_id`);
    const claimIndex = requiredScalarString(
      row.claim_index,
      `rows[${rowIndex}].claim_index`,
    );
    const model = requiredString(
      row.identification_model,
      `rows[${rowIndex}].identification_model`,
    );
    const family = insertionFamily(row, rowIndex);
    if (requireInsertionModel) {
      requiredString(
        row.insertion_model,
        `rows[${rowIndex}].insertion_model`,
      );
    }
    if (!row.k_curves || typeof row.k_curves !== "object"
      || Array.isArray(row.k_curves)) {
      throw new StatisticsInputError(
        "missing_data",
        `rows[${rowIndex}].k_curves must be an object`,
      );
    }

    const cellKey = JSON.stringify([family, paperId, claimIndex, model]);
    if (seenCells.has(cellKey)) {
      throw new StatisticsInputError(
        "duplicate_cell",
        `duplicate evaluation cell at row ${rowIndex}`,
        { family, paper_id: paperId, claim_index: claimIndex, model },
      );
    }
    seenCells.add(cellKey);

    for (const conditionId of conditions) {
      const curve = row.k_curves[conditionId];
      if (!Array.isArray(curve)) {
        throw new StatisticsInputError(
          "missing_data",
          `rows[${rowIndex}].k_curves.${conditionId} is missing`,
        );
      }
      if (curve.length !== depths.length) {
        throw new StatisticsInputError(
          "invalid_k_curve",
          `rows[${rowIndex}].k_curves.${conditionId} must contain ${depths.length} values`,
          { observed_length: curve.length, expected_length: depths.length },
        );
      }
      let positiveSeen = false;
      for (const [depthIndex, value] of curve.entries()) {
        if (typeof value !== "boolean") {
          throw new StatisticsInputError(
            "invalid_k_curve",
            `rows[${rowIndex}].k_curves.${conditionId}[${depthIndex}] must be boolean`,
          );
        }
        if (positiveSeen && !value) {
          throw new StatisticsInputError(
            "non_monotone_k_curve",
            `rows[${rowIndex}].k_curves.${conditionId} is not cumulative`,
          );
        }
        positiveSeen ||= value;
      }
    }

    models.add(model);
    families.add(family);
    papers.add(paperId);
  }

  return {
    row_count: rows.length,
    condition_ids: conditions,
    retrieval_depths: depths,
    identification_models: [...models].sort(),
    insertion_families: [...families].sort(),
    paper_ids: [...papers].sort(),
  };
}

export function fitAdjustedLogisticMle({
  rows,
  conditionId,
  retrievalDepths,
  k,
  fixedIntercept = -3,
  insertionReference,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  gradientTolerance = DEFAULT_GRADIENT_TOLERANCE,
  stepTolerance = DEFAULT_STEP_TOLERANCE,
  coefficientLimit = DEFAULT_COEFFICIENT_LIMIT,
}) {
  const depths = validateRetrievalDepths(retrievalDepths);
  const depthIndex = depths.indexOf(k);
  if (depthIndex < 0) {
    throw new StatisticsInputError(
      "invalid_retrieval_depth",
      `k=${k} is not present in retrievalDepths`,
    );
  }
  validateKCurveRows({
    rows,
    conditionIds: [conditionId],
    retrievalDepths: depths,
  });
  return fitAdjustedLogisticMleValidated({
    rows,
    conditionId,
    depthIndex,
    k,
    fixedIntercept,
    insertionReference,
    maxIterations,
    gradientTolerance,
    stepTolerance,
    coefficientLimit,
  });
}

export function fitAdjustedRankingAcrossK({
  rows,
  conditionId,
  retrievalDepths,
  fixedIntercept = -3,
  insertionReference,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  gradientTolerance = DEFAULT_GRADIENT_TOLERANCE,
  stepTolerance = DEFAULT_STEP_TOLERANCE,
  coefficientLimit = DEFAULT_COEFFICIENT_LIMIT,
  tieTolerance = DEFAULT_TIE_TOLERANCE,
}) {
  const depths = validateRetrievalDepths(retrievalDepths);
  validateKCurveRows({
    rows,
    conditionIds: [conditionId],
    retrievalDepths: depths,
  });
  return fitAdjustedRankingAcrossKValidated({
    rows,
    conditionId,
    retrievalDepths: depths,
    fixedIntercept,
    insertionReference,
    maxIterations,
    gradientTolerance,
    stepTolerance,
    coefficientLimit,
    tieTolerance,
  });
}

export function summarizeConditionRates({
  rows,
  conditionId,
  referenceConditionId,
  retrievalDepths,
}) {
  const depths = validateRetrievalDepths(retrievalDepths);
  validateKCurveRows({
    rows,
    conditionIds: [...new Set([conditionId, referenceConditionId])],
    retrievalDepths: depths,
    requireInsertionModel: false,
  });
  return summarizeConditionRatesValidated({
    rows,
    conditionId,
    referenceConditionId,
    retrievalDepths: depths,
  });
}

export function kendallTauB(leftScores, rightScores, {
  tieTolerance = DEFAULT_TIE_TOLERANCE,
} = {}) {
  const left = scoreMap(leftScores, "leftScores");
  const right = scoreMap(rightScores, "rightScores");
  const leftIds = Object.keys(left).sort();
  const rightIds = Object.keys(right).sort();
  if (leftIds.length < 2 || !sameStringLists(leftIds, rightIds)) {
    return {
      status: "blocked",
      failure_kind: "incomparable_rankings",
      tau_b: null,
      item_count: leftIds.length,
    };
  }

  let concordant = 0;
  let discordant = 0;
  let leftTiesOnly = 0;
  let rightTiesOnly = 0;
  let jointTies = 0;
  for (const [leftIndex, firstId] of leftIds.entries()) {
    for (const secondId of leftIds.slice(leftIndex + 1)) {
      const leftOrder = compareScores(
        left[firstId],
        left[secondId],
        tieTolerance,
      );
      const rightOrder = compareScores(
        right[firstId],
        right[secondId],
        tieTolerance,
      );
      if (leftOrder === 0 && rightOrder === 0) {
        jointTies += 1;
      } else if (leftOrder === 0) {
        leftTiesOnly += 1;
      } else if (rightOrder === 0) {
        rightTiesOnly += 1;
      } else if (leftOrder === rightOrder) {
        concordant += 1;
      } else {
        discordant += 1;
      }
    }
  }
  const denominator = Math.sqrt(
    (concordant + discordant + leftTiesOnly)
      * (concordant + discordant + rightTiesOnly),
  );
  if (!(denominator > 0)) {
    return {
      status: "blocked",
      failure_kind: "all_pairs_tied",
      tau_b: null,
      item_count: leftIds.length,
      concordant,
      discordant,
      left_ties_only: leftTiesOnly,
      right_ties_only: rightTiesOnly,
      joint_ties: jointTies,
    };
  }
  return {
    status: "ok",
    failure_kind: null,
    tau_b: (concordant - discordant) / denominator,
    item_count: leftIds.length,
    concordant,
    discordant,
    left_ties_only: leftTiesOnly,
    right_ties_only: rightTiesOnly,
    joint_ties: jointTies,
  };
}

export function pairwiseOrderReversals(referenceScores, comparisonScores, {
  tieTolerance = DEFAULT_TIE_TOLERANCE,
} = {}) {
  const reference = scoreMap(referenceScores, "referenceScores");
  const comparison = scoreMap(comparisonScores, "comparisonScores");
  const referenceIds = Object.keys(reference).sort();
  const comparisonIds = Object.keys(comparison).sort();
  if (!sameStringLists(referenceIds, comparisonIds)) {
    throw new StatisticsInputError(
      "incomparable_rankings",
      "rankings must contain the same model identifiers",
    );
  }
  const reversals = [];
  const tieChanges = [];
  for (const [leftIndex, firstId] of referenceIds.entries()) {
    for (const secondId of referenceIds.slice(leftIndex + 1)) {
      const referenceOrder = compareScores(
        reference[firstId],
        reference[secondId],
        tieTolerance,
      );
      const comparisonOrder = compareScores(
        comparison[firstId],
        comparison[secondId],
        tieTolerance,
      );
      const pair = [firstId, secondId];
      if (referenceOrder !== 0 && comparisonOrder !== 0
        && referenceOrder !== comparisonOrder) {
        reversals.push({
          pair,
          reference_order: referenceOrder,
          comparison_order: comparisonOrder,
        });
      } else if (referenceOrder !== comparisonOrder
        && (referenceOrder === 0 || comparisonOrder === 0)) {
        tieChanges.push({
          pair,
          reference_order: referenceOrder,
          comparison_order: comparisonOrder,
        });
      }
    }
  }
  return {
    pair_count: pairCount(referenceIds.length),
    reversal_count: reversals.length,
    reversals,
    tie_change_count: tieChanges.length,
    tie_changes: tieChanges,
  };
}

export function createDeterministicPrng(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new StatisticsInputError(
      "invalid_seed",
      "seed must be an unsigned 32-bit integer",
    );
  }
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

export function samplePaperClusters(rows, {
  prng,
  clusterKey = "paper_id",
} = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new StatisticsInputError(
      "missing_data",
      "rows must be a non-empty array",
    );
  }
  if (typeof prng !== "function") {
    throw new StatisticsInputError(
      "missing_prng",
      "samplePaperClusters requires a PRNG function",
    );
  }
  const rowsByCluster = new Map();
  for (const [rowIndex, row] of rows.entries()) {
    const clusterId = requiredString(
      row?.[clusterKey],
      `rows[${rowIndex}].${clusterKey}`,
    );
    if (!rowsByCluster.has(clusterId)) rowsByCluster.set(clusterId, []);
    rowsByCluster.get(clusterId).push(row);
  }
  const clusterIds = [...rowsByCluster.keys()].sort();
  const sampledClusterIds = [];
  const sampledRows = [];
  const multiplicities = {};
  for (let draw = 0; draw < clusterIds.length; draw += 1) {
    const randomValue = prng();
    if (!(randomValue >= 0 && randomValue < 1)) {
      throw new StatisticsInputError(
        "invalid_prng_output",
        "PRNG output must be in [0, 1)",
      );
    }
    const sampledId = clusterIds[Math.floor(randomValue * clusterIds.length)];
    sampledClusterIds.push(sampledId);
    multiplicities[sampledId] = (multiplicities[sampledId] ?? 0) + 1;
    sampledRows.push(...rowsByCluster.get(sampledId));
  }
  return {
    rows: sampledRows,
    sampled_cluster_ids: sampledClusterIds,
    multiplicities,
    unique_sampled_cluster_count: Object.keys(multiplicities).length,
  };
}

export function percentileInterval(values, confidenceLevel = 0.95) {
  if (!Array.isArray(values) || values.length === 0
    || values.some((value) => !Number.isFinite(value))) {
    throw new StatisticsInputError(
      "invalid_bootstrap_values",
      "percentile values must be a non-empty finite numeric array",
    );
  }
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new StatisticsInputError(
      "invalid_confidence_level",
      "confidenceLevel must be between zero and one",
    );
  }
  const sorted = [...values].sort((left, right) => left - right);
  const alpha = (1 - confidenceLevel) / 2;
  return {
    lower: percentileSorted(sorted, alpha),
    upper: percentileSorted(sorted, 1 - alpha),
    confidence_level: confidenceLevel,
  };
}

export function clusterPercentileBootstrap({
  rows,
  conditionIds,
  referenceConditionId,
  retrievalDepths,
  fixedIntercept = -3,
  insertionReference,
  resamples,
  seed,
  confidenceLevel = 0.95,
  tieTolerance = DEFAULT_TIE_TOLERANCE,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  gradientTolerance = DEFAULT_GRADIENT_TOLERANCE,
  stepTolerance = DEFAULT_STEP_TOLERANCE,
  coefficientLimit = DEFAULT_COEFFICIENT_LIMIT,
}) {
  const conditions = validateStringList(conditionIds, "conditionIds");
  const depths = validateRetrievalDepths(retrievalDepths);
  requiredString(referenceConditionId, "referenceConditionId");
  if (!Number.isInteger(resamples) || resamples <= 0) {
    throw new StatisticsInputError(
      "invalid_resample_count",
      "resamples must be a positive integer",
    );
  }
  validateKCurveRows({
    rows,
    conditionIds: [...new Set([...conditions, referenceConditionId])],
    retrievalDepths: depths,
  });
  const clusterIds = [...new Set(rows.map((row) => row.paper_id))].sort();
  if (clusterIds.length < 2) {
    return {
      status: "blocked",
      failure_kind: "insufficient_clusters",
      requested_resamples: resamples,
      completed_resamples: 0,
      cluster_count: clusterIds.length,
      summaries: null,
    };
  }

  const prng = createDeterministicPrng(seed);
  const accumulators = createBootstrapAccumulators(
    rows,
    conditions,
    depths,
  );
  for (let replicate = 0; replicate < resamples; replicate += 1) {
    const sample = samplePaperClusters(rows, { prng });
    for (const conditionId of conditions) {
      const rates = summarizeConditionRatesValidated({
        rows: sample.rows,
        conditionId,
        referenceConditionId,
        retrievalDepths: depths,
      });
      const ranking = fitAdjustedRankingAcrossKValidated({
        rows: sample.rows,
        conditionId,
        retrievalDepths: depths,
        fixedIntercept,
        insertionReference,
        maxIterations,
        gradientTolerance,
        stepTolerance,
        coefficientLimit,
        tieTolerance,
      });
      if (ranking.status !== "ok") {
        return {
          status: "blocked",
          failure_kind: "bootstrap_adjusted_fit_failure",
          requested_resamples: resamples,
          completed_resamples: replicate,
          cluster_count: clusterIds.length,
          failed_resample: {
            index: replicate,
            condition_id: conditionId,
            sampled_cluster_multiplicities: sample.multiplicities,
            ranking_failure: ranking,
          },
          summaries: null,
        };
      }
      accumulateBootstrapResult(
        accumulators[conditionId],
        rates,
        ranking,
        tieTolerance,
      );
    }
  }

  return {
    status: "ok",
    failure_kind: null,
    method: "percentile_cluster_bootstrap",
    cluster_key: "paper_id",
    cluster_count: clusterIds.length,
    requested_resamples: resamples,
    completed_resamples: resamples,
    seed,
    confidence_level: confidenceLevel,
    sampling_with_replacement: true,
    retains_cluster_multiplicity: true,
    summaries: Object.fromEntries(
      conditions.map((conditionId) => [
        conditionId,
        summarizeBootstrapAccumulator(
          accumulators[conditionId],
          resamples,
          confidenceLevel,
        ),
      ]),
    ),
  };
}

function fitAdjustedRankingAcrossKValidated({
  rows,
  conditionId,
  retrievalDepths,
  fixedIntercept,
  insertionReference,
  maxIterations,
  gradientTolerance,
  stepTolerance,
  coefficientLimit,
  tieTolerance,
}) {
  const perK = [];
  const failures = [];
  for (const [depthIndex, k] of retrievalDepths.entries()) {
    const fit = fitAdjustedLogisticMleValidated({
      rows,
      conditionId,
      depthIndex,
      k,
      fixedIntercept,
      insertionReference,
      maxIterations,
      gradientTolerance,
      stepTolerance,
      coefficientLimit,
    });
    perK.push(fit);
    if (fit.status !== "ok") {
      failures.push({
        k,
        failure_kind: fit.failure_kind,
        reason: fit.reason,
      });
    }
  }
  if (failures.length > 0) {
    return {
      status: "blocked",
      failure_kind: "adjusted_fit_failure",
      condition_id: conditionId,
      per_k: perK,
      failures,
      mean_identification_effects: null,
      ranking: null,
    };
  }

  const modelIds = Object.keys(perK[0].identification_effects).sort();
  const means = Object.fromEntries(modelIds.map((modelId) => [
    modelId,
    mean(perK.map((fit) => fit.identification_effects[modelId])),
  ]));
  return {
    status: "ok",
    failure_kind: null,
    condition_id: conditionId,
    per_k: perK,
    mean_identification_effects: means,
    ranking: rankScoreMap(means, tieTolerance),
  };
}

function fitAdjustedLogisticMleValidated({
  rows,
  conditionId,
  depthIndex,
  k,
  fixedIntercept,
  insertionReference,
  maxIterations,
  gradientTolerance,
  stepTolerance,
  coefficientLimit,
}) {
  if (!Number.isFinite(fixedIntercept)) {
    throw new StatisticsInputError(
      "invalid_fixed_intercept",
      "fixedIntercept must be finite",
    );
  }
  const reference = requiredString(
    insertionReference,
    "insertionReference",
  );
  const modelIds = [...new Set(
    rows.map((row) => requiredString(
      row.identification_model,
      "row.identification_model",
    )),
  )].sort();
  const familyIds = [...new Set(rows.map((row, rowIndex) =>
    insertionFamily(row, rowIndex)))].sort();
  if (!familyIds.includes(reference)) {
    return failedFit({
      conditionId,
      k,
      fixedIntercept,
      insertionReference: reference,
      failureKind: "missing_reference_family",
      reason: `reference insertion family ${reference} is absent`,
      observationCount: 0,
      excludedCount: 0,
    });
  }
  const nonReferenceFamilies = familyIds.filter((family) => family !== reference);
  const modelIndex = new Map(modelIds.map((modelId, index) => [modelId, index]));
  const familyIndex = new Map(nonReferenceFamilies.map(
    (family, index) => [family, modelIds.length + index],
  ));
  const grouped = new Map();
  let excludedSameModelCount = 0;

  for (const row of rows) {
    const modelId = row.identification_model;
    const insertionModel = requiredString(
      row.insertion_model,
      "row.insertion_model",
    );
    if (modelId === insertionModel) {
      excludedSameModelCount += 1;
      continue;
    }
    const family = insertionFamily(row);
    const outcome = row.k_curves[conditionId][depthIndex];
    const key = JSON.stringify([modelId, family]);
    const current = grouped.get(key) ?? {
      model_id: modelId,
      family_id: family,
      trials: 0,
      successes: 0,
    };
    current.trials += 1;
    current.successes += outcome ? 1 : 0;
    grouped.set(key, current);
  }
  const groups = [...grouped.values()];
  const observationCount = groups.reduce((sum, group) => sum + group.trials, 0);
  const parameterCount = modelIds.length + nonReferenceFamilies.length;
  if (observationCount <= parameterCount || groups.length === 0) {
    return failedFit({
      conditionId,
      k,
      fixedIntercept,
      insertionReference: reference,
      failureKind: "insufficient_observations",
      reason: "too few non-excluded observations for the declared model",
      observationCount,
      excludedCount: excludedSameModelCount,
    });
  }

  for (const modelId of modelIds) {
    const modelGroups = groups.filter((group) => group.model_id === modelId);
    const trials = modelGroups.reduce((sum, group) => sum + group.trials, 0);
    const successes = modelGroups.reduce(
      (sum, group) => sum + group.successes,
      0,
    );
    if (trials === 0) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "missing_model_observations",
        reason: `model ${modelId} has no observations after same-model exclusion`,
        observationCount,
        excludedCount: excludedSameModelCount,
      });
    }
    if (successes === 0 || successes === trials) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "separation",
        reason: `model ${modelId} has a constant outcome at k=${k}`,
        observationCount,
        excludedCount: excludedSameModelCount,
      });
    }
  }
  for (const family of nonReferenceFamilies) {
    const familyGroups = groups.filter((group) => group.family_id === family);
    const trials = familyGroups.reduce((sum, group) => sum + group.trials, 0);
    const successes = familyGroups.reduce(
      (sum, group) => sum + group.successes,
      0,
    );
    if (successes === 0 || successes === trials) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "separation",
        reason: `insertion family ${family} has a constant outcome at k=${k}`,
        observationCount,
        excludedCount: excludedSameModelCount,
      });
    }
  }

  const designGroups = groups.map((group) => {
    const active = [modelIndex.get(group.model_id)];
    if (familyIndex.has(group.family_id)) {
      active.push(familyIndex.get(group.family_id));
    }
    return { ...group, active };
  });
  let coefficients = Array(parameterCount).fill(0);
  let logLikelihood = logisticLogLikelihood(
    designGroups,
    coefficients,
    fixedIntercept,
  );
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const { gradient, information } = logisticDerivatives(
      designGroups,
      coefficients,
      fixedIntercept,
    );
    const maxGradient = maxAbs(gradient);
    if (maxGradient <= gradientTolerance) {
      return successfulFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        modelIds,
        nonReferenceFamilies,
        coefficients,
        iterations: iteration - 1,
        logLikelihood,
        maxGradient,
        observationCount,
        excludedSameModelCount,
      });
    }
    const step = solveLinearSystem(information, gradient);
    if (!step) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "singular_information",
        reason: `observed information is singular at iteration ${iteration}`,
        observationCount,
        excludedCount: excludedSameModelCount,
        iterations: iteration,
      });
    }

    let stepScale = 1;
    let candidate = coefficients.map(
      (coefficient, index) => coefficient + step[index],
    );
    let candidateLogLikelihood = logisticLogLikelihood(
      designGroups,
      candidate,
      fixedIntercept,
    );
    while (
      (!Number.isFinite(candidateLogLikelihood)
        || candidateLogLikelihood < logLikelihood - 1e-12)
      && stepScale > 2 ** -24
    ) {
      stepScale /= 2;
      candidate = coefficients.map(
        (coefficient, index) => coefficient + stepScale * step[index],
      );
      candidateLogLikelihood = logisticLogLikelihood(
        designGroups,
        candidate,
        fixedIntercept,
      );
    }
    if (!Number.isFinite(candidateLogLikelihood)
      || candidateLogLikelihood < logLikelihood - 1e-12) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "non_convergence",
        reason: `line search failed at iteration ${iteration}`,
        observationCount,
        excludedCount: excludedSameModelCount,
        iterations: iteration,
      });
    }
    if (maxAbs(candidate) > coefficientLimit) {
      return failedFit({
        conditionId,
        k,
        fixedIntercept,
        insertionReference: reference,
        failureKind: "separation",
        reason: `coefficient magnitude exceeded ${coefficientLimit}`,
        observationCount,
        excludedCount: excludedSameModelCount,
        iterations: iteration,
      });
    }

    const maxScaledStep = maxAbs(step) * stepScale;
    const likelihoodChange = Math.abs(candidateLogLikelihood - logLikelihood);
    coefficients = candidate;
    logLikelihood = candidateLogLikelihood;
    if (maxScaledStep <= stepTolerance && likelihoodChange <= stepTolerance) {
      const finalGradient = logisticDerivatives(
        designGroups,
        coefficients,
        fixedIntercept,
      ).gradient;
      const maxFinalGradient = maxAbs(finalGradient);
      if (maxFinalGradient <= Math.sqrt(gradientTolerance)) {
        return successfulFit({
          conditionId,
          k,
          fixedIntercept,
          insertionReference: reference,
          modelIds,
          nonReferenceFamilies,
          coefficients,
          iterations: iteration,
          logLikelihood,
          maxGradient: maxFinalGradient,
          observationCount,
          excludedSameModelCount,
        });
      }
    }
  }
  return failedFit({
    conditionId,
    k,
    fixedIntercept,
    insertionReference: reference,
    failureKind: "non_convergence",
    reason: `MLE did not converge within ${maxIterations} iterations`,
    observationCount,
    excludedCount: excludedSameModelCount,
    iterations: maxIterations,
  });
}

function summarizeConditionRatesValidated({
  rows,
  conditionId,
  referenceConditionId,
  retrievalDepths,
}) {
  const modelIds = [...new Set(rows.map((row) => row.identification_model))].sort();
  return {
    condition_id: conditionId,
    reference_condition_id: referenceConditionId,
    top_k: retrievalDepths.map((k, depthIndex) =>
      rateAtDepth(rows, conditionId, referenceConditionId, depthIndex, k)),
    by_identification_model: Object.fromEntries(modelIds.map((modelId) => {
      const modelRows = rows.filter(
        (row) => row.identification_model === modelId,
      );
      return [modelId, retrievalDepths.map((k, depthIndex) =>
        rateAtDepth(
          modelRows,
          conditionId,
          referenceConditionId,
          depthIndex,
          k,
        ))];
    })),
  };
}

function rateAtDepth(
  rows,
  conditionId,
  referenceConditionId,
  depthIndex,
  k,
) {
  const count = rows.length;
  let positiveCount = 0;
  let referencePositiveCount = 0;
  let flipCount = 0;
  let negativeToPositiveCount = 0;
  let positiveToNegativeCount = 0;
  for (const row of rows) {
    const value = row.k_curves[conditionId][depthIndex];
    const reference = row.k_curves[referenceConditionId][depthIndex];
    positiveCount += value ? 1 : 0;
    referencePositiveCount += reference ? 1 : 0;
    if (value !== reference) {
      flipCount += 1;
      if (value) negativeToPositiveCount += 1;
      else positiveToNegativeCount += 1;
    }
  }
  return {
    k,
    cell_count: count,
    positive_count: positiveCount,
    positive_rate: positiveCount / count,
    reference_positive_count: referencePositiveCount,
    reference_positive_rate: referencePositiveCount / count,
    flip_count: flipCount,
    flip_rate: flipCount / count,
    negative_to_positive_count: negativeToPositiveCount,
    positive_to_negative_count: positiveToNegativeCount,
    rate_difference: (positiveCount - referencePositiveCount) / count,
  };
}

function createBootstrapAccumulators(rows, conditionIds, retrievalDepths) {
  const modelIds = [...new Set(rows.map((row) => row.identification_model))].sort();
  const pairs = modelPairs(modelIds);
  return Object.fromEntries(conditionIds.map((conditionId) => [
    conditionId,
    {
      top_k: retrievalDepths.map((k) => ({
        k,
        positive_rate: [],
        flip_rate: [],
        rate_difference: [],
      })),
      mean_coefficients: Object.fromEntries(
        modelIds.map((modelId) => [modelId, []]),
      ),
      unique_top_counts: Object.fromEntries(
        modelIds.map((modelId) => [modelId, 0]),
      ),
      tied_top_replicates: 0,
      pairwise: Object.fromEntries(pairs.map(([firstId, secondId]) => [
        pairKey(firstId, secondId),
        {
          first_model: firstId,
          second_model: secondId,
          first_above: 0,
          second_above: 0,
          tied: 0,
        },
      ])),
    },
  ]));
}

function accumulateBootstrapResult(
  accumulator,
  rates,
  ranking,
  tieTolerance,
) {
  for (const [depthIndex, result] of rates.top_k.entries()) {
    accumulator.top_k[depthIndex].positive_rate.push(result.positive_rate);
    accumulator.top_k[depthIndex].flip_rate.push(result.flip_rate);
    accumulator.top_k[depthIndex].rate_difference.push(result.rate_difference);
  }
  for (const [modelId, coefficient] of Object.entries(
    ranking.mean_identification_effects,
  )) {
    accumulator.mean_coefficients[modelId].push(coefficient);
  }
  if (ranking.ranking.top_models.length === 1) {
    accumulator.unique_top_counts[ranking.ranking.top_models[0]] += 1;
  } else {
    accumulator.tied_top_replicates += 1;
  }
  for (const pair of Object.values(accumulator.pairwise)) {
    const order = compareScores(
      ranking.mean_identification_effects[pair.first_model],
      ranking.mean_identification_effects[pair.second_model],
      tieTolerance,
    );
    if (order > 0) pair.first_above += 1;
    else if (order < 0) pair.second_above += 1;
    else pair.tied += 1;
  }
}

function summarizeBootstrapAccumulator(
  accumulator,
  resamples,
  confidenceLevel,
) {
  return {
    top_k: accumulator.top_k.map((values, depthIndex) => ({
      k: values.k,
      k_index: depthIndex,
      positive_rate_interval: percentileInterval(
        values.positive_rate,
        confidenceLevel,
      ),
      flip_rate_interval: percentileInterval(
        values.flip_rate,
        confidenceLevel,
      ),
      rate_difference_interval: percentileInterval(
        values.rate_difference,
        confidenceLevel,
      ),
    })),
    mean_identification_effect_intervals: Object.fromEntries(
      Object.entries(accumulator.mean_coefficients).map(
        ([modelId, values]) => [
          modelId,
          percentileInterval(values, confidenceLevel),
        ],
      ),
    ),
    unique_top_1_probability: Object.fromEntries(
      Object.entries(accumulator.unique_top_counts).map(
        ([modelId, count]) => [modelId, count / resamples],
      ),
    ),
    tied_top_1_probability: accumulator.tied_top_replicates / resamples,
    pairwise_order_probability: Object.values(accumulator.pairwise).map(
      (pair) => ({
        first_model: pair.first_model,
        second_model: pair.second_model,
        first_above: pair.first_above / resamples,
        second_above: pair.second_above / resamples,
        tied: pair.tied / resamples,
      }),
    ),
  };
}

function rankScoreMap(scores, tieTolerance) {
  const ordered = Object.entries(scores)
    .map(([modelId, value]) => ({ model_id: modelId, value }))
    .sort((left, right) =>
      right.value - left.value || left.model_id.localeCompare(right.model_id));
  const ranked = [];
  let start = 0;
  while (start < ordered.length) {
    let end = start + 1;
    while (
      end < ordered.length
      && compareScores(
        ordered[start].value,
        ordered[end].value,
        tieTolerance,
      ) === 0
    ) {
      end += 1;
    }
    const averageRank = ((start + 1) + end) / 2;
    for (const item of ordered.slice(start, end)) {
      ranked.push({
        model_id: item.model_id,
        mean_coefficient: item.value,
        rank: averageRank,
      });
    }
    start = end;
  }
  const firstRank = Math.min(...ranked.map((item) => item.rank));
  const topModels = ranked
    .filter((item) => item.rank === firstRank)
    .map((item) => item.model_id)
    .sort();
  return {
    ordered: ranked,
    top_models: topModels,
    top_1_model: topModels.length === 1 ? topModels[0] : null,
    top_1_tied: topModels.length !== 1,
  };
}

function successfulFit({
  conditionId,
  k,
  fixedIntercept,
  insertionReference,
  modelIds,
  nonReferenceFamilies,
  coefficients,
  iterations,
  logLikelihood,
  maxGradient,
  observationCount,
  excludedSameModelCount,
}) {
  return {
    status: "ok",
    failure_kind: null,
    converged: true,
    condition_id: conditionId,
    k,
    fixed_intercept: fixedIntercept,
    insertion_reference: insertionReference,
    observation_count: observationCount,
    excluded_same_model_count: excludedSameModelCount,
    parameter_count: coefficients.length,
    iterations,
    log_likelihood: logLikelihood,
    max_abs_gradient: maxGradient,
    identification_effects: Object.fromEntries(
      modelIds.map((modelId, index) => [modelId, coefficients[index]]),
    ),
    insertion_family_effects: {
      [insertionReference]: 0,
      ...Object.fromEntries(nonReferenceFamilies.map(
        (family, index) => [
          family,
          coefficients[modelIds.length + index],
        ],
      )),
    },
  };
}

function failedFit({
  conditionId,
  k,
  fixedIntercept,
  insertionReference,
  failureKind,
  reason,
  observationCount,
  excludedCount,
  iterations = 0,
}) {
  return {
    status: "blocked",
    failure_kind: failureKind,
    converged: false,
    condition_id: conditionId,
    k,
    fixed_intercept: fixedIntercept,
    insertion_reference: insertionReference,
    observation_count: observationCount,
    excluded_same_model_count: excludedCount,
    iterations,
    reason,
    identification_effects: null,
    insertion_family_effects: null,
  };
}

function logisticDerivatives(groups, coefficients, fixedIntercept) {
  const gradient = Array(coefficients.length).fill(0);
  const information = Array.from(
    { length: coefficients.length },
    () => Array(coefficients.length).fill(0),
  );
  for (const group of groups) {
    const eta = fixedIntercept + group.active.reduce(
      (sum, index) => sum + coefficients[index],
      0,
    );
    const probability = sigmoid(eta);
    const residual = group.successes - group.trials * probability;
    const weight = group.trials * probability * (1 - probability);
    for (const firstIndex of group.active) {
      gradient[firstIndex] += residual;
      for (const secondIndex of group.active) {
        information[firstIndex][secondIndex] += weight;
      }
    }
  }
  return { gradient, information };
}

function logisticLogLikelihood(groups, coefficients, fixedIntercept) {
  let value = 0;
  for (const group of groups) {
    const eta = fixedIntercept + group.active.reduce(
      (sum, index) => sum + coefficients[index],
      0,
    );
    value += group.successes * eta - group.trials * log1pExp(eta);
  }
  return value;
}

function solveLinearSystem(matrix, vector) {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column])
        > Math.abs(augmented[pivotRow][column])) {
        pivotRow = row;
      }
    }
    const pivot = augmented[pivotRow][column];
    if (!Number.isFinite(pivot) || Math.abs(pivot) <= 1e-12) return null;
    [augmented[column], augmented[pivotRow]] = [
      augmented[pivotRow],
      augmented[column],
    ];
    for (let row = column + 1; row < size; row += 1) {
      const factor = augmented[row][column] / augmented[column][column];
      for (let item = column; item <= size; item += 1) {
        augmented[row][item] -= factor * augmented[column][item];
      }
    }
  }
  const solution = Array(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    let remainder = augmented[row][size];
    for (let column = row + 1; column < size; column += 1) {
      remainder -= augmented[row][column] * solution[column];
    }
    const pivot = augmented[row][row];
    if (!Number.isFinite(pivot) || Math.abs(pivot) <= 1e-12) return null;
    solution[row] = remainder / pivot;
  }
  return solution.every(Number.isFinite) ? solution : null;
}

function scoreMap(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatisticsInputError(
      "invalid_scores",
      `${label} must be an object`,
    );
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(
    ([modelId, score]) => !modelId || !Number.isFinite(score),
  )) {
    throw new StatisticsInputError(
      "invalid_scores",
      `${label} must map non-empty identifiers to finite scores`,
    );
  }
  return Object.fromEntries(entries);
}

function insertionFamily(row, rowIndex = null) {
  const value = row?.insertion_family ?? row?.bundle_id;
  const label = rowIndex === null
    ? "row.insertion_family or row.bundle_id"
    : `rows[${rowIndex}].insertion_family or bundle_id`;
  return requiredString(value, label);
}

function validateRetrievalDepths(value) {
  if (!Array.isArray(value) || value.length === 0
    || value.some((depth) => !Number.isInteger(depth) || depth <= 0)) {
    throw new StatisticsInputError(
      "invalid_retrieval_depths",
      "retrievalDepths must be a non-empty array of positive integers",
    );
  }
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] <= value[index - 1]) {
      throw new StatisticsInputError(
        "invalid_retrieval_depths",
        "retrievalDepths must be strictly increasing",
      );
    }
  }
  return [...value];
}

function validateStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StatisticsInputError(
      "missing_data",
      `${label} must be a non-empty array`,
    );
  }
  const strings = value.map((item, index) =>
    requiredString(item, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) {
    throw new StatisticsInputError(
      "duplicate_identifier",
      `${label} must not contain duplicates`,
    );
  }
  return strings;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StatisticsInputError(
      "missing_data",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function requiredScalarString(value, label) {
  if ((typeof value !== "string" && typeof value !== "number")
    || String(value).trim() === "") {
    throw new StatisticsInputError(
      "missing_data",
      `${label} must be a non-empty string or number`,
    );
  }
  return String(value);
}

function compareScores(left, right, tolerance) {
  const difference = left - right;
  if (Math.abs(difference) <= tolerance) return 0;
  return difference > 0 ? 1 : -1;
}

function modelPairs(modelIds) {
  const pairs = [];
  for (const [index, firstId] of modelIds.entries()) {
    for (const secondId of modelIds.slice(index + 1)) {
      pairs.push([firstId, secondId]);
    }
  }
  return pairs;
}

function pairKey(firstId, secondId) {
  return JSON.stringify([firstId, secondId]);
}

function pairCount(itemCount) {
  return itemCount * (itemCount - 1) / 2;
}

function sameStringLists(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

function log1pExp(value) {
  if (value > 0) return value + Math.log1p(Math.exp(-value));
  return Math.log1p(Math.exp(value));
}

function percentileSorted(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = probability * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  if (lowerIndex === upperIndex) return sorted[lowerIndex];
  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

function maxAbs(values) {
  return Math.max(0, ...values.map((value) => Math.abs(value)));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
