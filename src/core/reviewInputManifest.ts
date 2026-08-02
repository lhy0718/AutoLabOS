import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { hashCanonical } from "./canonicalHash.js";
import {
  validateModelReviewBundle,
  type ModelReviewGateBinding
} from "./modelReviewProtocol.js";

export const REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH =
  "review/review_input_snapshot.json" as const;
export const REVIEW_INPUT_MANIFEST_RELATIVE_PATH =
  "review/review_input_manifest.json" as const;
export const REVIEW_GATE_REPORT_RELATIVE_PATH =
  "review/review_gate_report.json" as const;
export const REVIEW_HANDOFF_RELATIVE_PATH =
  "review/review_handoff.json" as const;
export const REVIEW_ASSURANCE_RELATIVE_PATH =
  "review/review_assurance.json" as const;
export const REVIEW_MODEL_BUNDLE_RELATIVE_PATH =
  "review/model_review_bundle.json" as const;

type ReviewInputSourceKind =
  | "canonical_analysis"
  | "deterministic_gate"
  | "resolved_review_snapshot"
  | "governance"
  | "experiment_evidence"
  | "literature_evidence"
  | "figure_audit"
  | "risk_signal";

interface ReviewInputDefinition {
  path: string;
  media_type: string;
  source_kind: ReviewInputSourceKind;
  always_required?: boolean;
}

export interface ReviewInputManifestEntry {
  path: string;
  media_type: string;
  source_kind: ReviewInputSourceKind;
  required: boolean;
  present: boolean;
  byte_length: number | null;
  sha256: string | null;
}

export interface ReviewInputManifest {
  schema_version: 1;
  artifact_kind: "review_input_manifest";
  run_id: string;
  research_cycle: number;
  checkpoint_seq: number;
  inputs: ReviewInputManifestEntry[];
  content_sha256: string;
}

export interface ReviewArtifactBinding {
  artifact_id: string;
  path: string;
  sha256: string;
  byte_length: number;
}

export interface ReviewGateReport {
  schema_version: 1;
  artifact_kind: "review_gate_report";
  run_id: string;
  deterministic_gate: ReviewArtifactBinding;
  input_manifest: ReviewArtifactBinding;
  content_sha256: string;
}

export interface ReviewHandoff {
  schema_version: 1;
  artifact_kind: "review_handoff";
  run_id: string;
  review_assurance: ReviewArtifactBinding;
  paper_critique: ReviewArtifactBinding;
  review_decision: ReviewArtifactBinding;
  review_packet: ReviewArtifactBinding;
  content_sha256: string;
}

export interface ReviewAssuranceArtifactRef {
  kind: "input_snapshot" | "input_manifest" | "gate_report" | "assurance" | "handoff" | "model_review_bundle";
  label: string;
  path: string;
}

export interface ReviewAssuranceInspection {
  status: "not_started" | "missing" | "valid" | "invalid";
  trusted: boolean;
  paper_ready_eligible: boolean;
  input_manifest_valid: boolean;
  gate_report_valid: boolean;
  assurance_valid: boolean;
  handoff_valid: boolean;
  model_review_bundle_valid: boolean;
  required_for_paper_ready: boolean;
  reason_codes: string[];
  artifact_refs: ReviewAssuranceArtifactRef[];
}

export interface ReviewInputManifestValidation {
  valid: boolean;
  reason_codes: string[];
}

const REVIEW_INPUT_DEFINITIONS = ([
  {
    path: "result_analysis.json",
    media_type: "application/json",
    source_kind: "canonical_analysis",
    always_required: true
  },
  {
    path: REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH,
    media_type: "application/json",
    source_kind: "resolved_review_snapshot",
    always_required: true
  },
  {
    path: "review/minimum_gate.json",
    media_type: "application/json",
    source_kind: "deterministic_gate",
    always_required: true
  },
  {
    path: "review/evidence_adequacy_reassessment.json",
    media_type: "application/json",
    source_kind: "deterministic_gate",
    always_required: true
  },
  {
    path: "governance/research_mode_guard.json",
    media_type: "application/json",
    source_kind: "governance",
    always_required: true
  },
  {
    path: "review/pre_review_summary.json",
    media_type: "application/json",
    source_kind: "resolved_review_snapshot",
    always_required: true
  },
  { path: "experiment_contract.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "baseline_summary.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "result_table.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "metrics.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "evidence_adequacy_contract.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "evidence_adequacy_execution_receipt.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "evidence_adequacy_assessment.json", media_type: "application/json", source_kind: "experiment_evidence" },
  { path: "experiment_plan.yaml", media_type: "application/yaml", source_kind: "experiment_evidence" },
  { path: "hypotheses.jsonl", media_type: "application/x-ndjson", source_kind: "experiment_evidence" },
  { path: "corpus.jsonl", media_type: "application/x-ndjson", source_kind: "literature_evidence" },
  { path: "paper_summaries.jsonl", media_type: "application/x-ndjson", source_kind: "literature_evidence" },
  { path: "evidence_store.jsonl", media_type: "application/x-ndjson", source_kind: "literature_evidence" },
  { path: "analyze_papers_richness_summary.json", media_type: "application/json", source_kind: "literature_evidence" },
  { path: "result_analysis_synthesis.json", media_type: "application/json", source_kind: "canonical_analysis" },
  { path: "analysis/risk_signals.json", media_type: "application/json", source_kind: "risk_signal" },
  { path: "figure_audit/figure_audit_summary.json", media_type: "application/json", source_kind: "figure_audit" },
  { path: "review/topic_probe_gate.json", media_type: "application/json", source_kind: "governance" },
  { path: "review/topic_probe_followup_handoff.json", media_type: "application/json", source_kind: "governance" },
  { path: "topic_probe_outcome.json", media_type: "application/json", source_kind: "governance" }
] satisfies ReviewInputDefinition[]).sort((left, right) => left.path.localeCompare(right.path));

export async function buildReviewInputManifest(input: {
  runDir: string;
  runId: string;
  researchCycle?: number;
  checkpointSeq?: number;
}): Promise<ReviewInputManifest> {
  const inputs = await Promise.all(
    REVIEW_INPUT_DEFINITIONS.map(async (definition): Promise<ReviewInputManifestEntry> => {
      const state = await readRegularFile(path.join(input.runDir, definition.path));
      const present = state.kind === "regular";
      return {
        path: definition.path,
        media_type: definition.media_type,
        source_kind: definition.source_kind,
        required: definition.always_required === true || present,
        present,
        byte_length: present ? state.bytes.length : null,
        sha256: present ? sha256(state.bytes) : null
      };
    })
  );
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "review_input_manifest" as const,
    run_id: input.runId,
    research_cycle: input.researchCycle ?? 0,
    checkpoint_seq: input.checkpointSeq ?? 0,
    inputs
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function serializeReviewInputManifest(manifest: ReviewInputManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export async function validateReviewInputManifestAtRest(input: {
  runDir: string;
  runId?: string;
  researchCycle?: number;
  checkpointSeq?: number;
}): Promise<ReviewInputManifestValidation> {
  const reasons: string[] = [];
  const manifestLoad = await readJsonFile(
    path.join(input.runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH)
  );
  if (!manifestLoad.present) {
    return {
      valid: false,
      reason_codes: ["review_input_manifest_missing"]
    };
  }
  const manifest = validateManifest(manifestLoad.value, input, reasons);
  if (!manifest) {
    reasons.push("review_input_manifest_invalid");
  } else {
    await validateManifestInputs(input.runDir, manifest, reasons);
  }
  const reasonCodes = uniqueStrings(reasons);
  return {
    valid: Boolean(manifest) && reasonCodes.length === 0,
    reason_codes: reasonCodes
  };
}

export async function buildReviewGateReport(input: {
  runDir: string;
  runId: string;
}): Promise<ReviewGateReport> {
  const minimumGate = await requireRegularFile(
    path.join(input.runDir, "review", "minimum_gate.json"),
    "review/minimum_gate.json"
  );
  const inputManifest = await requireRegularFile(
    path.join(input.runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH),
    REVIEW_INPUT_MANIFEST_RELATIVE_PATH
  );
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "review_gate_report" as const,
    run_id: input.runId,
    deterministic_gate: buildArtifactBinding(
      "review.minimum_gate",
      "review/minimum_gate.json",
      minimumGate
    ),
    input_manifest: buildArtifactBinding(
      "review.input_manifest",
      REVIEW_INPUT_MANIFEST_RELATIVE_PATH,
      inputManifest
    )
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function serializeReviewGateReport(report: ReviewGateReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export async function buildReviewHandoff(input: {
  runDir: string;
  runId: string;
}): Promise<ReviewHandoff> {
  const definitions = [
    {
      key: "review_assurance" as const,
      artifactId: "review.assurance",
      artifactPath: REVIEW_ASSURANCE_RELATIVE_PATH
    },
    {
      key: "paper_critique" as const,
      artifactId: "review.paper_critique",
      artifactPath: "review/paper_critique.json"
    },
    {
      key: "review_decision" as const,
      artifactId: "review.decision",
      artifactPath: "review/decision.json"
    },
    {
      key: "review_packet" as const,
      artifactId: "review.packet",
      artifactPath: "review/review_packet.json"
    }
  ];
  const entries = await Promise.all(definitions.map(async (definition) => ({
    key: definition.key,
    binding: buildArtifactBinding(
      definition.artifactId,
      definition.artifactPath,
      await requireRegularFile(
        path.join(input.runDir, definition.artifactPath),
        definition.artifactPath
      )
    )
  })));
  const bindings = Object.fromEntries(
    entries.map((entry) => [entry.key, entry.binding])
  ) as Omit<ReviewHandoff, "schema_version" | "artifact_kind" | "run_id" | "content_sha256">;
  const payload = {
    schema_version: 1 as const,
    artifact_kind: "review_handoff" as const,
    run_id: input.runId,
    ...bindings
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function serializeReviewHandoff(handoff: ReviewHandoff): string {
  return `${JSON.stringify(handoff, null, 2)}\n`;
}

export function buildModelReviewGateBinding(gateReportBytes: string | Buffer): ModelReviewGateBinding {
  return {
    artifact_id: "review.gate_report",
    sha256: sha256(gateReportBytes)
  };
}

export function buildReviewInputManifestBinding(
  manifestBytes: string | Buffer
): ModelReviewGateBinding {
  return {
    artifact_id: "review.input_manifest",
    sha256: sha256(manifestBytes)
  };
}

export async function inspectReviewAssuranceArtifacts(input: {
  runDir: string;
  runId?: string;
  researchCycle?: number;
  // Set only for same-checkpoint validation immediately after manifest creation.
  checkpointSeq?: number;
}): Promise<ReviewAssuranceInspection> {
  const reasons: string[] = [];
  const artifactRefs: ReviewAssuranceArtifactRef[] = [];
  const manifestLoad = await readJsonFile(path.join(input.runDir, REVIEW_INPUT_MANIFEST_RELATIVE_PATH));
  const gateReportLoad = await readJsonFile(path.join(input.runDir, REVIEW_GATE_REPORT_RELATIVE_PATH));
  const assuranceLoad = await readJsonFile(path.join(input.runDir, REVIEW_ASSURANCE_RELATIVE_PATH));
  const handoffLoad = await readJsonFile(path.join(input.runDir, REVIEW_HANDOFF_RELATIVE_PATH));
  const bundleLoad = await readJsonFile(path.join(input.runDir, REVIEW_MODEL_BUNDLE_RELATIVE_PATH));

  addArtifactRef(artifactRefs, manifestLoad.present, "input_manifest", "Review input manifest", REVIEW_INPUT_MANIFEST_RELATIVE_PATH);
  addArtifactRef(artifactRefs, gateReportLoad.present, "gate_report", "Review gate report", REVIEW_GATE_REPORT_RELATIVE_PATH);
  addArtifactRef(artifactRefs, assuranceLoad.present, "assurance", "Review assurance", REVIEW_ASSURANCE_RELATIVE_PATH);
  addArtifactRef(artifactRefs, handoffLoad.present, "handoff", "Review handoff", REVIEW_HANDOFF_RELATIVE_PATH);
  addArtifactRef(artifactRefs, bundleLoad.present, "model_review_bundle", "Model review bundle", REVIEW_MODEL_BUNDLE_RELATIVE_PATH);
  const snapshotPresent = (await readRegularFile(path.join(input.runDir, REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH))).kind === "regular";
  addArtifactRef(artifactRefs, snapshotPresent, "input_snapshot", "Review input snapshot", REVIEW_INPUT_SNAPSHOT_RELATIVE_PATH);

  const anyPresent = manifestLoad.present || gateReportLoad.present || assuranceLoad.present || handoffLoad.present || bundleLoad.present;
  if (!anyPresent) {
    return emptyInspection("missing", ["review_assurance_artifacts_missing"], artifactRefs);
  }

  const manifestReasonStart = reasons.length;
  const manifest = validateManifest(manifestLoad.value, input, reasons);
  if (!manifestLoad.present) reasons.push("review_input_manifest_missing");
  if (manifestLoad.present && !manifest) reasons.push("review_input_manifest_invalid");
  const manifestInputsValid = manifest
    ? await validateManifestInputs(input.runDir, manifest, reasons)
    : false;
  const inputManifestValid = Boolean(
    manifest && manifestInputsValid && reasons.length === manifestReasonStart
  );

  const gateReasonStart = reasons.length;
  const gateReport = validateGateReport(gateReportLoad.value, input.runId, reasons);
  if (!gateReportLoad.present) reasons.push("review_gate_report_missing");
  if (gateReportLoad.present && !gateReport) reasons.push("review_gate_report_invalid");
  const gateBindingsValid = gateReport
    ? await validateGateBindings(input.runDir, gateReport, reasons)
    : false;
  const gateReportValid = Boolean(
    gateReport && gateBindingsValid && inputManifestValid && reasons.length === gateReasonStart
  );

  const assuranceReasonStart = reasons.length;
  const assurance = validateAssurance(assuranceLoad.value, reasons);
  if (!assuranceLoad.present) reasons.push("review_assurance_missing");
  if (assuranceLoad.present && !assurance) reasons.push("review_assurance_invalid");

  const gateBytes = gateReportLoad.bytes;
  const manifestBytes = manifestLoad.bytes;
  if (assurance && gateBytes && assurance.gate_report_content_sha256 !== sha256(gateBytes)) {
    reasons.push("review_assurance_gate_report_binding_mismatch");
  }
  if (
    assurance
    && manifestBytes
    && assurance.review_input_manifest_content_sha256 !== sha256(manifestBytes)
  ) {
    reasons.push("review_assurance_input_manifest_binding_mismatch");
  }

  const expectedGate = gateBytes ? buildModelReviewGateBinding(gateBytes) : undefined;
  let modelReviewBundleValid = false;
  if (bundleLoad.present && expectedGate) {
    const validation = validateModelReviewBundle(bundleLoad.value, expectedGate);
    modelReviewBundleValid = validation.ok;
    if (!validation.ok) reasons.push("review_model_bundle_invalid");
    if (
      assurance?.model_review_bundle_content_sha256
      && hashCanonical(bundleLoad.value) !== assurance.model_review_bundle_content_sha256
    ) {
      reasons.push("review_assurance_model_bundle_binding_mismatch");
      modelReviewBundleValid = false;
    }
  }
  const requiredForPaperReady = assurance?.required_for_paper_ready === true;
  if (requiredForPaperReady && !bundleLoad.present) {
    reasons.push("review_model_bundle_missing");
  }
  if (
    assurance
    && assurance.model_review_bundle_valid !== modelReviewBundleValid
    && (requiredForPaperReady || bundleLoad.present)
  ) {
    reasons.push("review_assurance_model_bundle_status_mismatch");
  }
  const assuranceSelfValid = Boolean(
    assurance
    && reasons.length === assuranceReasonStart
    && (!requiredForPaperReady || modelReviewBundleValid)
  );

  const handoffReasonStart = reasons.length;
  const handoff = validateReviewHandoff(handoffLoad.value, input.runId, reasons);
  if (!handoffLoad.present) reasons.push("review_handoff_missing");
  if (handoffLoad.present && !handoff) reasons.push("review_handoff_invalid");
  const handoffBindingsValid = handoff
    ? await validateReviewHandoffBindings(input.runDir, handoff, reasons)
    : false;
  const handoffValid = Boolean(
    handoff && handoffBindingsValid && reasons.length === handoffReasonStart
  );

  const assuranceValid = Boolean(
    assuranceSelfValid
    && gateReportValid
    && inputManifestValid
  );
  const normalizedReasons = uniqueStrings(reasons);
  const trusted = assuranceValid && handoffValid && normalizedReasons.length === 0;
  const paperReadyEligible = trusted
    && (!requiredForPaperReady || assurance?.paper_ready_eligible === true);

  return {
    status: trusted ? "valid" : "invalid",
    trusted,
    paper_ready_eligible: paperReadyEligible,
    input_manifest_valid: inputManifestValid,
    gate_report_valid: gateReportValid,
    assurance_valid: assuranceValid,
    handoff_valid: handoffValid,
    model_review_bundle_valid: modelReviewBundleValid,
    required_for_paper_ready: requiredForPaperReady,
    reason_codes: normalizedReasons,
    artifact_refs: artifactRefs
  };
}

function validateManifest(
  value: unknown,
  expected: { runId?: string; researchCycle?: number; checkpointSeq?: number },
  reasons: string[]
): ReviewInputManifest | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || value.artifact_kind !== "review_input_manifest") {
    return undefined;
  }
  if (!hasExactKeys(value, [
    "schema_version",
    "artifact_kind",
    "run_id",
    "research_cycle",
    "checkpoint_seq",
    "inputs",
    "content_sha256"
  ])) {
    return undefined;
  }
  if (
    typeof value.run_id !== "string"
    || !Number.isInteger(value.research_cycle)
    || !Number.isInteger(value.checkpoint_seq)
    || !Array.isArray(value.inputs)
    || !isSha256(value.content_sha256)
  ) {
    return undefined;
  }
  const { content_sha256: _contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== value.content_sha256) {
    reasons.push("review_input_manifest_content_hash_mismatch");
  }
  if (expected.runId && value.run_id !== expected.runId) {
    reasons.push("review_input_manifest_run_mismatch");
  }
  if (
    expected.researchCycle !== undefined
    && value.research_cycle !== expected.researchCycle
  ) {
    reasons.push("review_input_manifest_research_cycle_mismatch");
  }
  if (
    expected.checkpointSeq !== undefined
    && value.checkpoint_seq !== expected.checkpointSeq
  ) {
    reasons.push("review_input_manifest_checkpoint_mismatch");
  }
  const inputs = value.inputs
    .map(parseManifestEntry)
    .filter((entry): entry is ReviewInputManifestEntry => Boolean(entry));
  if (inputs.length !== value.inputs.length) {
    reasons.push("review_input_manifest_entry_invalid");
    return undefined;
  }
  return {
    schema_version: 1,
    artifact_kind: "review_input_manifest",
    run_id: value.run_id,
    research_cycle: value.research_cycle as number,
    checkpoint_seq: value.checkpoint_seq as number,
    inputs,
    content_sha256: value.content_sha256
  };
}

async function validateManifestInputs(
  runDir: string,
  manifest: ReviewInputManifest,
  reasons: string[]
): Promise<boolean> {
  const definitions = new Map(REVIEW_INPUT_DEFINITIONS.map((definition) => [definition.path, definition]));
  const entries = new Map<string, ReviewInputManifestEntry>();
  for (const entry of manifest.inputs) {
    if (entries.has(entry.path)) reasons.push(`review_input_manifest_duplicate:${entry.path}`);
    entries.set(entry.path, entry);
  }
  for (const entry of manifest.inputs) {
    if (!definitions.has(entry.path)) reasons.push(`review_input_manifest_unexpected_path:${entry.path}`);
  }

  for (const definition of REVIEW_INPUT_DEFINITIONS) {
    const entry = entries.get(definition.path);
    if (!entry) {
      reasons.push(`review_input_manifest_path_missing:${definition.path}`);
      continue;
    }
    if (
      entry.media_type !== definition.media_type
      || entry.source_kind !== definition.source_kind
    ) {
      reasons.push(`review_input_manifest_metadata_mismatch:${definition.path}`);
    }
    const expectedRequired = definition.always_required === true || entry.present;
    if (entry.required !== expectedRequired) {
      reasons.push(`review_input_manifest_requiredness_mismatch:${definition.path}`);
    }
    const current = await readRegularFile(path.join(runDir, definition.path));
    if (entry.present) {
      if (current.kind !== "regular") {
        reasons.push(`review_input_changed:${definition.path}`);
        continue;
      }
      if (entry.byte_length !== current.bytes.length || entry.sha256 !== sha256(current.bytes)) {
        reasons.push(`review_input_changed:${definition.path}`);
      }
    } else {
      if (entry.byte_length !== null || entry.sha256 !== null) {
        reasons.push(`review_input_manifest_absent_binding_invalid:${definition.path}`);
      }
      if (current.kind !== "missing") {
        reasons.push(`review_input_newly_present:${definition.path}`);
      }
      if (definition.always_required) {
        reasons.push(`review_input_required_missing:${definition.path}`);
      }
    }
  }
  return !reasons.some((reason) =>
    reason.startsWith("review_input_")
  );
}

function validateGateReport(
  value: unknown,
  expectedRunId: string | undefined,
  reasons: string[]
): ReviewGateReport | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || value.artifact_kind !== "review_gate_report") {
    return undefined;
  }
  if (!hasExactKeys(value, [
    "schema_version",
    "artifact_kind",
    "run_id",
    "deterministic_gate",
    "input_manifest",
    "content_sha256"
  ])) {
    return undefined;
  }
  const deterministicGate = parseArtifactBinding(value.deterministic_gate);
  const inputManifest = parseArtifactBinding(value.input_manifest);
  if (
    typeof value.run_id !== "string"
    || !deterministicGate
    || !inputManifest
    || !isSha256(value.content_sha256)
  ) {
    return undefined;
  }
  const { content_sha256: _contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== value.content_sha256) {
    reasons.push("review_gate_report_content_hash_mismatch");
  }
  if (expectedRunId && value.run_id !== expectedRunId) {
    reasons.push("review_gate_report_run_mismatch");
  }
  return {
    schema_version: 1,
    artifact_kind: "review_gate_report",
    run_id: value.run_id,
    deterministic_gate: deterministicGate,
    input_manifest: inputManifest,
    content_sha256: value.content_sha256
  };
}

async function validateGateBindings(
  runDir: string,
  report: ReviewGateReport,
  reasons: string[]
): Promise<boolean> {
  const expected = [
    {
      binding: report.deterministic_gate,
      artifactId: "review.minimum_gate",
      artifactPath: "review/minimum_gate.json",
      reason: "review_gate_report_minimum_gate_binding_mismatch"
    },
    {
      binding: report.input_manifest,
      artifactId: "review.input_manifest",
      artifactPath: REVIEW_INPUT_MANIFEST_RELATIVE_PATH,
      reason: "review_gate_report_input_manifest_binding_mismatch"
    }
  ];
  let valid = true;
  for (const item of expected) {
    const current = await readRegularFile(path.join(runDir, item.artifactPath));
    if (
      item.binding.artifact_id !== item.artifactId
      || item.binding.path !== item.artifactPath
      || current.kind !== "regular"
      || item.binding.byte_length !== current.bytes.length
      || item.binding.sha256 !== sha256(current.bytes)
    ) {
      reasons.push(item.reason);
      valid = false;
    }
  }
  return valid;
}

function validateReviewHandoff(
  value: unknown,
  expectedRunId: string | undefined,
  reasons: string[]
): ReviewHandoff | undefined {
  if (!isRecord(value) || value.schema_version !== 1 || value.artifact_kind !== "review_handoff") {
    return undefined;
  }
  if (!hasExactKeys(value, [
    "schema_version",
    "artifact_kind",
    "run_id",
    "review_assurance",
    "paper_critique",
    "review_decision",
    "review_packet",
    "content_sha256"
  ])) {
    return undefined;
  }
  const reviewAssurance = parseArtifactBinding(value.review_assurance);
  const paperCritique = parseArtifactBinding(value.paper_critique);
  const reviewDecision = parseArtifactBinding(value.review_decision);
  const reviewPacket = parseArtifactBinding(value.review_packet);
  if (
    typeof value.run_id !== "string"
    || !reviewAssurance
    || !paperCritique
    || !reviewDecision
    || !reviewPacket
    || !isSha256(value.content_sha256)
  ) {
    return undefined;
  }
  const { content_sha256: _contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== value.content_sha256) {
    reasons.push("review_handoff_content_hash_mismatch");
  }
  if (expectedRunId && value.run_id !== expectedRunId) {
    reasons.push("review_handoff_run_mismatch");
  }
  return {
    schema_version: 1,
    artifact_kind: "review_handoff",
    run_id: value.run_id,
    review_assurance: reviewAssurance,
    paper_critique: paperCritique,
    review_decision: reviewDecision,
    review_packet: reviewPacket,
    content_sha256: value.content_sha256
  };
}

async function validateReviewHandoffBindings(
  runDir: string,
  handoff: ReviewHandoff,
  reasons: string[]
): Promise<boolean> {
  const expected = [
    {
      binding: handoff.review_assurance,
      artifactId: "review.assurance",
      artifactPath: REVIEW_ASSURANCE_RELATIVE_PATH,
      reason: "review_handoff_assurance_binding_mismatch"
    },
    {
      binding: handoff.paper_critique,
      artifactId: "review.paper_critique",
      artifactPath: "review/paper_critique.json",
      reason: "review_handoff_paper_critique_binding_mismatch"
    },
    {
      binding: handoff.review_decision,
      artifactId: "review.decision",
      artifactPath: "review/decision.json",
      reason: "review_handoff_decision_binding_mismatch"
    },
    {
      binding: handoff.review_packet,
      artifactId: "review.packet",
      artifactPath: "review/review_packet.json",
      reason: "review_handoff_packet_binding_mismatch"
    }
  ];
  let valid = true;
  for (const item of expected) {
    const current = await readRegularFile(path.join(runDir, item.artifactPath));
    if (
      item.binding.artifact_id !== item.artifactId
      || item.binding.path !== item.artifactPath
      || current.kind !== "regular"
      || item.binding.byte_length !== current.bytes.length
      || item.binding.sha256 !== sha256(current.bytes)
    ) {
      reasons.push(item.reason);
      valid = false;
    }
  }
  return valid;
}

interface ParsedReviewAssurance {
  required_for_paper_ready: boolean;
  paper_ready_eligible: boolean;
  model_review_bundle_valid: boolean;
  model_review_bundle_content_sha256: string | null;
  gate_report_content_sha256: string;
  review_input_manifest_content_sha256: string;
}

function validateAssurance(
  value: unknown,
  reasons: string[]
): ParsedReviewAssurance | undefined {
  if (
    !isRecord(value)
    || value.schema_version !== 1
    || typeof value.required_for_paper_ready !== "boolean"
    || typeof value.paper_ready_eligible !== "boolean"
    || typeof value.model_review_bundle_valid !== "boolean"
    || !isSha256(value.content_sha256)
    || !isSha256(value.gate_report_content_sha256)
    || !isSha256(value.review_input_manifest_content_sha256)
    || !(
      value.model_review_bundle_content_sha256 === null
      || isSha256(value.model_review_bundle_content_sha256)
    )
  ) {
    return undefined;
  }
  const { content_sha256: _contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== value.content_sha256) {
    reasons.push("review_assurance_content_hash_mismatch");
  }
  return {
    required_for_paper_ready: value.required_for_paper_ready,
    paper_ready_eligible: value.paper_ready_eligible,
    model_review_bundle_valid: value.model_review_bundle_valid,
    model_review_bundle_content_sha256: value.model_review_bundle_content_sha256,
    gate_report_content_sha256: value.gate_report_content_sha256,
    review_input_manifest_content_sha256: value.review_input_manifest_content_sha256
  };
}

function parseManifestEntry(value: unknown): ReviewInputManifestEntry | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    "path",
    "media_type",
    "source_kind",
    "required",
    "present",
    "byte_length",
    "sha256"
  ])) {
    return undefined;
  }
  if (
    typeof value.path !== "string"
    || typeof value.media_type !== "string"
    || !isReviewInputSourceKind(value.source_kind)
    || typeof value.required !== "boolean"
    || typeof value.present !== "boolean"
    || !(value.byte_length === null || (Number.isInteger(value.byte_length) && Number(value.byte_length) >= 0))
    || !(value.sha256 === null || isSha256(value.sha256))
  ) {
    return undefined;
  }
  return {
    path: value.path,
    media_type: value.media_type,
    source_kind: value.source_kind,
    required: value.required,
    present: value.present,
    byte_length: value.byte_length as number | null,
    sha256: value.sha256
  };
}

function parseArtifactBinding(value: unknown): ReviewArtifactBinding | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    "artifact_id",
    "path",
    "sha256",
    "byte_length"
  ])) {
    return undefined;
  }
  if (
    typeof value.artifact_id !== "string"
    || typeof value.path !== "string"
    || !isSha256(value.sha256)
    || !Number.isInteger(value.byte_length)
    || Number(value.byte_length) < 0
  ) {
    return undefined;
  }
  return {
    artifact_id: value.artifact_id,
    path: value.path,
    sha256: value.sha256,
    byte_length: value.byte_length as number
  };
}

function buildArtifactBinding(
  artifactId: string,
  artifactPath: string,
  bytes: Buffer
): ReviewArtifactBinding {
  return {
    artifact_id: artifactId,
    path: artifactPath,
    sha256: sha256(bytes),
    byte_length: bytes.length
  };
}

async function requireRegularFile(filePath: string, relativePath: string): Promise<Buffer> {
  const state = await readRegularFile(filePath);
  if (state.kind !== "regular") {
    throw new Error(`review assurance requires a regular file at ${relativePath}`);
  }
  return state.bytes;
}

type RegularFileState =
  | { kind: "regular"; bytes: Buffer }
  | { kind: "missing" }
  | { kind: "invalid" };

async function readRegularFile(filePath: string): Promise<RegularFileState> {
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { kind: "invalid" };
    }
    return { kind: "regular", bytes: await fs.readFile(filePath) };
  } catch (error) {
    return isMissingFileError(error) ? { kind: "missing" } : { kind: "invalid" };
  }
}

async function readJsonFile(filePath: string): Promise<{
  present: boolean;
  bytes?: Buffer;
  value?: unknown;
}> {
  const state = await readRegularFile(filePath);
  if (state.kind !== "regular") return { present: state.kind === "invalid" };
  try {
    return {
      present: true,
      bytes: state.bytes,
      value: JSON.parse(state.bytes.toString("utf8")) as unknown
    };
  } catch {
    return { present: true, bytes: state.bytes };
  }
}

function addArtifactRef(
  refs: ReviewAssuranceArtifactRef[],
  present: boolean,
  kind: ReviewAssuranceArtifactRef["kind"],
  label: string,
  artifactPath: string
): void {
  if (present) refs.push({ kind, label, path: artifactPath });
}

function emptyInspection(
  status: ReviewAssuranceInspection["status"],
  reasonCodes: string[],
  artifactRefs: ReviewAssuranceArtifactRef[]
): ReviewAssuranceInspection {
  return {
    status,
    trusted: false,
    paper_ready_eligible: false,
    input_manifest_valid: false,
    gate_report_valid: false,
    assurance_valid: false,
    handoff_valid: false,
    model_review_bundle_valid: false,
    required_for_paper_ready: false,
    reason_codes: reasonCodes,
    artifact_refs: artifactRefs
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isReviewInputSourceKind(value: unknown): value is ReviewInputSourceKind {
  return [
    "canonical_analysis",
    "deterministic_gate",
    "resolved_review_snapshot",
    "governance",
    "experiment_evidence",
    "literature_evidence",
    "figure_audit",
    "risk_signal"
  ].includes(String(value));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}
