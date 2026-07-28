import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FORMAT_TAG = /\[(?:BOLD|BLUE|ITALIC|UNDERLINE)\]/gi;
const DIRECTION_MARK = /[↑↓]/g;
const STRICT_SCALAR = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseNumericScalar(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value)
    .replace(FORMAT_TAG, "")
    .replaceAll(",", "")
    .replaceAll("%", "")
    .replaceAll("−", "-")
    .trim();
  if (!STRICT_SCALAR.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

export function parseDirection(columnName) {
  if (typeof columnName !== "string") return null;
  const marks = columnName.match(DIRECTION_MARK) ?? [];
  if (marks.length !== 1) return null;
  return marks[0] === "↑" ? "higher" : "lower";
}

function requireTable(value, claimId) {
  if (
    !value ||
    !Array.isArray(value.table_column_names) ||
    !Array.isArray(value.table_content_values)
  ) {
    throw new Error(`${claimId} has an unsupported table JSON schema`);
  }
  const width = value.table_column_names.length;
  if (width < 2) throw new Error(`${claimId} has fewer than two columns`);
  if (
    value.table_content_values.some(
      (row) => !Array.isArray(row) || row.length !== width,
    )
  ) {
    throw new Error(`${claimId} has a ragged table`);
  }
  return value;
}

function canonicalTableHash(table) {
  return sha256(JSON.stringify({
    caption: table.table_caption ?? "",
    columns: table.table_column_names,
    rows: table.table_content_values,
  }));
}

function inspectDirectionalColumn(table, columnIndex) {
  const values = [];
  for (const row of table.table_content_values) {
    const rowLabel = typeof row[0] === "string" ? row[0].trim() : "";
    const value = parseNumericScalar(row[columnIndex]);
    if (!rowLabel || value === null) continue;
    values.push({ row_label: rowLabel, value });
  }
  const distinctValues = new Set(values.map((item) => item.value));
  return {
    numeric_row_count: values.length,
    distinct_value_count: distinctValues.size,
    eligible: values.length >= 2 && distinctValues.size >= 2,
  };
}
export function auditMetricPolarityCorpus({
  metadataRaw,
  tablesDirectory,
  source,
  thresholds = {},
}) {
  const metadata = JSON.parse(metadataRaw);
  if (!Array.isArray(metadata)) {
    throw new Error("SciClaimEval metadata must be a JSON array");
  }

  const minimumFamilyCount = thresholds.minimum_family_count ?? 100;
  const minimumPaperCount = thresholds.minimum_paper_count ?? 30;
  const minimumLowerDirectionCount =
    thresholds.minimum_lower_direction_count ?? 20;

  const supportedTableRows = metadata.filter(
    (item) => item?.evi_type === "table" && item?.label === "Supported",
  );
  const exclusions = new Map();
  const families = [];
  const tableHashes = new Set();
  const eligiblePaperIds = new Set();
  const licenseCounts = new Map();

  const exclude = (reason) => {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
  };

  for (const item of supportedTableRows) {
    const claimId = item?.claim_id;
    if (typeof claimId !== "string" || claimId.trim() === "") {
      exclude("missing_claim_id");
      continue;
    }
    let table;
    try {
      table = requireTable(
        JSON.parse(
          readFileSync(join(tablesDirectory, `${claimId}.json`), "utf8"),
        ),
        claimId,
      );
    } catch {
      exclude("missing_or_invalid_table_json");
      continue;
    }

    const tableHash = canonicalTableHash(table);
    if (tableHashes.has(tableHash)) {
      exclude("duplicate_table_content");
      continue;
    }
    tableHashes.add(tableHash);

    const tableFamilies = [];
    for (
      let columnIndex = 1;
      columnIndex < table.table_column_names.length;
      columnIndex += 1
    ) {
      const columnName = table.table_column_names[columnIndex];
      const direction = parseDirection(columnName);
      if (!direction) continue;
      const inspection = inspectDirectionalColumn(table, columnIndex);
      if (!inspection.eligible) {
        exclude("directional_column_without_two_distinct_numeric_rows");
        continue;
      }
      tableFamilies.push({
        family_id: sha256(
          `${item.paper_id}\n${item.claim_id_pair}\n${tableHash}\n${columnIndex}`,
        ).slice(0, 24),
        paper_id: item.paper_id,
        claim_id: claimId,
        claim_pair_id: item.claim_id_pair,
        table_sha256: tableHash,
        column_index: columnIndex,
        column_name: columnName,
        direction,
        ...inspection,
      });
    }

    if (tableFamilies.length === 0) {
      exclude("no_eligible_explicit_direction_column");
      continue;
    }
    families.push(...tableFamilies);
    eligiblePaperIds.add(item.paper_id);
    const license = item.license_name || "unknown";
    licenseCounts.set(license, (licenseCounts.get(license) ?? 0) + 1);
  }

  const higherCount = families.filter(
    (family) => family.direction === "higher",
  ).length;
  const lowerCount = families.filter(
    (family) => family.direction === "lower",
  ).length;
  const gates = {
    minimum_family_count: {
      observed: families.length,
      required: minimumFamilyCount,
      pass: families.length >= minimumFamilyCount,
    },
    minimum_paper_count: {
      observed: eligiblePaperIds.size,
      required: minimumPaperCount,
      pass: eligiblePaperIds.size >= minimumPaperCount,
    },
    minimum_lower_direction_count: {
      observed: lowerCount,
      required: minimumLowerDirectionCount,
      pass: lowerCount >= minimumLowerDirectionCount,
    },
  };
  const corpusEligible = Object.values(gates).every((gate) => gate.pass);

  return {
    schema_version: "1.0",
    artifact_type: "metric_polarity_corpus_preflight",
    generated_without_model_outputs: true,
    source,
    metadata_sha256: sha256(metadataRaw),
    metadata_row_count: metadata.length,
    supported_table_row_count: supportedTableRows.length,
    unique_loaded_table_count: tableHashes.size,
    eligible_family_count: families.length,
    eligible_paper_count: eligiblePaperIds.size,
    direction_counts: {
      higher: higherCount,
      lower: lowerCount,
    },
    license_counts: Object.fromEntries(
      [...licenseCounts.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    exclusion_counts: Object.fromEntries(
      [...exclusions.entries()].sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
    gates,
    corpus_eligible: corpusEligible,
    decision: corpusEligible
      ? "protocol_freeze_may_proceed"
      : "kill_candidate_for_insufficient_independent_corpus",
    families,
  };
}
