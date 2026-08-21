import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";

import {
  buildPaperReadinessBundleArtifact,
  buildReviewReportArtifact,
  validateResearchGovernanceArtifact,
  type EvidenceBundleArtifact,
  type EvidenceBundleFile,
  type GateReportArtifact,
  type PaperReadinessBundleArtifact,
  type ReviewReportArtifact
} from "./researchGovernanceArtifacts.js";
import { parseModelReviewBundle } from "./modelReviewProtocol.js";
import { containsNonPortableResearchText } from "./researchGovernancePortability.js";

const EVIDENCE_BUNDLE_PATH = "artifacts/evidence-bundle.json";
const MODEL_REVIEW_BUNDLE_PATH = "artifacts/model-review-bundle.json";

export interface PaperReadinessBundleInspectionIssue {
  code:
    | "bundle_root_invalid"
    | "manifest_invalid"
    | "file_binding_invalid"
    | "file_missing"
    | "file_type_invalid"
    | "file_size_mismatch"
    | "file_hash_mismatch"
    | "unexpected_file"
    | "non_portable_content"
    | "artifact_binding_mismatch";
  path: string;
  message: string;
}

export interface PaperReadinessBundleInspection {
  schema_version: "1.0";
  command_intent: "research:pack";
  verdict: "pass" | "fail";
  bundle_ref: string;
  bundle_id: string | null;
  checked_files: number;
  expected_files: number;
  closed_inventory: boolean;
  portability_valid: boolean;
  issues: PaperReadinessBundleInspectionIssue[];
}

export async function inspectPaperReadinessBundle(input: {
  cwd: string;
  bundleRoot: string;
}): Promise<PaperReadinessBundleInspection> {
  const root = resolveWithinCwd(input.cwd, input.bundleRoot);
  const bundleRef = portableInputLabel(input.cwd, root, "<paper-readiness-bundle>");
  const issues: PaperReadinessBundleInspectionIssue[] = [];
  const actualFiles = new Set<string>();
  const manifestPath = path.join(root, "paper-readiness-bundle.json");
  let bundle: PaperReadinessBundleArtifact | null = null;
  let checkedFiles = 0;
  let expectedFiles = 0;

  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      issues.push({
        code: "bundle_root_invalid",
        path: ".",
        message: "Paper-readiness bundle root must be a regular directory, not a symbolic link."
      });
    }
  } catch {
    issues.push({
      code: "bundle_root_invalid",
      path: ".",
      message: "Paper-readiness bundle root does not exist or cannot be inspected."
    });
  }
  if (issues.length > 0) {
    return buildBundleInspection(bundleRef, null, checkedFiles, expectedFiles, false, false, issues);
  }

  try {
    await inventoryBundleFiles(root, root, actualFiles, issues);
  } catch {
    issues.push({
      code: "bundle_root_invalid",
      path: ".",
      message: "Paper-readiness bundle inventory could not be read completely."
    });
  }

  let manifestBytes: Buffer | null = null;
  try {
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      issues.push({
        code: "manifest_invalid",
        path: "paper-readiness-bundle.json",
        message: "Bundle manifest must be a regular file, not a symbolic link."
      });
    } else {
      manifestBytes = await fs.readFile(manifestPath);
    }
  } catch {
    issues.push({
      code: "manifest_invalid",
      path: "paper-readiness-bundle.json",
      message: "Bundle manifest is missing or unreadable."
    });
  }

  if (manifestBytes) {
    if (containsNonPortableResearchText(manifestBytes.toString("utf8"))) {
      issues.push({
        code: "non_portable_content",
        path: "paper-readiness-bundle.json",
        message: "Bundle manifest contains a private path or credential-like assignment."
      });
    }
    try {
      const payload = JSON.parse(manifestBytes.toString("utf8")) as unknown;
      const validation = validateResearchGovernanceArtifact(payload);
      if (!validation.ok) {
        for (const issue of validation.issues) {
          issues.push({
            code: "manifest_invalid",
            path: `paper-readiness-bundle.json${issue.path.slice(1)}`,
            message: issue.message
          });
        }
      } else if ((payload as { artifact_type?: unknown }).artifact_type !== "PaperReadinessBundle") {
        issues.push({
          code: "manifest_invalid",
          path: "paper-readiness-bundle.json",
          message: "Expected a PaperReadinessBundle artifact."
        });
      } else {
        bundle = payload as PaperReadinessBundleArtifact;
      }
    } catch {
      issues.push({
        code: "manifest_invalid",
        path: "paper-readiness-bundle.json",
        message: "Bundle manifest is not valid JSON."
      });
    }
  }

  const expectedPaths = new Set(["paper-readiness-bundle.json"]);
  const verifiedBytes = new Map<string, Buffer>();
  if (bundle) {
    expectedFiles = bundle.files.length;
    for (let index = 0; index < bundle.files.length; index += 1) {
      const binding = bundle.files[index];
      const issuePath = `paper-readiness-bundle.json.files[${index}]`;
      if (!isValidBundleFileBinding(binding)) {
        issues.push({
          code: "file_binding_invalid",
          path: issuePath,
          message: "Bundle file binding requires a safe artifacts/ path, SHA-256 digest, and non-negative byte count."
        });
        continue;
      }
      expectedPaths.add(binding.path);
      const absolutePath = path.join(root, ...binding.path.split("/"));
      let raw: Buffer;
      try {
        const stat = await fs.lstat(absolutePath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          issues.push({
            code: "file_type_invalid",
            path: binding.path,
            message: "Bound bundle artifact must be a regular file, not a symbolic link."
          });
          continue;
        }
        raw = await fs.readFile(absolutePath);
      } catch {
        issues.push({
          code: "file_missing",
          path: binding.path,
          message: "Bound bundle artifact is missing or unreadable."
        });
        continue;
      }
      checkedFiles += 1;
      verifiedBytes.set(binding.path, raw);
      if (raw.byteLength !== binding.bytes) {
        issues.push({
          code: "file_size_mismatch",
          path: binding.path,
          message: `Expected ${binding.bytes} bytes but observed ${raw.byteLength}.`
        });
      }
      const observedSha256 = createHash("sha256").update(raw).digest("hex");
      if (observedSha256 !== binding.sha256) {
        issues.push({
          code: "file_hash_mismatch",
          path: binding.path,
          message: "Bound bundle artifact SHA-256 does not match the manifest."
        });
      }
      if (containsNonPortableResearchText(raw.toString("utf8"))) {
        issues.push({
          code: "non_portable_content",
          path: binding.path,
          message: "Bound bundle artifact contains a private path or credential-like assignment."
        });
      }
    }
    inspectBundleArtifactBindings(bundle, verifiedBytes, issues);
    if (bundle.portability.valid !== true
        || !Array.isArray(bundle.portability.issues)
        || bundle.portability.issues.length > 0) {
      issues.push({
        code: "non_portable_content",
        path: "paper-readiness-bundle.json.portability",
        message: "Bundle manifest does not declare a clean portability result."
      });
    }
  }

  for (const actualPath of [...actualFiles].sort()) {
    if (!expectedPaths.has(actualPath)) {
      issues.push({
        code: "unexpected_file",
        path: actualPath,
        message: "Bundle contains a file that is not bound by the manifest."
      });
    }
  }
  const closedInventory = bundle !== null
    && actualFiles.size === expectedPaths.size
    && [...expectedPaths].every((entry) => actualFiles.has(entry))
    && !issues.some((issue) => issue.code === "unexpected_file"
      || issue.code === "file_binding_invalid"
      || issue.code === "file_missing"
      || issue.code === "file_type_invalid");
  const portabilityValid = bundle?.portability.valid === true
    && !issues.some((issue) => issue.code === "non_portable_content");
  return buildBundleInspection(
    bundleRef,
    bundle?.artifact_id ?? null,
    checkedFiles,
    expectedFiles,
    closedInventory,
    portabilityValid,
    issues
  );
}

function buildBundleInspection(
  bundleRef: string,
  bundleId: string | null,
  checkedFiles: number,
  expectedFiles: number,
  closedInventory: boolean,
  portabilityValid: boolean,
  issues: PaperReadinessBundleInspectionIssue[]
): PaperReadinessBundleInspection {
  return {
    schema_version: "1.0",
    command_intent: "research:pack",
    verdict: issues.length === 0 ? "pass" : "fail",
    bundle_ref: bundleRef,
    bundle_id: bundleId,
    checked_files: checkedFiles,
    expected_files: expectedFiles,
    closed_inventory: closedInventory,
    portability_valid: portabilityValid,
    issues
  };
}

async function inventoryBundleFiles(
  root: string,
  current: string,
  files: Set<string>,
  issues: PaperReadinessBundleInspectionIssue[]
): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolutePath = path.join(current, entry.name);
    const relativePath = path.relative(root, absolutePath).replace(/\\/gu, "/");
    if (entry.isSymbolicLink()) {
      issues.push({
        code: "file_type_invalid",
        path: relativePath,
        message: "Symbolic links are not allowed in paper-readiness bundles."
      });
      continue;
    }
    if (entry.isDirectory()) {
      await inventoryBundleFiles(root, absolutePath, files, issues);
      continue;
    }
    if (!entry.isFile()) {
      issues.push({
        code: "file_type_invalid",
        path: relativePath,
        message: "Only regular files and directories are allowed in paper-readiness bundles."
      });
      continue;
    }
    files.add(relativePath);
  }
}

function isValidBundleFileBinding(
  value: unknown
): value is { path: string; sha256: string; bytes: number } {
  if (!value || typeof value !== "object") return false;
  const binding = value as { path?: unknown; sha256?: unknown; bytes?: unknown };
  if (typeof binding.path !== "string"
      || typeof binding.sha256 !== "string"
      || typeof binding.bytes !== "number") return false;
  const normalizedPath = path.posix.normalize(binding.path);
  return binding.path.startsWith("artifacts/")
    && normalizedPath === binding.path
    && !binding.path.includes("\\")
    && !path.posix.isAbsolute(binding.path)
    && !binding.path.split("/").some((part) => part === "." || part === ".." || part.length === 0)
    && /^[a-f0-9]{64}$/u.test(binding.sha256)
    && Number.isSafeInteger(binding.bytes)
    && binding.bytes >= 0;
}

function inspectBundleArtifactBindings(
  bundle: PaperReadinessBundleArtifact,
  verifiedBytes: Map<string, Buffer>,
  issues: PaperReadinessBundleInspectionIssue[]
): void {
  const evidenceBundle = parsePackedArtifact<EvidenceBundleArtifact>(
    EVIDENCE_BUNDLE_PATH,
    "EvidenceBundle",
    verifiedBytes,
    issues
  );
  const gate = parsePackedArtifact<GateReportArtifact>(
    "artifacts/gate-report.json",
    "GateReport",
    verifiedBytes,
    issues
  );
  const review = parsePackedArtifact<ReviewReportArtifact>(
    "artifacts/review-report.json",
    "ReviewReport",
    verifiedBytes,
    issues
  );
  if (!evidenceBundle || !gate || !review) return;
  inspectPackedEvidenceBundleBindings(evidenceBundle, gate, verifiedBytes, issues);
  inspectPackedReviewEvidenceBindings(gate, review, verifiedBytes, issues);
  const rebuiltBundle = bundle.limitations.every((limitation) => typeof limitation === "string")
    ? buildPaperReadinessBundleArtifact({
        gate,
        review,
        files: bundle.files,
        limitations: bundle.limitations,
        portabilityIssues: Array.isArray(bundle.portability.issues) ? bundle.portability.issues : [],
        redactedFiles: Array.isArray(bundle.portability.redacted_files)
          ? bundle.portability.redacted_files
          : []
      })
    : null;
  const expectedArtifactRefs = [
    gate.artifact_id,
    review.artifact_id,
    ...bundle.files.map((file) => file.path)
  ];
  const mismatches = [
    [rebuiltBundle === null || bundle.artifact_id !== rebuiltBundle.artifact_id,
      "Bundle artifact_id does not match its deterministic gate, review, file, and limitation bindings."],
    [JSON.stringify(bundle.provenance.artifact_refs) !== JSON.stringify(expectedArtifactRefs),
      "Bundle provenance artifact_refs do not match the packed gate, review, and file bindings."],
    [bundle.gate_report_id !== gate.artifact_id, "Bundle gate_report_id does not match the packed GateReport."],
    [bundle.review_report_id !== review.artifact_id, "Bundle review_report_id does not match the packed ReviewReport."],
    [review.gate_report_id !== gate.artifact_id, "Packed ReviewReport does not reference the packed GateReport."],
    [review.claim_ceiling !== gate.claim_ceiling, "Packed ReviewReport claim_ceiling does not match the packed GateReport."],
    [bundle.readiness_class !== review.readiness_class, "Bundle readiness_class does not match the packed ReviewReport."],
    [bundle.paper_ready !== review.paper_ready, "Bundle paper_ready does not match the packed ReviewReport."],
    [bundle.claim_ceiling !== review.claim_ceiling, "Bundle claim_ceiling does not match the packed ReviewReport."]
  ] as const;
  for (const [mismatch, message] of mismatches) {
    if (mismatch) {
      issues.push({
        code: "artifact_binding_mismatch",
        path: "paper-readiness-bundle.json",
        message
      });
    }
  }
}

function inspectPackedEvidenceBundleBindings(
  evidenceBundle: EvidenceBundleArtifact,
  gate: GateReportArtifact,
  verifiedBytes: Map<string, Buffer>,
  issues: PaperReadinessBundleInspectionIssue[]
): void {
  const bytes = verifiedBytes.get(EVIDENCE_BUNDLE_PATH);
  if (!bytes) return;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== gate.evidence_bundle_sha256) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: EVIDENCE_BUNDLE_PATH,
      message: "Packed EvidenceBundle bytes do not match GateReport.evidence_bundle_sha256."
    });
  }
  if (evidenceBundle.artifact_id !== gate.evidence_bundle_id) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: EVIDENCE_BUNDLE_PATH,
      message: "Packed EvidenceBundle artifact_id does not match GateReport.evidence_bundle_id."
    });
  }
  const boundFiles = evidenceBundle.files.filter(
    (file): file is EvidenceBundleFile & { sha256: string; bytes: number } =>
      typeof file.sha256 === "string" && Number.isSafeInteger(file.bytes)
  );
  if (JSON.stringify(boundFiles) !== JSON.stringify(gate.input_bindings)) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: EVIDENCE_BUNDLE_PATH,
      message: "Packed EvidenceBundle bound files do not exactly match GateReport.input_bindings."
    });
  }
}

function inspectPackedReviewEvidenceBindings(
  gate: GateReportArtifact,
  review: ReviewReportArtifact,
  verifiedBytes: Map<string, Buffer>,
  issues: PaperReadinessBundleInspectionIssue[]
): void {
  const assurance = (review as {
    reviewer_assurance?: ReviewReportArtifact["reviewer_assurance"];
  }).reviewer_assurance;
  if (!assurance) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: "artifacts/review-report.json",
      message: "Packed ReviewReport must contain reviewer_assurance."
    });
    return;
  }

  const gateBytes = verifiedBytes.get("artifacts/gate-report.json");
  if (!gateBytes) return;
  const gateSha256 = createHash("sha256").update(gateBytes).digest("hex");
  const declaredGateSha256 = (assurance as { gate_report_sha256?: unknown }).gate_report_sha256;
  if (typeof declaredGateSha256 !== "string") {
    if (assurance.tier === "A2_model_conservative") {
      issues.push({
        code: "artifact_binding_mismatch",
        path: "artifacts/review-report.json",
        message: "A2 ReviewReport must preserve the exact GateReport SHA-256."
      });
    }
  } else if (declaredGateSha256 !== gateSha256) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: "artifacts/review-report.json",
      message: "ReviewReport gate_report_sha256 does not match the packed GateReport bytes."
    });
  }

  if (assurance.tier === "A0_deterministic") {
    if (typeof declaredGateSha256 !== "string") return;
    const rebuiltReview = buildReviewReportArtifact(
      gate,
      { gateReportSha256: gateSha256 },
      new Date(review.generated_at)
    );
    if (JSON.stringify(review) !== JSON.stringify(rebuiltReview)) {
      issues.push({
        code: "artifact_binding_mismatch",
        path: "artifacts/review-report.json",
        message: "A0 ReviewReport does not exactly match its deterministic packed GateReport reconstruction."
      });
    }
    return;
  }

  const modelReviewBytes = verifiedBytes.get(MODEL_REVIEW_BUNDLE_PATH);
  if (!modelReviewBytes) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: MODEL_REVIEW_BUNDLE_PATH,
      message: "A2 ReviewReport requires a bound ModelReviewBundle sidecar."
    });
    return;
  }
  const modelReviewBundleSha256 = createHash("sha256").update(modelReviewBytes).digest("hex");
  if (modelReviewBundleSha256 !== assurance.model_review_bundle_sha256) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: MODEL_REVIEW_BUNDLE_PATH,
      message: "Packed ModelReviewBundle bytes do not match reviewer_assurance.model_review_bundle_sha256."
    });
  }

  try {
    const bundle = parseModelReviewBundle(
      JSON.parse(modelReviewBytes.toString("utf8")) as unknown,
      { artifact_id: gate.artifact_id, sha256: gateSha256 }
    );
    const rebuiltReview = buildReviewReportArtifact(gate, {
      modelReviewBundle: bundle,
      modelReviewBundleSha256,
      gateReportSha256: gateSha256
    }, new Date(review.generated_at));
    if (JSON.stringify(review) !== JSON.stringify(rebuiltReview)) {
      issues.push({
        code: "artifact_binding_mismatch",
        path: "artifacts/review-report.json",
        message: "A2 ReviewReport does not exactly match its bound gate and ModelReviewBundle reconstruction."
      });
    }
  } catch {
    issues.push({
      code: "artifact_binding_mismatch",
      path: MODEL_REVIEW_BUNDLE_PATH,
      message: "Packed ModelReviewBundle is invalid or does not bind the exact packed GateReport."
    });
  }
}

function parsePackedArtifact<T>(
  relativePath: string,
  expectedType: string,
  verifiedBytes: Map<string, Buffer>,
  issues: PaperReadinessBundleInspectionIssue[]
): T | null {
  const raw = verifiedBytes.get(relativePath);
  if (!raw) {
    issues.push({
      code: "artifact_binding_mismatch",
      path: relativePath,
      message: `Bundle must contain a bound ${expectedType}.`
    });
    return null;
  }
  try {
    const payload = JSON.parse(raw.toString("utf8")) as unknown;
    const validation = validateResearchGovernanceArtifact(payload);
    if (!validation.ok || (payload as { artifact_type?: unknown }).artifact_type !== expectedType) {
      issues.push({
        code: "artifact_binding_mismatch",
        path: relativePath,
        message: `Packed ${expectedType} is structurally invalid.`
      });
      return null;
    }
    return payload as T;
  } catch {
    issues.push({
      code: "artifact_binding_mismatch",
      path: relativePath,
      message: `Packed ${expectedType} is not valid JSON.`
    });
    return null;
  }
}

function resolveWithinCwd(cwd: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd, value);
}

function portableInputLabel(cwd: string, absolutePath: string, fallback: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : fallback;
}
