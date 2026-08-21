import { createHash } from "node:crypto";

import { hashCanonical } from "../researchFunnel.js";
import type { RunSuccessorRelation } from "../../types.js";
import {
  resolveTopicProbeFollowupEvidenceStage,
  resolveTopicProbeFollowupMode,
  resolveTopicProbeSuccessorRelation,
  type TopicProbeFollowupEvidenceStage,
  type TopicProbeFollowupMode
} from "../topicProbeFollowup.js";
import type {
  TopicProbeOutcomeDisposition,
  TopicProbeOutcomeNextAction
} from "../topicProbeOutcome.js";

export const TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT =
  "governance/topic_probe_followup";
export const TOPIC_PROBE_SUCCESSOR_LINEAGE_MANIFEST_RELATIVE_PATH =
  `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/lineage_manifest.json`;

export const TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS = {
  sourceBrief: "brief/source_brief.md",
  activeContract:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/active_contract.json`,
  sourceCandidate:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/source_candidate.json`,
  sourcePortfolio:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/source_portfolio.json`,
  handoff: `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/handoff.json`,
  boundedOutcome:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/bounded_outcome.json`,
  outcomeGate:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/outcome_gate.json`,
  venueViability:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/venue_viability_report.json`,
  reviewGate:
    `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/review_gate.json`,
  receipt: `${TOPIC_PROBE_SUCCESSOR_GOVERNANCE_ROOT}/receipt.json`
} as const;

export interface TopicProbeSuccessorArtifactBinding {
  relative_path: string;
  file_sha256: string;
  content_sha256: string;
}

export interface TopicProbeSuccessorLineageManifest {
  schema_version: 3 | 4 | 5;
  artifact_kind: "topic_probe_successor_lineage_manifest";
  relation: RunSuccessorRelation;
  disposition: TopicProbeOutcomeDisposition;
  next_action: TopicProbeOutcomeNextAction;
  recommended_followup_mode: TopicProbeFollowupMode;
  evidence_stage: TopicProbeFollowupEvidenceStage;
  parent_run_id: string;
  parent_research_cycle: number;
  child_run_id: string;
  source_brief: TopicProbeSuccessorArtifactBinding;
  active_contract: TopicProbeSuccessorArtifactBinding;
  source_candidate: TopicProbeSuccessorArtifactBinding;
  source_portfolio: TopicProbeSuccessorArtifactBinding;
  handoff: TopicProbeSuccessorArtifactBinding;
  bounded_outcome: TopicProbeSuccessorArtifactBinding;
  outcome_gate?: TopicProbeSuccessorArtifactBinding;
  venue_viability?: TopicProbeSuccessorArtifactBinding;
  review_gate: TopicProbeSuccessorArtifactBinding;
  content_sha256: string;
}

export interface TopicProbeSuccessorArtifactSource {
  raw: string;
  contentSha256: string;
}

export interface BuildTopicProbeSuccessorLineageManifestInput {
  relation: RunSuccessorRelation;
  disposition: TopicProbeOutcomeDisposition;
  nextAction: TopicProbeOutcomeNextAction;
  recommendedFollowupMode: TopicProbeFollowupMode;
  evidenceStage: TopicProbeFollowupEvidenceStage;
  parentRunId: string;
  parentResearchCycle: number;
  childRunId: string;
  sourceBrief: TopicProbeSuccessorArtifactSource;
  activeContract: TopicProbeSuccessorArtifactSource;
  sourceCandidate: TopicProbeSuccessorArtifactSource;
  sourcePortfolio: TopicProbeSuccessorArtifactSource;
  handoff: TopicProbeSuccessorArtifactSource;
  boundedOutcome: TopicProbeSuccessorArtifactSource;
  outcomeGate: TopicProbeSuccessorArtifactSource;
  venueViability: TopicProbeSuccessorArtifactSource;
  reviewGate: TopicProbeSuccessorArtifactSource;
}

export interface TopicProbeSuccessorLineageManifestValidation {
  valid: boolean;
  reasons: string[];
  manifest?: TopicProbeSuccessorLineageManifest;
}

const MANIFEST_FIELDS = new Set([
  "schema_version",
  "artifact_kind",
  "relation",
  "disposition",
  "next_action",
  "recommended_followup_mode",
  "evidence_stage",
  "parent_run_id",
  "parent_research_cycle",
  "child_run_id",
  "source_brief",
  "active_contract",
  "source_candidate",
  "source_portfolio",
  "handoff",
  "bounded_outcome",
  "outcome_gate",
  "venue_viability",
  "review_gate",
  "content_sha256"
]);

const BINDING_FIELDS = new Set([
  "relative_path",
  "file_sha256",
  "content_sha256"
]);

export function buildTopicProbeSuccessorLineageManifest(
  input: BuildTopicProbeSuccessorLineageManifestInput
): TopicProbeSuccessorLineageManifest {
  const payload: Omit<TopicProbeSuccessorLineageManifest, "content_sha256"> = {
    schema_version: 5,
    artifact_kind: "topic_probe_successor_lineage_manifest",
    relation: input.relation,
    disposition: input.disposition,
    next_action: input.nextAction,
    recommended_followup_mode: input.recommendedFollowupMode,
    evidence_stage: input.evidenceStage,
    parent_run_id: input.parentRunId,
    parent_research_cycle: input.parentResearchCycle,
    child_run_id: input.childRunId,
    source_brief: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceBrief,
      input.sourceBrief
    ),
    active_contract: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract,
      input.activeContract
    ),
    source_candidate: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate,
      input.sourceCandidate
    ),
    source_portfolio: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourcePortfolio,
      input.sourcePortfolio
    ),
    handoff: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff,
      input.handoff
    ),
    bounded_outcome: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.boundedOutcome,
      input.boundedOutcome
    ),
    outcome_gate: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate,
      input.outcomeGate
    ),
    venue_viability: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.venueViability,
      input.venueViability
    ),
    review_gate: buildBinding(
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.reviewGate,
      input.reviewGate
    )
  };
  return {
    ...payload,
    content_sha256: hashCanonical(payload)
  };
}

export function serializeTopicProbeSuccessorLineageManifest(
  manifest: TopicProbeSuccessorLineageManifest
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function validateTopicProbeSuccessorLineageManifest(
  raw: string
): TopicProbeSuccessorLineageManifestValidation {
  if (!raw.trim()) {
    return {
      valid: false,
      reasons: ["topic_probe_successor_lineage_manifest_missing"]
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      valid: false,
      reasons: ["topic_probe_successor_lineage_manifest_invalid_json"]
    };
  }
  if (!isTopicProbeSuccessorLineageManifest(value)) {
    return {
      valid: false,
      reasons: ["topic_probe_successor_lineage_manifest_schema_invalid"]
    };
  }

  const reasons: string[] = [];
  const { content_sha256: contentSha256, ...payload } = value;
  if (hashCanonical(payload) !== contentSha256) {
    reasons.push("topic_probe_successor_lineage_manifest_content_hash_mismatch");
  }
  if (value.relation !== resolveTopicProbeSuccessorRelation(value.next_action)) {
    reasons.push("topic_probe_successor_lineage_relation_mismatch");
  }
  if (
    value.recommended_followup_mode
    !== resolveTopicProbeFollowupMode(value.next_action)
  ) {
    reasons.push("topic_probe_successor_lineage_mode_mismatch");
  }
  if (
    value.evidence_stage
    !== resolveTopicProbeFollowupEvidenceStage(
      value.disposition,
      value.next_action
    )
  ) {
    reasons.push("topic_probe_successor_lineage_evidence_stage_mismatch");
  }
  for (const [name, binding, expectedPath] of artifactBindingEntries(value)) {
    if (binding.relative_path !== expectedPath) {
      reasons.push(
        `topic_probe_successor_lineage_manifest_path_mismatch:${name}`
      );
    }
  }
  return {
    valid: reasons.length === 0,
    reasons,
    manifest: value
  };
}

export function hashArtifactBytes(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function buildBinding(
  relativePath: string,
  source: TopicProbeSuccessorArtifactSource
): TopicProbeSuccessorArtifactBinding {
  if (!isSha256(source.contentSha256)) {
    throw new Error("topic_probe_successor_lineage_content_hash_invalid");
  }
  return {
    relative_path: relativePath,
    file_sha256: hashArtifactBytes(source.raw),
    content_sha256: source.contentSha256
  };
}

function artifactBindingEntries(
  manifest: TopicProbeSuccessorLineageManifest
): Array<
  readonly [
    string,
    TopicProbeSuccessorArtifactBinding,
    string
  ]
> {
  return [
    [
      "source_brief",
      manifest.source_brief,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceBrief
    ],
    [
      "active_contract",
      manifest.active_contract,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.activeContract
    ],
    [
      "source_candidate",
      manifest.source_candidate,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourceCandidate
    ],
    [
      "source_portfolio",
      manifest.source_portfolio,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.sourcePortfolio
    ],
    [
      "handoff",
      manifest.handoff,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.handoff
    ],
    [
      "bounded_outcome",
      manifest.bounded_outcome,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.boundedOutcome
    ],
    ...(manifest.outcome_gate
      ? [[
          "outcome_gate",
          manifest.outcome_gate,
          TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.outcomeGate
        ] as const]
      : []),
    ...(manifest.venue_viability
      ? [[
          "venue_viability",
          manifest.venue_viability,
          TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.venueViability
        ] as const]
      : []),
    [
      "review_gate",
      manifest.review_gate,
      TOPIC_PROBE_SUCCESSOR_ARTIFACT_PATHS.reviewGate
    ]
  ];
}

function isTopicProbeSuccessorLineageManifest(
  value: unknown
): value is TopicProbeSuccessorLineageManifest {
  return isRecord(value)
    && hasOnlyKnownFields(value, MANIFEST_FIELDS)
    && (
      value.schema_version === 3
      || value.schema_version === 4
      || value.schema_version === 5
    )
    && value.artifact_kind === "topic_probe_successor_lineage_manifest"
    && isRunSuccessorRelation(value.relation)
    && isDisposition(value.disposition)
    && isNextAction(value.next_action)
    && isFollowupMode(value.recommended_followup_mode)
    && isEvidenceStage(value.evidence_stage)
    && hasText(value.parent_run_id)
    && isNonNegativeInteger(value.parent_research_cycle)
    && hasText(value.child_run_id)
    && isArtifactBinding(value.source_brief)
    && isArtifactBinding(value.active_contract)
    && isArtifactBinding(value.source_candidate)
    && isArtifactBinding(value.source_portfolio)
    && isArtifactBinding(value.handoff)
    && isArtifactBinding(value.bounded_outcome)
    && (value.schema_version === 3
      ? value.outcome_gate === undefined
      : isArtifactBinding(value.outcome_gate))
    && (value.schema_version === 5
      ? isArtifactBinding(value.venue_viability)
      : value.venue_viability === undefined)
    && isArtifactBinding(value.review_gate)
    && isSha256(value.content_sha256);
}

function isArtifactBinding(
  value: unknown
): value is TopicProbeSuccessorArtifactBinding {
  return isRecord(value)
    && hasOnlyKnownFields(value, BINDING_FIELDS)
    && hasText(value.relative_path)
    && isSha256(value.file_sha256)
    && isSha256(value.content_sha256);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKnownFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>
): boolean {
  return Object.keys(value).every((field) => fields.has(field));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRunSuccessorRelation(value: unknown): value is RunSuccessorRelation {
  return value === "topic_probe_confirmatory"
    || value === "topic_probe_repeat"
    || value === "topic_probe_deferred_candidate"
    || value === "topic_probe_portfolio_refresh"
    || value === "topic_probe_evidence_repair";
}

function isDisposition(value: unknown): value is TopicProbeOutcomeDisposition {
  return value === "promote_to_confirmatory"
    || value === "reject_candidate"
    || value === "repeat_probe"
    || value === "blocked_invalid_evidence";
}

function isNextAction(value: unknown): value is TopicProbeOutcomeNextAction {
  return value === "start_confirmatory_run"
    || value === "try_deferred_candidate"
    || value === "refresh_topic_portfolio"
    || value === "repeat_bounded_probe"
    || value === "repair_probe_evidence";
}

function isFollowupMode(value: unknown): value is TopicProbeFollowupMode {
  return value === "hypothesis_test" || value === "topic_discovery";
}

function isEvidenceStage(value: unknown): value is TopicProbeFollowupEvidenceStage {
  return value === "confirmatory"
    || value === "bounded_probe"
    || value === "topic_refresh";
}
