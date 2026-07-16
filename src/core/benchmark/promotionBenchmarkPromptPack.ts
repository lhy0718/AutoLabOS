import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_DECISIONS,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkConcernPrediction,
  type PromotionBenchmarkPrediction,
  type PromotionDecision
} from "./promotionBenchmark.js";

export interface ExportPromotionPromptPackInput {
  cwd: string;
  suitePath: string;
  outDir: string;
}

export interface ExportPromotionPromptPackResult {
  suite_id: string;
  request_count: number;
  requests_sha256: string;
  requests_path: string;
  private_map_path: string;
}

export interface ImportPromotionResponsesInput {
  cwd: string;
  requestMapPath: string;
  responsesPath: string;
  systemId: string;
  trialId: string;
  outDir: string;
}

export interface ImportPromotionResponsesResult {
  prediction_count: number;
  predictions_path: string;
}

export interface PromotionPromptRequest {
  schema_version: "1.0";
  request_id: string;
  protocol: "manuscript-only-v1";
  allowed_information_boundary: ["manuscript_text"];
  prompt: string;
}

export interface PromotionPromptRequestMap {
  schema_version: "1.0";
  suite_id: string;
  protocol: "manuscript-only-v1";
  requests_sha256: string;
  requests: Array<{
    request_id: string;
    case_id: string;
    manuscript_sha256: string;
    prompt_sha256: string;
  }>;
}

export interface PromotionProviderResponse {
  request_id: string;
  decision: PromotionDecision;
  concerns: PromotionBenchmarkConcernPrediction[];
  repair_owners: string[];
  latency_ms?: number;
  cost_usd?: number;
}

export async function exportPromotionBenchmarkPromptPack(
  input: ExportPromotionPromptPackInput
): Promise<ExportPromotionPromptPackResult> {
  const cwd = path.resolve(input.cwd);
  const suitePath = path.resolve(cwd, input.suitePath);
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion benchmark suite validation failed: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  const outDir = path.resolve(cwd, input.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const requests: PromotionPromptRequest[] = [];
  const requestMappings: PromotionPromptRequestMap["requests"] = [];

  for (const benchmarkCase of loaded.suite.cases) {
    const artifactRoot = loaded.suite.case_artifact_roots[benchmarkCase.case_id];
    const manuscript = await readManuscript(path.join(artifactRoot, "paper", "main.tex"));
    const requestId = opaqueRequestId(loaded.suite.manifest.suite_id, benchmarkCase.case_id);
    const manuscriptHash = createHash("sha256").update(manuscript).digest("hex");
    const prompt = buildManuscriptOnlyPrompt(manuscript);
    requests.push({
      schema_version: "1.0",
      request_id: requestId,
      protocol: "manuscript-only-v1",
      allowed_information_boundary: ["manuscript_text"],
      prompt
    });
    requestMappings.push({
      request_id: requestId,
      case_id: benchmarkCase.case_id,
      manuscript_sha256: manuscriptHash,
      prompt_sha256: sha256(prompt)
    });
  }

  const requestsPath = path.join(outDir, "requests.jsonl");
  const privateMapPath = path.join(outDir, "private-request-map.json");
  const requestsText = `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`;
  const requestsSha256 = sha256(requestsText);
  const requestMap: PromotionPromptRequestMap = {
    schema_version: "1.0",
    suite_id: loaded.suite.manifest.suite_id,
    protocol: "manuscript-only-v1",
    requests_sha256: requestsSha256,
    requests: requestMappings
  };
  await fs.writeFile(requestsPath, requestsText, "utf8");
  await writeJsonFile(privateMapPath, requestMap);
  return {
    suite_id: loaded.suite.manifest.suite_id,
    request_count: requests.length,
    requests_sha256: requestsSha256,
    requests_path: portableRef(cwd, requestsPath),
    private_map_path: portableRef(cwd, privateMapPath)
  };
}

export async function importPromotionBenchmarkResponses(
  input: ImportPromotionResponsesInput
): Promise<ImportPromotionResponsesResult> {
  if (!input.systemId.trim() || !input.trialId.trim()) throw new Error("Provider import requires non-empty systemId and trialId.");
  const cwd = path.resolve(input.cwd);
  const requestMap = parsePromotionPromptRequestMap(
    JSON.parse(await fs.readFile(path.resolve(cwd, input.requestMapPath), "utf8"))
  );
  const responses = await readProviderResponses(path.resolve(cwd, input.responsesPath));
  const caseByRequest = new Map(requestMap.requests.map((request) => [request.request_id, request.case_id] as const));
  const seen = new Set<string>();
  const predictions: PromotionBenchmarkPrediction[] = [];
  for (const response of responses) {
    const caseId = caseByRequest.get(response.request_id);
    if (!caseId) throw new Error(`Unknown provider response request_id: ${response.request_id}`);
    if (seen.has(response.request_id)) throw new Error(`Duplicate provider response request_id: ${response.request_id}`);
    seen.add(response.request_id);
    predictions.push({
      case_id: caseId,
      system_id: input.systemId,
      trial_id: input.trialId,
      decision: response.decision,
      concerns: response.concerns,
      repair_owners: response.repair_owners,
      ...(response.latency_ms !== undefined ? { latency_ms: response.latency_ms } : {}),
      ...(response.cost_usd !== undefined ? { cost_usd: response.cost_usd } : {})
    });
  }
  const missing = requestMap.requests.filter((request) => !seen.has(request.request_id));
  if (missing.length > 0) throw new Error(`Provider responses are incomplete: ${missing.length} request(s) missing.`);

  const outDir = path.resolve(cwd, input.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const predictionsPath = path.join(outDir, "predictions.jsonl");
  await fs.writeFile(predictionsPath, `${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`, "utf8");
  return {
    prediction_count: predictions.length,
    predictions_path: portableRef(cwd, predictionsPath)
  };
}

function buildManuscriptOnlyPrompt(manuscript: string): string {
  return [
    "Assess the manuscript for research-paper promotion using only the manuscript text below.",
    "Do not assume access to run artifacts, hidden benchmark labels, prior conversation, or external tools.",
    "Return one JSON object with exactly these fields:",
    '{"decision":"promote|needs_review|downgrade|block","concerns":[{"code":"string","severity":"blocking|warning","evidence_refs":["manuscript"]}],"repair_owners":["workflow_node"]}',
    "Use blocking concerns only when the manuscript itself establishes a blocking defect.",
    "<manuscript>",
    manuscript || "[NO MANUSCRIPT ARTIFACT]",
    "</manuscript>"
  ].join("\n");
}

function opaqueRequestId(suiteId: string, caseId: string): string {
  return `request-${createHash("sha256").update(`${suiteId}\0${caseId}\0manuscript-only-v1`).digest("hex").slice(0, 16)}`;
}

async function readManuscript(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

export function parsePromotionPromptRequestMap(value: unknown): PromotionPromptRequestMap {
  if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.suite_id)
      || value.protocol !== "manuscript-only-v1" || !sha256String(value.requests_sha256)
      || !Array.isArray(value.requests)) {
    throw new Error("Invalid promotion benchmark private request map.");
  }
  const requests = value.requests.map((request) => {
    if (!isRecord(request) || !nonEmptyString(request.request_id) || !nonEmptyString(request.case_id)
        || !sha256String(request.manuscript_sha256) || !sha256String(request.prompt_sha256)) {
      throw new Error("Invalid promotion benchmark request mapping entry.");
    }
    return {
      request_id: request.request_id,
      case_id: request.case_id,
      manuscript_sha256: request.manuscript_sha256,
      prompt_sha256: request.prompt_sha256
    };
  });
  if (new Set(requests.map((request) => request.request_id)).size !== requests.length) {
    throw new Error("Duplicate request_id in promotion benchmark request map.");
  }
  return {
    schema_version: "1.0",
    suite_id: value.suite_id,
    protocol: "manuscript-only-v1",
    requests_sha256: value.requests_sha256,
    requests
  };
}

async function readProviderResponses(filePath: string): Promise<PromotionProviderResponse[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const responses: PromotionProviderResponse[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Provider response line ${index + 1} is not valid JSON.`);
    }
    responses.push(parsePromotionProviderResponse(value, `line ${index + 1}`));
  }
  return responses;
}

export function parsePromotionProviderResponse(
  value: unknown,
  context = "response"
): PromotionProviderResponse {
  if (!isRecord(value) || !nonEmptyString(value.request_id) || !isPromotionDecision(value.decision)
      || !Array.isArray(value.concerns) || !stringArray(value.repair_owners)) {
    throw new Error(`Provider response ${context} has an invalid schema.`);
  }
  const concerns = value.concerns.map((concern) => parseConcern(concern, context));
  return {
    request_id: value.request_id,
    decision: value.decision,
    concerns,
    repair_owners: stringArray(value.repair_owners) || [],
    ...(isNonNegativeFinite(value.latency_ms) ? { latency_ms: value.latency_ms } : {}),
    ...(isNonNegativeFinite(value.cost_usd) ? { cost_usd: value.cost_usd } : {})
  };
}

function parseConcern(value: unknown, context: string): PromotionBenchmarkConcernPrediction {
  if (!isRecord(value) || !nonEmptyString(value.code)
      || (value.severity !== "blocking" && value.severity !== "warning")
      || (value.evidence_refs !== undefined && !stringArray(value.evidence_refs))) {
    throw new Error(`Provider response ${context} has an invalid concern.`);
  }
  return {
    code: value.code,
    severity: value.severity,
    ...(value.evidence_refs ? { evidence_refs: stringArray(value.evidence_refs) || [] } : {})
  };
}

function isPromotionDecision(value: unknown): value is PromotionDecision {
  return typeof value === "string" && (PROMOTION_DECISIONS as readonly string[]).includes(value);
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(nonEmptyString) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function portableRef(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  return relative && !relative.startsWith("../") ? relative : "<external-output>";
}
