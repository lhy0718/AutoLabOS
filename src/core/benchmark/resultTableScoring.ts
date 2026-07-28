import {
  validateResultsArtifactV2,
  validateResultsTableSchema,
  type ResultsArtifactV2,
  type ResultsTableDirection,
  type ResultsTableSchema
} from "../analysis/resultsTableSchema.js";

export interface ResultTableScoringIssue {
  code: string;
  row_index: number | null;
  metric?: string;
  message: string;
}

export interface ResultTableScore {
  measured: boolean;
  valid_schema: boolean;
  row_count: number;
  complete_row_count: number;
  missing_metric_count: number;
  missing_baseline_count: number;
  missing_comparator_count: number;
  missing_delta_count: number;
  comparator_coverage: number | null;
  comparative_claim_supported: boolean;
  superiority_claim_supported: boolean;
  issues: ResultTableScoringIssue[];
}

interface ResultTableClaimAuthorization {
  comparativeClaimAuthorized?: boolean;
  superiorityClaimAuthorized?: boolean;
  superiorityPrimaryMetrics?: readonly string[];
  primaryComparisonId?: string;
}

interface CanonicalComparisonRow {
  comparisonId: string;
  metricId: string;
  direction: ResultsTableDirection;
  observedDelta: number;
}

export function scoreResultTableArtifact(
  value: unknown,
  authorization: ResultTableClaimAuthorization = {}
): ResultTableScore {
  if (Array.isArray(value)) {
    return scoreHistoricalV1Rows(value, authorization);
  }
  return scoreCanonicalV2Artifact(value, authorization);
}

function scoreCanonicalV2Artifact(
  value: unknown,
  authorization: ResultTableClaimAuthorization
): ResultTableScore {
  const validation = validateResultsArtifactV2(value);
  const validationIssues = validation.issues.map((message) => ({
    code: "result_table_schema_invalid",
    row_index: extractRowIndex(message),
    message
  }));

  if (!validation.valid) {
    return unmeasuredScore(false, validationIssues);
  }

  const artifact = value as ResultsArtifactV2;
  const resolved = resolveCanonicalComparisonRows(artifact);
  if (resolved.issues.length > 0) {
    return unmeasuredScore(false, resolved.issues);
  }

  const rows = resolved.rows;
  const primaryMetricIds = new Set(
    (authorization.superiorityPrimaryMetrics ?? [])
      .map((metricId) => metricId.trim())
      .filter(Boolean)
  );
  const primaryComparisonId = authorization.primaryComparisonId?.trim();
  const primaryComparison = primaryComparisonId
    ? rows.find((row) => row.comparisonId === primaryComparisonId)
    : undefined;
  const claimSelectionIssues: ResultTableScoringIssue[] = [];
  if (authorization.comparativeClaimAuthorized === true && !primaryComparisonId) {
    claimSelectionIssues.push({
      code: "result_table_primary_comparison_missing",
      row_index: null,
      message: "Canonical V2 comparative claims require an explicit primaryComparisonId bound from ResultsPlanV2.primary_comparison_id."
    });
  } else if (primaryComparisonId && !primaryComparison) {
    claimSelectionIssues.push({
      code: "result_table_primary_comparison_invalid",
      row_index: null,
      message: `The explicit primaryComparisonId "${primaryComparisonId}" does not resolve to a ResultsArtifactV2 comparison.`
    });
  }
  const favorablePrimaryComparisonPresent = Boolean(
    primaryComparison
    && primaryMetricIds.has(primaryComparison.metricId)
    && (primaryComparison.direction === "higher_better"
      ? primaryComparison.observedDelta > 0
      : primaryComparison.observedDelta < 0)
  );
  const comparativeClaimSupported =
    rows.length > 0
    && authorization.comparativeClaimAuthorized === true
    && primaryComparison !== undefined;

  return {
    measured: rows.length > 0,
    valid_schema: true,
    row_count: rows.length,
    complete_row_count: rows.length,
    missing_metric_count: 0,
    missing_baseline_count: 0,
    missing_comparator_count: 0,
    missing_delta_count: 0,
    comparator_coverage: rows.length > 0 ? 1 : null,
    comparative_claim_supported: comparativeClaimSupported,
    superiority_claim_supported:
      comparativeClaimSupported
      && authorization.superiorityClaimAuthorized === true
      && primaryMetricIds.size > 0
      && favorablePrimaryComparisonPresent,
    issues: claimSelectionIssues
  };
}

function resolveCanonicalComparisonRows(artifact: ResultsArtifactV2): {
  rows: CanonicalComparisonRow[];
  issues: ResultTableScoringIssue[];
} {
  const metricsById = new Map(artifact.metrics.map((metric) => [metric.id, metric]));
  const observationsById = new Map(
    artifact.observations.map((observation) => [observation.id, observation])
  );
  const rows: CanonicalComparisonRow[] = [];
  const issues: ResultTableScoringIssue[] = [];

  artifact.comparisons.forEach((comparison, index) => {
    const subject = observationsById.get(comparison.subject_observation_id);
    const reference = observationsById.get(comparison.reference_observation_id);
    if (!subject || !reference) {
      issues.push({
        code: "result_table_comparison_reference_invalid",
        row_index: index,
        message: `results_artifact.comparisons[${index}] must reference one explicit subject observation and one explicit reference observation.`
      });
      return;
    }
    if (subject.metric_id !== reference.metric_id) {
      issues.push({
        code: "result_table_comparison_reference_invalid",
        row_index: index,
        message: `results_artifact.comparisons[${index}] must reference observations for one explicit metric id.`
      });
      return;
    }

    const metric = metricsById.get(subject.metric_id);
    if (!metric) {
      issues.push({
        code: "result_table_comparison_reference_invalid",
        row_index: index,
        metric: subject.metric_id,
        message: `results_artifact.comparisons[${index}] references undefined metric id "${subject.metric_id}".`
      });
      return;
    }

    rows.push({
      comparisonId: comparison.id,
      metricId: metric.id,
      direction: metric.direction,
      observedDelta: subject.value - reference.value
    });
  });

  return { rows, issues };
}

function scoreHistoricalV1Rows(
  value: unknown[],
  authorization: ResultTableClaimAuthorization
): ResultTableScore {
  const validation = validateResultsTableSchema(value);
  const rows = validation.rows;
  const schemaIssues: ResultTableScoringIssue[] = validation.issues.map((message) => ({
    code: "result_table_schema_invalid",
    row_index: extractRowIndex(message),
    message
  }));
  const completenessIssues: ResultTableScoringIssue[] = [];

  rows.forEach((row, index) => {
    if (!row.metric.trim()) {
      completenessIssues.push({
        code: "result_table_metric_missing",
        row_index: index,
        message: `results_table[${index}] must name the metric.`
      });
    }
    if (row.baseline === null) {
      completenessIssues.push({
        code: "result_table_baseline_missing",
        row_index: index,
        metric: row.metric,
        message: `results_table[${index}] (${row.metric || "unknown metric"}) is missing a baseline value.`
      });
    }
    if (row.comparator === null) {
      completenessIssues.push({
        code: "result_table_comparator_missing",
        row_index: index,
        metric: row.metric,
        message: `results_table[${index}] (${row.metric || "unknown metric"}) is missing a comparator value.`
      });
    }
    if (row.delta === null) {
      completenessIssues.push({
        code: "result_table_delta_missing",
        row_index: index,
        metric: row.metric,
        message: `results_table[${index}] (${row.metric || "unknown metric"}) is missing a delta value.`
      });
    }
  });

  const completeRows = rows.filter(isCompleteRow);
  const primaryMetrics = new Set(
    (authorization.superiorityPrimaryMetrics ?? [])
      .map((metric) => metric.trim())
      .filter(Boolean)
  );
  const favorablePrimaryRows = completeRows.filter((row) =>
    primaryMetrics.has(row.metric)
    && deltaMatchesObservedEffect(row)
    && (row.direction === "higher_better" ? row.delta! > 0 : row.delta! < 0)
  );
  const validSchema =
    validation.valid
    && schemaIssues.length === 0
    && completenessIssues.length === 0;
  const comparativeClaimSupported =
    validSchema
    && completeRows.length > 0
    && authorization.comparativeClaimAuthorized === true;

  return {
    measured: true,
    valid_schema: validSchema,
    row_count: rows.length,
    complete_row_count: completeRows.length,
    missing_metric_count: rows.filter((row) => !row.metric.trim()).length,
    missing_baseline_count: rows.filter((row) => row.baseline === null).length,
    missing_comparator_count: rows.filter((row) => row.comparator === null).length,
    missing_delta_count: rows.filter((row) => row.delta === null).length,
    comparator_coverage: rows.length > 0 ? round2(completeRows.length / rows.length) : null,
    comparative_claim_supported: comparativeClaimSupported,
    superiority_claim_supported:
      comparativeClaimSupported
      && authorization.superiorityClaimAuthorized === true
      && primaryMetrics.size > 0
      && favorablePrimaryRows.length > 0,
    issues: [
      {
        code: "result_table_schema_v1_historical_reader",
        row_index: null,
        message: "Historical V1 array reader compatibility was used; new result artifacts must use ResultsArtifactV2."
      },
      ...schemaIssues,
      ...completenessIssues
    ]
  };
}

function unmeasuredScore(
  validSchema: boolean,
  issues: ResultTableScoringIssue[]
): ResultTableScore {
  return {
    measured: false,
    valid_schema: validSchema,
    row_count: 0,
    complete_row_count: 0,
    missing_metric_count: 0,
    missing_baseline_count: 0,
    missing_comparator_count: 0,
    missing_delta_count: 0,
    comparator_coverage: null,
    comparative_claim_supported: false,
    superiority_claim_supported: false,
    issues
  };
}

function deltaMatchesObservedEffect(row: ResultsTableSchema[number]): boolean {
  if (row.baseline === null || row.comparator === null || row.delta === null) return false;
  return Math.abs(row.delta - (row.comparator - row.baseline)) <= 1e-9;
}

function isCompleteRow(row: ResultsTableSchema[number]): boolean {
  return Boolean(row.metric.trim())
    && row.baseline !== null
    && row.comparator !== null
    && row.delta !== null;
}

function extractRowIndex(message: string): number | null {
  const match = message.match(
    /(?:results_table|results_artifact\.comparisons)\[(\d+)\]/u
  );
  return match ? Number(match[1]) : null;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
