import path from "node:path";

import { promises as fs } from "node:fs";

import { fileExists } from "../../utils/fs.js";
import {
  assessEvidenceAdequacy,
  EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH,
  EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
  validateEvidenceAdequacyAssessment,
  validateEvidenceAdequacyContract,
  validateEvidenceAdequacyExecutionReceipt,
  type EvidenceAdequacyAssessmentV2,
  type EvidenceAdequacyContractV2,
  type EvidenceAdequacyExecutionReceiptV2
} from "./evidenceAdequacy.js";

const trustedEvidenceAdequacyAuthorizations = new WeakSet<object>();

export interface EvidenceAdequacyAuthorization {
  contract: EvidenceAdequacyContractV2;
  receipt: EvidenceAdequacyExecutionReceiptV2;
  assessment: EvidenceAdequacyAssessmentV2;
  verifiedEvidenceRefs: readonly string[];
}

export function isEvidenceAdequacyAuthorization(
  value: unknown
): value is EvidenceAdequacyAuthorization {
  return Boolean(value)
    && typeof value === "object"
    && trustedEvidenceAdequacyAuthorizations.has(value as object);
}

export async function loadEvidenceAdequacyContractFromRunDir(
  runDir: string
): Promise<{
  present: boolean;
  contract?: EvidenceAdequacyContractV2;
  reasons: string[];
}> {
  const artifactPath = path.join(
    runDir,
    EVIDENCE_ADEQUACY_CONTRACT_RELATIVE_PATH
  );
  let raw: string;
  try {
    raw = await fs.readFile(artifactPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT"
      ? { present: false, reasons: [] }
      : {
          present: true,
          reasons: [
            `evidence_adequacy_contract_read_failed:${
              error instanceof Error ? error.message : String(error)
            }`
          ]
        };
  }
  if (!raw.trim()) {
    return {
      present: true,
      reasons: ["evidence_adequacy_contract_empty"]
    };
  }
  try {
    const validation = validateEvidenceAdequacyContract(JSON.parse(raw));
    return validation.valid && validation.artifact
      ? { present: true, contract: validation.artifact, reasons: [] }
      : { present: true, reasons: validation.reasons };
  } catch (error) {
    return {
      present: true,
      reasons: [
        `evidence_adequacy_contract_json_invalid:${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    };
  }
}

export async function resolveVerifiedEvidenceRefs(input: {
  references: string[];
  roots: string[];
}): Promise<string[]> {
  const roots = Array.from(
    new Set(input.roots.map((root) => path.resolve(root)))
  );
  const verified: string[] = [];
  const jsonCache = new Map<string, unknown>();
  for (const reference of Array.from(new Set(input.references))) {
    const hashIndex = reference.indexOf("#");
    const pathPart = (
      hashIndex >= 0 ? reference.slice(0, hashIndex) : reference
    ).trim();
    const fragment = hashIndex >= 0
      ? reference.slice(hashIndex + 1).trim()
      : "";
    if (
      !pathPart
      || path.isAbsolute(pathPart)
      || pathPart.includes("\\")
      || /^[a-z][a-z0-9+.-]*:/iu.test(pathPart)
    ) {
      continue;
    }
    if (pathPart.split("/").some((segment) => segment === "..")) {
      continue;
    }
    for (const root of roots) {
      const candidate = path.resolve(root, pathPart);
      if (
        candidate !== root
        && !candidate.startsWith(`${root}${path.sep}`)
      ) {
        continue;
      }
      if (
        await fileExists(candidate)
        && await artifactFragmentExists(candidate, fragment, jsonCache)
      ) {
        verified.push(reference);
        break;
      }
    }
  }
  return verified;
}

async function artifactFragmentExists(
  artifactPath: string,
  fragment: string,
  jsonCache: Map<string, unknown>
): Promise<boolean> {
  if (!fragment) {
    return true;
  }
  let value: unknown;
  if (jsonCache.has(artifactPath)) {
    value = jsonCache.get(artifactPath);
  } else {
    try {
      value = JSON.parse(await fs.readFile(artifactPath, "utf8")) as unknown;
    } catch {
      value = undefined;
    }
    jsonCache.set(artifactPath, value);
  }
  if (value === undefined) {
    return false;
  }
  const segments = fragment.startsWith("/")
    ? fragment.slice(1).split("/")
    : [fragment];
  let cursor: unknown = value;
  for (const encodedSegment of segments) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment)
        .replace(/~1/gu, "/")
        .replace(/~0/gu, "~");
    } catch {
      return false;
    }
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment)) {
        return false;
      }
      const index = Number(segment);
      if (index >= cursor.length) {
        return false;
      }
      cursor = cursor[index];
      continue;
    }
    if (
      cursor === null
      || typeof cursor !== "object"
      || !Object.hasOwn(cursor, segment)
    ) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

export interface EvidenceAdequacyArtifactReassessment {
  contractPresent: boolean;
  receiptPresent: boolean;
  storedAssessmentPresent: boolean;
  integrityValid: boolean;
  assessment?: EvidenceAdequacyAssessmentV2;
  authorization?: EvidenceAdequacyAuthorization;
  issues: string[];
  warnings: string[];
}

export async function reassessEvidenceAdequacyArtifacts(input: {
  runDir: string;
  evidenceRoots: Array<string | undefined>;
  expectedPrimaryComparisonId?: string;
  requireStoredAssessment?: boolean;
}): Promise<EvidenceAdequacyArtifactReassessment> {
  const issues: string[] = [];
  const warnings: string[] = [];
  const contractLoad = await loadEvidenceAdequacyContractFromRunDir(
    input.runDir
  );
  const receiptPath = path.join(
    input.runDir,
    EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH
  );
  const assessmentPath = path.join(
    input.runDir,
    EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH
  );
  const receiptPresent = await fileExists(receiptPath);
  const storedAssessmentPresent = await fileExists(assessmentPath);
  const base = {
    contractPresent: contractLoad.present,
    receiptPresent,
    storedAssessmentPresent
  };

  if (!contractLoad.contract) {
    if (contractLoad.present) {
      issues.push(
        `Evidence adequacy contract is invalid: ${contractLoad.reasons.join(", ") || "unknown validation failure"}.`
      );
    }
    if (receiptPresent || storedAssessmentPresent) {
      issues.push(
        "Evidence adequacy receipt or assessment exists without a valid frozen contract."
      );
    }
    return {
      ...base,
      integrityValid: false,
      issues: uniqueStrings(issues),
      warnings
    };
  }

  const contract = contractLoad.contract;
  const primaryBindingValid =
    input.expectedPrimaryComparisonId === contract.primary_comparison_id;
  if (!primaryBindingValid) {
    issues.push(
      "Evidence adequacy primary comparison does not match experiment_contract.results_plan.primary_comparison_id."
    );
  }
  if (!receiptPresent) {
    issues.push("Evidence adequacy execution receipt is missing.");
    return {
      ...base,
      integrityValid: false,
      issues: uniqueStrings(issues),
      warnings
    };
  }

  const receiptRaw = await readJsonArtifact(
    receiptPath,
    EVIDENCE_ADEQUACY_RECEIPT_RELATIVE_PATH,
    warnings
  );
  const receiptValidation = validateEvidenceAdequacyExecutionReceipt(
    receiptRaw
  );
  if (!receiptValidation.valid || !receiptValidation.artifact) {
    issues.push(
      `Evidence adequacy execution receipt is invalid: ${receiptValidation.reasons.join(", ")}.`
    );
    return {
      ...base,
      integrityValid: false,
      issues: uniqueStrings(issues),
      warnings
    };
  }

  const receipt = receiptValidation.artifact;
  const verifiedEvidenceRefs = await resolveVerifiedEvidenceRefs({
    references: [
      ...receipt.primary_evidence_refs,
      ...receipt.auxiliary_evidence_refs
    ],
    roots: input.evidenceRoots.filter(
      (value): value is string => Boolean(value)
    )
  });
  const reassessed = assessEvidenceAdequacy({
    contract,
    receipt,
    verifiedEvidenceRefs
  });

  let storedAssessmentValid = input.requireStoredAssessment === false;
  if (!storedAssessmentPresent) {
    if (input.requireStoredAssessment !== false) {
      issues.push("Persisted evidence adequacy assessment is missing.");
    }
  } else {
    const storedAssessment = await readJsonArtifact(
      assessmentPath,
      EVIDENCE_ADEQUACY_ASSESSMENT_RELATIVE_PATH,
      warnings
    );
    const storedValidation = validateEvidenceAdequacyAssessment(
      storedAssessment,
      { contract, receipt, verifiedEvidenceRefs }
    );
    if (!storedValidation.valid) {
      issues.push(
        `Persisted evidence adequacy assessment does not match current artifacts: ${storedValidation.reasons.join(", ")}.`
      );
    } else {
      storedAssessmentValid = true;
    }
  }

  if (!reassessed.passed) {
    const nonPassing = reassessed.checks.filter(
      (check) => check.status !== "pass"
    );
    issues.push(
      `Evidence adequacy reassessment is ${reassessed.overall_status}: ${nonPassing
        .map((check) => `${check.check_id}=${check.status}:${check.reasons.join("|") || "unspecified"}`)
        .join("; ")}.`
    );
  }

  const integrityValid = primaryBindingValid && storedAssessmentValid;
  const authorization = integrityValid && reassessed.passed
    ? issueEvidenceAdequacyAuthorization({
        contract,
        receipt,
        assessment: reassessed,
        verifiedEvidenceRefs
      })
    : undefined;

  return {
    ...base,
    integrityValid,
    assessment: reassessed,
    ...(authorization ? { authorization } : {}),
    issues: uniqueStrings(issues),
    warnings: uniqueStrings(warnings)
  };
}

function issueEvidenceAdequacyAuthorization(
  input: EvidenceAdequacyAuthorization
): EvidenceAdequacyAuthorization {
  const authorization: EvidenceAdequacyAuthorization = Object.freeze({
    contract: input.contract,
    receipt: input.receipt,
    assessment: input.assessment,
    verifiedEvidenceRefs: Object.freeze([...input.verifiedEvidenceRefs])
  });
  trustedEvidenceAdequacyAuthorizations.add(authorization);
  return authorization;
}

async function readJsonArtifact(
  artifactPath: string,
  label: string,
  warnings: string[]
): Promise<unknown> {
  try {
    const raw = await fs.readFile(artifactPath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    warnings.push(
      `Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`
    );
    return undefined;
  }
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim().length > 0)));
}
