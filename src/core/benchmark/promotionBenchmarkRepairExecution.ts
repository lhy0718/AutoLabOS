export const PROMOTION_REPAIR_EXECUTION_PROTOCOL = "case-artifact-only-node-repair-v1";

export interface PromotionRepairExecutionAttempt {
  pair_kind: "fault_repair" | "clean_control";
  source_case_id: string;
  repaired_case_id: string;
  source_prediction_sha256: string;
  declared_repair_owner: "run_experiments" | "analyze_results" | "figure_audit" | null;
  adapter_revision: string | null;
  status: "repaired" | "unchanged";
  started_at: string;
  completed_at: string;
  input_artifact_sha256: string;
  output_artifact_sha256: string;
  changed_paths: string[];
}

export interface PromotionRepairExecutionManifest {
  schema_version: "1.0";
  protocol: typeof PROMOTION_REPAIR_EXECUTION_PROTOCOL;
  study_id: string;
  backend: "builtin_node_adapter";
  allowed_input_boundary: ["case_artifact", "source_prediction"];
  prohibited_input_boundary: ["source_gold", "sibling_clean_artifact", "oracle_manifests"];
  source_suite_sha256: string;
  source_predictions_sha256: string;
  source_system_run_manifest_sha256: string;
  repaired_suite_sha256: string;
  repaired_predictions_sha256: string;
  repaired_system_run_manifest_sha256: string;
  generated_at: string;
  repair_attempt_count: number;
  successful_repair_count: number;
  clean_control_count: number;
  attempts: PromotionRepairExecutionAttempt[];
}

export function parsePromotionRepairExecutionManifest(value: unknown): PromotionRepairExecutionManifest {
  if (!isRecord(value)) throw new Error("Repair execution manifest must be an object.");
  assertExactKeys(value, [
    "schema_version",
    "protocol",
    "study_id",
    "backend",
    "allowed_input_boundary",
    "prohibited_input_boundary",
    "source_suite_sha256",
    "source_predictions_sha256",
    "source_system_run_manifest_sha256",
    "repaired_suite_sha256",
    "repaired_predictions_sha256",
    "repaired_system_run_manifest_sha256",
    "generated_at",
    "repair_attempt_count",
    "successful_repair_count",
    "clean_control_count",
    "attempts"
  ], "repair execution manifest");
  if (value.schema_version !== "1.0" || value.protocol !== PROMOTION_REPAIR_EXECUTION_PROTOCOL
      || !portableIdentifier(value.study_id) || value.backend !== "builtin_node_adapter"
      || !exactStringArray(value.allowed_input_boundary, ["case_artifact", "source_prediction"])
      || !exactStringArray(value.prohibited_input_boundary, [
        "source_gold",
        "sibling_clean_artifact",
        "oracle_manifests"
      ])
      || !isSha256(value.source_suite_sha256) || !isSha256(value.source_predictions_sha256)
      || !isSha256(value.source_system_run_manifest_sha256) || !isSha256(value.repaired_suite_sha256)
      || !isSha256(value.repaired_predictions_sha256) || !isSha256(value.repaired_system_run_manifest_sha256)
      || !validTimestamp(value.generated_at) || !nonNegativeInteger(value.repair_attempt_count)
      || !nonNegativeInteger(value.successful_repair_count) || !nonNegativeInteger(value.clean_control_count)
      || !Array.isArray(value.attempts)) {
    throw new Error("Repair execution manifest has an invalid schema.");
  }
  const attempts = value.attempts.map(parseAttempt);
  if (attempts.length !== value.repair_attempt_count
      || attempts.filter((attempt) => attempt.status === "repaired").length !== value.successful_repair_count
      || attempts.filter((attempt) => attempt.pair_kind === "clean_control").length !== value.clean_control_count
      || new Set(attempts.map((attempt) => attempt.source_case_id)).size !== attempts.length
      || new Set(attempts.map((attempt) => attempt.repaired_case_id)).size !== attempts.length) {
    throw new Error("Repair execution manifest attempt coverage is invalid.");
  }
  return value as unknown as PromotionRepairExecutionManifest;
}

function parseAttempt(value: unknown): PromotionRepairExecutionAttempt {
  if (!isRecord(value)) throw new Error("Repair execution attempt must be an object.");
  assertExactKeys(value, [
    "pair_kind",
    "source_case_id",
    "repaired_case_id",
    "source_prediction_sha256",
    "declared_repair_owner",
    "adapter_revision",
    "status",
    "started_at",
    "completed_at",
    "input_artifact_sha256",
    "output_artifact_sha256",
    "changed_paths"
  ], "repair execution attempt");
  const owner = value.declared_repair_owner;
  if ((value.pair_kind !== "fault_repair" && value.pair_kind !== "clean_control")
      || !portableIdentifier(value.source_case_id) || !portableIdentifier(value.repaired_case_id)
      || !isSha256(value.source_prediction_sha256)
      || (owner !== null && owner !== "run_experiments" && owner !== "analyze_results" && owner !== "figure_audit")
      || (value.adapter_revision !== null && !nonEmptyString(value.adapter_revision))
      || (value.status !== "repaired" && value.status !== "unchanged")
      || !validTimestamp(value.started_at) || !validTimestamp(value.completed_at)
      || Date.parse(value.completed_at) < Date.parse(value.started_at)
      || !isSha256(value.input_artifact_sha256) || !isSha256(value.output_artifact_sha256)
      || !Array.isArray(value.changed_paths) || value.changed_paths.some((item) => !safeRelativePath(item))) {
    throw new Error("Repair execution attempt has an invalid schema.");
  }
  if (value.pair_kind === "fault_repair"
      && (owner === null || value.adapter_revision === null || value.status !== "repaired"
        || value.changed_paths.length === 0 || value.input_artifact_sha256 === value.output_artifact_sha256)) {
    throw new Error("Fault repair execution attempt did not record a materialized node repair.");
  }
  if (value.pair_kind === "clean_control"
      && (owner !== null || value.adapter_revision !== null || value.status !== "unchanged"
        || value.changed_paths.length !== 0 || value.input_artifact_sha256 !== value.output_artifact_sha256)) {
    throw new Error("Clean-control execution attempt must remain unchanged.");
  }
  return value as unknown as PromotionRepairExecutionAttempt;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new Error(`${label} has unexpected fields.`);
  }
}

function exactStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length
    && value.every((item, index) => item === expected[index]);
}

function safeRelativePath(value: unknown): value is string {
  return nonEmptyString(value) && !value.startsWith("/") && !value.includes("\\")
    && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
