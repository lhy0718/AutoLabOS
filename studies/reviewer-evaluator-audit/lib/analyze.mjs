import { hashCanonical } from "./corpus.mjs";
import {
  StatisticsInputError,
  clusterPercentileBootstrap,
  fitAdjustedRankingAcrossK,
  kendallTauB,
  pairwiseOrderReversals,
  summarizeConditionRates,
  validateKCurveRows,
} from "./statistics.mjs";

export function protocolAnalysisContract(protocol) {
  if (!protocol || typeof protocol !== "object" || Array.isArray(protocol)) {
    throw new StatisticsInputError(
      "invalid_protocol",
      "protocol must be an object",
    );
  }
  const primaryConditions = requireArray(
    protocol.primary_conditions,
    "protocol.primary_conditions",
  ).map((condition, index) => {
    if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
      throw new StatisticsInputError(
        "invalid_protocol",
        `protocol.primary_conditions[${index}] must be an object`,
      );
    }
    return {
      id: requireString(
        condition.id,
        `protocol.primary_conditions[${index}].id`,
      ),
      role: condition.role ?? "primary",
    };
  });
  const secondaryConditions = requireArray(
    protocol.secondary_conditions,
    "protocol.secondary_conditions",
  ).map((conditionId, index) =>
    requireString(
      conditionId,
      `protocol.secondary_conditions[${index}]`,
    ));
  const referenceConditions = primaryConditions.filter(
    (condition) => condition.role === "reference",
  );
  if (referenceConditions.length !== 1) {
    throw new StatisticsInputError(
      "invalid_protocol",
      "protocol must declare exactly one primary reference condition",
    );
  }
  const conditionIds = unique([
    ...primaryConditions.map((condition) => condition.id),
    ...secondaryConditions,
  ]);
  if (conditionIds.length
    !== primaryConditions.length + secondaryConditions.length) {
    throw new StatisticsInputError(
      "duplicate_identifier",
      "primary and secondary condition identifiers must be unique",
    );
  }

  const retrievalDepths = requireArray(
    protocol.units?.retrieval_depths,
    "protocol.units.retrieval_depths",
  );
  const fixedIntercept = protocol.adjusted_ranking_model?.fixed_intercept;
  if (!Number.isFinite(fixedIntercept)) {
    throw new StatisticsInputError(
      "invalid_protocol",
      "protocol.adjusted_ranking_model.fixed_intercept must be finite",
    );
  }
  const insertionReference = requireString(
    protocol.adjusted_ranking_model?.insertion_reference,
    "protocol.adjusted_ranking_model.insertion_reference",
  );
  const resamples = positiveInteger(
    protocol.uncertainty?.resamples,
    "protocol.uncertainty.resamples",
  );
  const seed = unsignedInteger(
    protocol.uncertainty?.seed,
    "protocol.uncertainty.seed",
  );
  const confidenceLevel = protocol.uncertainty?.confidence_level;
  if (!(confidenceLevel > 0 && confidenceLevel < 1)) {
    throw new StatisticsInputError(
      "invalid_protocol",
      "protocol.uncertainty.confidence_level must be between zero and one",
    );
  }
  if (protocol.uncertainty?.cluster !== "paper_id") {
    throw new StatisticsInputError(
      "invalid_protocol",
      "protocol.uncertainty.cluster must be paper_id",
    );
  }

  return {
    condition_ids: conditionIds,
    primary_condition_ids: primaryConditions.map((condition) => condition.id),
    primary_roles: Object.fromEntries(
      primaryConditions.map((condition) => [condition.id, condition.role]),
    ),
    secondary_condition_ids: secondaryConditions,
    reference_condition_id: referenceConditions[0].id,
    retrieval_depths: retrievalDepths,
    fixed_intercept: fixedIntercept,
    insertion_reference: insertionReference,
    uncertainty: {
      resamples,
      seed,
      confidence_level: confidenceLevel,
    },
    expected_shape: {
      error_instances: positiveInteger(
        protocol.units?.expected_error_instances,
        "protocol.units.expected_error_instances",
      ),
      paper_clusters: positiveInteger(
        protocol.units?.expected_unique_paper_clusters,
        "protocol.units.expected_unique_paper_clusters",
      ),
      evaluation_cells: positiveInteger(
        protocol.units?.expected_evaluation_cells,
        "protocol.units.expected_evaluation_cells",
      ),
    },
  };
}

export function analyzeEvaluatorSensitivity({
  protocol,
  input,
  bootstrapResamples,
}) {
  const protocolSha256 = protocol && typeof protocol === "object"
    && !Array.isArray(protocol)
    ? hashCanonical(protocol)
    : null;
  try {
    const contract = protocolAnalysisContract(protocol);
    validateContentAddressedInput(input);
    const inputMetadata = validateKCurveRows({
      rows: input.rows,
      conditionIds: contract.condition_ids,
      retrievalDepths: contract.retrieval_depths,
    });
    validateExpectedShape(input.rows, inputMetadata, contract.expected_shape);

    const effectiveResamples = bootstrapResamples === undefined
      ? contract.uncertainty.resamples
      : positiveInteger(bootstrapResamples, "bootstrapResamples");
    const protocolConformantResamples = effectiveResamples
      === contract.uncertainty.resamples;
    const conditions = {};
    const failures = [];

    for (const conditionId of contract.condition_ids) {
      const rates = summarizeConditionRates({
        rows: input.rows,
        conditionId,
        referenceConditionId: contract.reference_condition_id,
        retrievalDepths: contract.retrieval_depths,
      });
      const adjustedRanking = fitAdjustedRankingAcrossK({
        rows: input.rows,
        conditionId,
        retrievalDepths: contract.retrieval_depths,
        fixedIntercept: contract.fixed_intercept,
        insertionReference: contract.insertion_reference,
      });
      if (adjustedRanking.status !== "ok") {
        failures.push({
          scope: "point_adjusted_ranking",
          condition_id: conditionId,
          primary: contract.primary_condition_ids.includes(conditionId),
          failure_kind: adjustedRanking.failure_kind,
          details: adjustedRanking.failures,
        });
      }
      conditions[conditionId] = {
        role: conditionRole(conditionId, contract),
        rates,
        adjusted_ranking: adjustedRanking,
        ranking_sensitivity_vs_reference: null,
        bootstrap: null,
      };
    }

    const referenceRanking = conditions[contract.reference_condition_id]
      .adjusted_ranking;
    for (const conditionId of contract.condition_ids) {
      const adjustedRanking = conditions[conditionId].adjusted_ranking;
      if (referenceRanking.status !== "ok" || adjustedRanking.status !== "ok") {
        conditions[conditionId].ranking_sensitivity_vs_reference = {
          status: "blocked",
          failure_kind: "point_adjusted_ranking_unavailable",
          kendall_tau_b: null,
          pairwise_order_reversals: null,
        };
        conditions[conditionId].bootstrap = {
          status: "blocked",
          failure_kind: "point_adjusted_ranking_unavailable",
          requested_resamples: effectiveResamples,
          completed_resamples: 0,
          summaries: null,
        };
        continue;
      }

      const tau = kendallTauB(
        referenceRanking.mean_identification_effects,
        adjustedRanking.mean_identification_effects,
      );
      conditions[conditionId].ranking_sensitivity_vs_reference = {
        status: tau.status,
        failure_kind: tau.failure_kind,
        kendall_tau_b: tau,
        pairwise_order_reversals: pairwiseOrderReversals(
          referenceRanking.mean_identification_effects,
          adjustedRanking.mean_identification_effects,
        ),
      };
      if (tau.status !== "ok") {
        failures.push({
          scope: "ranking_sensitivity",
          condition_id: conditionId,
          primary: contract.primary_condition_ids.includes(conditionId),
          failure_kind: tau.failure_kind,
          details: tau,
        });
      }
      const bootstrap = clusterPercentileBootstrap({
        rows: input.rows,
        conditionIds: [conditionId],
        referenceConditionId: contract.reference_condition_id,
        retrievalDepths: contract.retrieval_depths,
        fixedIntercept: contract.fixed_intercept,
        insertionReference: contract.insertion_reference,
        resamples: effectiveResamples,
        seed: contract.uncertainty.seed,
        confidenceLevel: contract.uncertainty.confidence_level,
      });
      conditions[conditionId].bootstrap = bootstrap;
      if (bootstrap.status !== "ok") {
        failures.push({
          scope: "cluster_bootstrap",
          condition_id: conditionId,
          primary: contract.primary_condition_ids.includes(conditionId),
          failure_kind: bootstrap.failure_kind,
          details: bootstrap.failed_resample ?? null,
        });
      }
    }

    const primaryBlocked = failures.some((failure) => failure.primary);
    const analysisStatus = primaryBlocked
      ? "blocked"
      : protocolConformantResamples
        ? "complete"
        : "diagnostic_only";
    const payload = {
      schema_version: 1,
      artifact_kind: "reviewer_evaluator_sensitivity_analysis",
      analysis_status: analysisStatus,
      fail_closed: true,
      protocol_sha256: protocolSha256,
      input_content_sha256: input.content_sha256,
      protocol_conformant_resample_count: protocolConformantResamples,
      reference_condition_id: contract.reference_condition_id,
      condition_ids: contract.condition_ids,
      primary_condition_ids: contract.primary_condition_ids,
      secondary_condition_ids: contract.secondary_condition_ids,
      retrieval_depths: contract.retrieval_depths,
      observed_shape: {
        error_instances: countErrorInstances(input.rows),
        paper_clusters: inputMetadata.paper_ids.length,
        evaluation_cells: inputMetadata.row_count,
        identification_models: inputMetadata.identification_models.length,
        insertion_families: inputMetadata.insertion_families.length,
      },
      adjusted_ranking_contract: {
        fixed_intercept: contract.fixed_intercept,
        insertion_reference: contract.insertion_reference,
        same_insertion_identification_model_excluded: true,
        aggregate: "mean_identification_effect_over_retrieval_depths",
        estimator: "unpenalized_logistic_mle",
      },
      uncertainty_contract: {
        method: "percentile_cluster_bootstrap",
        cluster: "paper_id",
        resamples: effectiveResamples,
        protocol_resamples: contract.uncertainty.resamples,
        seed: contract.uncertainty.seed,
        confidence_level: contract.uncertainty.confidence_level,
        retains_cluster_multiplicity: true,
      },
      conditions,
      failures,
    };
    return withContentHash(payload);
  } catch (error) {
    if (!(error instanceof StatisticsInputError)) throw error;
    return withContentHash({
      schema_version: 1,
      artifact_kind: "reviewer_evaluator_sensitivity_analysis",
      analysis_status: "blocked",
      fail_closed: true,
      protocol_sha256: protocolSha256,
      input_content_sha256:
        typeof input?.content_sha256 === "string"
          ? input.content_sha256
          : null,
      protocol_conformant_resample_count: false,
      reference_condition_id: null,
      condition_ids: [],
      primary_condition_ids: [],
      secondary_condition_ids: [],
      retrieval_depths: [],
      observed_shape: null,
      adjusted_ranking_contract: null,
      uncertainty_contract: null,
      conditions: {},
      failures: [{
        scope: "input_or_protocol_validation",
        condition_id: null,
        primary: true,
        failure_kind: error.code,
        message: error.message,
        details: error.details,
      }],
    });
  }
}

function validateContentAddressedInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new StatisticsInputError(
      "missing_data",
      "input artifact must be an object",
    );
  }
  const declaredHash = requireString(
    input.content_sha256,
    "input.content_sha256",
  );
  const { content_sha256: ignored, ...payload } = input;
  const observedHash = hashCanonical(payload);
  if (declaredHash !== observedHash) {
    throw new StatisticsInputError(
      "content_hash_mismatch",
      "input artifact content_sha256 does not match its payload",
      {
        declared_sha256: declaredHash,
        observed_sha256: observedHash,
      },
    );
  }
}

function validateExpectedShape(rows, metadata, expected) {
  const observed = {
    error_instances: countErrorInstances(rows),
    paper_clusters: metadata.paper_ids.length,
    evaluation_cells: metadata.row_count,
  };
  for (const key of Object.keys(expected)) {
    if (observed[key] !== expected[key]) {
      throw new StatisticsInputError(
        "study_shape_mismatch",
        `${key} does not match the frozen protocol`,
        { expected: expected[key], observed: observed[key] },
      );
    }
  }
}

function countErrorInstances(rows) {
  return new Set(rows.map((row) => JSON.stringify([
    row.insertion_family ?? row.bundle_id,
    row.paper_id,
    String(row.claim_index),
  ]))).size;
}

function conditionRole(conditionId, contract) {
  if (contract.primary_roles[conditionId]) {
    return contract.primary_roles[conditionId];
  }
  return "secondary";
}

function withContentHash(payload) {
  return {
    ...payload,
    content_sha256: hashCanonical(payload),
  };
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StatisticsInputError(
      "invalid_protocol",
      `${label} must be a non-empty array`,
    );
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new StatisticsInputError(
      "invalid_protocol",
      `${label} must be a non-empty string`,
    );
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StatisticsInputError(
      "invalid_protocol",
      `${label} must be a positive integer`,
    );
  }
  return value;
}

function unsignedInteger(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new StatisticsInputError(
      "invalid_protocol",
      `${label} must be an unsigned 32-bit integer`,
    );
  }
  return value;
}

function unique(values) {
  return [...new Set(values)];
}
