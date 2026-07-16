import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  PROMOTION_DECISIONS,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkPrediction,
  type PromotionDecision
} from "./promotionBenchmark.js";
import {
  parsePromotionPromptRequestMap,
  parsePromotionProviderResponse,
  type PromotionPromptRequestMap,
  type PromotionProviderResponse
} from "./promotionBenchmarkPromptPack.js";
import type { PromotionProviderRunManifest } from "./promotionBenchmarkProviderRunner.js";

const REQUIRED_TRIAL_COUNT = 3;

export interface AggregatePromotionProviderRunsInput {
  cwd: string;
  suitePath: string;
  runManifestPaths: string[];
  outDir: string;
}

export interface PromotionProviderAggregateManifest {
  schema_version: "1.0";
  aggregate_id: string;
  status: "completed";
  protocol: "manuscript-only-v1";
  provider: "openai_responses_api";
  evidence_class: "external_real_provider";
  provider_receipt_status: "recorded_not_independently_verified";
  provider_identity_independently_verified: false;
  external_empirical_evidence_eligible: true;
  independent_trial_requirement_met: true;
  independence_basis: {
    required_trial_count: 3;
    distinct_run_ids: true;
    distinct_trial_ids: true;
    distinct_response_receipts: true;
    identical_prompt_pack: true;
    caveat: string;
  };
  suite_id: string;
  suite_path: string;
  suite_sha256: string;
  system_id: string;
  requested_model: string;
  resolved_model: string;
  reasoning_effort: string;
  generated_at: string;
  case_count: number;
  request_count_per_trial: number;
  trial_count: 3;
  trial_ids: string[];
  run_ids: string[];
  prediction_count: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  prompt_pack: {
    requests_sha256: string;
    private_map_sha256: string;
  };
  source_runs: Array<{
    run_id: string;
    trial_id: string;
    manifest_path: string;
    manifest_sha256: string;
    provider_outputs_sha256: string;
    provider_responses_sha256: string;
    predictions_sha256: string;
  }>;
  artifacts: {
    predictions_path: string;
    predictions_sha256: string;
  };
}

export interface AggregatePromotionProviderRunsResult {
  manifest: PromotionProviderAggregateManifest;
  manifest_path: string;
  predictions_path: string;
}

interface ValidatedRun {
  manifest: PromotionProviderRunManifest;
  manifestPath: string;
  manifestSha256: string;
  predictions: PromotionBenchmarkPrediction[];
  responseReceiptHashes: string[];
  resolvedModel: string;
}

export async function aggregatePromotionBenchmarkProviderRuns(
  input: AggregatePromotionProviderRunsInput
): Promise<AggregatePromotionProviderRunsResult> {
  if (input.runManifestPaths.length !== REQUIRED_TRIAL_COUNT) {
    throw new Error(`Promotion provider aggregation requires exactly ${REQUIRED_TRIAL_COUNT} run manifests.`);
  }
  if (new Set(input.runManifestPaths.map((value) => path.normalize(value))).size !== REQUIRED_TRIAL_COUNT) {
    throw new Error("Promotion provider aggregation requires distinct run manifest paths.");
  }
  if (!input.outDir.trim()) throw new Error("Promotion provider aggregation requires outDir.");

  const cwd = path.resolve(input.cwd);
  const suitePath = await resolveExistingInside(cwd, path.resolve(cwd, input.suitePath), "Promotion suite");
  const outDir = path.resolve(cwd, input.outDir);
  assertStrictlyInside(cwd, outDir, "Provider aggregate output directory");
  await assertFreshOutput(outDir);

  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion benchmark suite validation failed: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  if (loaded.suite.cases.length === 0) throw new Error("Promotion provider aggregation requires a non-empty suite.");

  const validatedRuns: ValidatedRun[] = [];
  for (const manifestInputPath of input.runManifestPaths) {
    const manifestPath = await resolveExistingInside(
      cwd,
      path.resolve(cwd, manifestInputPath),
      "Provider run manifest"
    );
    validatedRuns.push(await validateRun({
      cwd,
      manifestPath,
      suiteId: loaded.suite.manifest.suite_id,
      expectedCaseIds: loaded.suite.cases.map((benchmarkCase) => benchmarkCase.case_id),
      manuscriptPathByCase: new Map(loaded.suite.cases.map((benchmarkCase) => [
        benchmarkCase.case_id,
        path.join(loaded.suite!.case_artifact_roots[benchmarkCase.case_id], "paper", "main.tex")
      ]))
    }));
  }

  const referenceRun = validatedRuns[0];
  const reference = referenceRun.manifest;
  for (const run of validatedRuns.slice(1)) {
    const manifest = run.manifest;
    if (manifest.suite_id !== reference.suite_id
        || manifest.system_id !== reference.system_id
        || manifest.requested_model !== reference.requested_model
        || manifest.reasoning_effort !== reference.reasoning_effort
        || manifest.protocol !== reference.protocol
        || manifest.provider !== reference.provider
        || manifest.request_count !== reference.request_count
        || manifest.prompt_pack.requests_sha256 !== reference.prompt_pack.requests_sha256
        || manifest.prompt_pack.private_map_sha256 !== reference.prompt_pack.private_map_sha256
        || run.resolvedModel !== referenceRun.resolvedModel) {
      throw new Error("Promotion provider runs do not share one identical suite, system, model, reasoning, and prompt protocol.");
    }
  }

  const runIds = validatedRuns.map((run) => run.manifest.run_id);
  const trialIds = validatedRuns.map((run) => run.manifest.trial_id);
  if (new Set(runIds).size !== REQUIRED_TRIAL_COUNT) {
    throw new Error("Promotion provider aggregation requires three distinct run_ids.");
  }
  if (new Set(trialIds).size !== REQUIRED_TRIAL_COUNT) {
    throw new Error("Promotion provider aggregation requires three distinct trial_ids.");
  }
  const responseReceiptHashes = validatedRuns.flatMap((run) => run.responseReceiptHashes);
  if (new Set(responseReceiptHashes).size !== responseReceiptHashes.length) {
    throw new Error("Promotion provider aggregation requires distinct response receipts across trials.");
  }

  const sortedRuns = [...validatedRuns].sort((left, right) =>
    left.manifest.trial_id.localeCompare(right.manifest.trial_id));
  const caseOrder = new Map(loaded.suite.cases.map((benchmarkCase, index) => [benchmarkCase.case_id, index]));
  const predictions = sortedRuns.flatMap((run) => [...run.predictions].sort((left, right) =>
    (caseOrder.get(left.case_id) ?? Number.MAX_SAFE_INTEGER)
      - (caseOrder.get(right.case_id) ?? Number.MAX_SAFE_INTEGER)));
  const predictionsText = `${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`;
  const predictionsSha256 = sha256(predictionsText);
  const sourceRuns = sortedRuns.map((run) => ({
    run_id: run.manifest.run_id,
    trial_id: run.manifest.trial_id,
    manifest_path: portableRef(cwd, run.manifestPath),
    manifest_sha256: run.manifestSha256,
    provider_outputs_sha256: run.manifest.artifacts.provider_outputs_sha256!,
    provider_responses_sha256: run.manifest.artifacts.provider_responses_sha256!,
    predictions_sha256: run.manifest.artifacts.predictions_sha256!
  }));
  const aggregateId = `provider-aggregate-${sha256(JSON.stringify({
    suite_id: reference.suite_id,
    system_id: reference.system_id,
    requested_model: reference.requested_model,
    resolved_model: referenceRun.resolvedModel,
    reasoning_effort: reference.reasoning_effort,
    source_manifest_sha256: sourceRuns.map((run) => run.manifest_sha256)
  })).slice(0, 16)}`;
  const predictionsPath = path.join(outDir, "predictions.jsonl");
  const manifestPath = path.join(outDir, "provider-run-aggregate-manifest.json");
  const suiteSha256 = await sha256File(suitePath);
  const manifest: PromotionProviderAggregateManifest = {
    schema_version: "1.0",
    aggregate_id: aggregateId,
    status: "completed",
    protocol: "manuscript-only-v1",
    provider: "openai_responses_api",
    evidence_class: "external_real_provider",
    provider_receipt_status: "recorded_not_independently_verified",
    provider_identity_independently_verified: false,
    external_empirical_evidence_eligible: true,
    independent_trial_requirement_met: true,
    independence_basis: {
      required_trial_count: 3,
      distinct_run_ids: true,
      distinct_trial_ids: true,
      distinct_response_receipts: true,
      identical_prompt_pack: true,
      caveat: "Distinct provider receipts and trial identifiers do not independently verify provider identity or statistical independence."
    },
    suite_id: reference.suite_id,
    suite_path: portableRef(cwd, suitePath),
    suite_sha256: suiteSha256,
    system_id: reference.system_id,
    requested_model: reference.requested_model,
    resolved_model: referenceRun.resolvedModel,
    reasoning_effort: reference.reasoning_effort,
    generated_at: new Date().toISOString(),
    case_count: loaded.suite.cases.length,
    request_count_per_trial: reference.request_count,
    trial_count: 3,
    trial_ids: sortedRuns.map((run) => run.manifest.trial_id),
    run_ids: sortedRuns.map((run) => run.manifest.run_id),
    prediction_count: predictions.length,
    usage: sortedRuns.reduce((total, run) => ({
      input_tokens: total.input_tokens + run.manifest.usage.input_tokens,
      output_tokens: total.output_tokens + run.manifest.usage.output_tokens,
      cost_usd: total.cost_usd + run.manifest.usage.cost_usd
    }), { input_tokens: 0, output_tokens: 0, cost_usd: 0 }),
    prompt_pack: {
      requests_sha256: reference.prompt_pack.requests_sha256,
      private_map_sha256: reference.prompt_pack.private_map_sha256
    },
    source_runs: sourceRuns,
    artifacts: {
      predictions_path: portableRef(cwd, predictionsPath),
      predictions_sha256: predictionsSha256
    }
  };

  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(predictionsPath, predictionsText, "utf8");
  await writeJsonFile(manifestPath, manifest);
  return {
    manifest,
    manifest_path: portableRef(cwd, manifestPath),
    predictions_path: portableRef(cwd, predictionsPath)
  };
}

async function validateRun(input: {
  cwd: string;
  manifestPath: string;
  suiteId: string;
  expectedCaseIds: string[];
  manuscriptPathByCase: Map<string, string>;
}): Promise<ValidatedRun> {
  const manifestText = await fs.readFile(input.manifestPath, "utf8");
  const manifest = parseCompletedRunManifest(JSON.parse(manifestText), portableRef(input.cwd, input.manifestPath));
  const runRoot = path.dirname(input.manifestPath);
  if (manifest.suite_id !== input.suiteId) {
    throw new Error(`Provider run suite_id does not match the selected suite: ${manifest.trial_id}`);
  }

  const requestsPath = await resolveRunArtifact(input.cwd, runRoot, manifest.prompt_pack.requests_path, "requests");
  const privateMapPath = await resolveRunArtifact(input.cwd, runRoot, manifest.prompt_pack.private_map_path, "private map");
  const providerOutputsPath = await resolveRunArtifact(
    input.cwd,
    runRoot,
    manifest.artifacts.provider_outputs_path,
    "provider outputs"
  );
  const providerResponsesPath = await resolveRunArtifact(
    input.cwd,
    runRoot,
    manifest.artifacts.provider_responses_path,
    "provider responses"
  );
  const predictionsPath = await resolveRunArtifact(
    input.cwd,
    runRoot,
    manifest.artifacts.predictions_path!,
    "predictions"
  );
  const failuresPath = resolveRunArtifactTarget(
    input.cwd,
    runRoot,
    manifest.artifacts.failures_path,
    "failures"
  );
  await verifyFileHash(requestsPath, manifest.prompt_pack.requests_sha256, "requests");
  await verifyFileHash(privateMapPath, manifest.prompt_pack.private_map_sha256, "private map");
  await verifyFileHash(providerOutputsPath, manifest.artifacts.provider_outputs_sha256!, "provider outputs");
  await verifyFileHash(providerResponsesPath, manifest.artifacts.provider_responses_sha256!, "provider responses");
  await verifyFileHash(predictionsPath, manifest.artifacts.predictions_sha256!, "predictions");
  await requireMissingArtifact(failuresPath, "Completed provider run must not contain a failure artifact.");

  const requestMap = parsePromotionPromptRequestMap(JSON.parse(await fs.readFile(privateMapPath, "utf8")));
  const requestsText = await fs.readFile(requestsPath, "utf8");
  validatePromptRequests(requestsText, requestMap);
  await validateRequestMap({
    requestMap,
    manifest,
    expectedCaseIds: input.expectedCaseIds,
    manuscriptPathByCase: input.manuscriptPathByCase
  });
  const requestIdSet = new Set(requestMap.requests.map((request) => request.request_id));
  const outputs = parseProviderOutputs(await fs.readFile(providerOutputsPath, "utf8"), manifest);
  const resolvedModels = new Set(outputs.map((output) => output.resolvedModel));
  if (resolvedModels.size !== 1) {
    throw new Error(`Provider run resolved model is inconsistent: ${manifest.trial_id}`);
  }
  const responses = parseProviderResponses(await fs.readFile(providerResponsesPath, "utf8"));
  const predictions = parsePredictions(await fs.readFile(predictionsPath, "utf8"));
  requireExactIds(outputs.map((row) => row.requestId), requestIdSet, "provider output request");
  requireExactIds(responses.map((row) => row.request_id), requestIdSet, "provider response request");

  const responseByRequest = new Map(responses.map((response) => [response.request_id, response]));
  for (const output of outputs) {
    const response = responseByRequest.get(output.requestId);
    if (!response || normalizedResponseJson(response) !== normalizedResponseJson(output.response)) {
      throw new Error(`Provider output and response artifacts disagree: ${output.requestId}`);
    }
  }
  const requestByCase = new Map(requestMap.requests.map((request) => [request.case_id, request.request_id]));
  const predictionCaseIds = new Set<string>();
  for (const prediction of predictions) {
    if (prediction.system_id !== manifest.system_id || prediction.trial_id !== manifest.trial_id) {
      throw new Error(`Prediction system or trial provenance mismatch: ${prediction.case_id}`);
    }
    if (predictionCaseIds.has(prediction.case_id)) {
      throw new Error(`Duplicate prediction case: ${prediction.case_id}`);
    }
    predictionCaseIds.add(prediction.case_id);
    const requestId = requestByCase.get(prediction.case_id);
    const response = requestId ? responseByRequest.get(requestId) : undefined;
    if (!response || normalizedPredictionJson(prediction) !== normalizedResponseJson(response)) {
      throw new Error(`Prediction does not match its provider response: ${prediction.case_id}`);
    }
  }
  requireExactIds([...predictionCaseIds], new Set(input.expectedCaseIds), "prediction case");
  if (outputs.length !== manifest.request_count || responses.length !== manifest.request_count
      || predictions.length !== manifest.request_count) {
    throw new Error(`Provider run artifact counts do not match the manifest: ${manifest.trial_id}`);
  }
  const usage = outputs.reduce((total, output) => ({
    input_tokens: total.input_tokens + output.inputTokens,
    output_tokens: total.output_tokens + output.outputTokens,
    cost_usd: total.cost_usd + output.costUsd
  }), { input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  if (usage.input_tokens !== manifest.usage.input_tokens
      || usage.output_tokens !== manifest.usage.output_tokens
      || Math.abs(usage.cost_usd - manifest.usage.cost_usd) > 1e-12) {
    throw new Error(`Provider run usage does not match output artifacts: ${manifest.trial_id}`);
  }
  return {
    manifest,
    manifestPath: input.manifestPath,
    manifestSha256: sha256(manifestText),
    predictions,
    responseReceiptHashes: outputs.map((output) => output.responseReceiptHash),
    resolvedModel: outputs[0].resolvedModel
  };
}

function validatePromptRequests(raw: string, requestMap: PromotionPromptRequestMap): void {
  const rows = parseJsonLines(raw, "prompt request");
  const mappingByRequest = new Map(requestMap.requests.map((request) => [request.request_id, request]));
  const requestIds: string[] = [];
  for (const [index, value] of rows.entries()) {
    assertExactKeys(
      value,
      ["schema_version", "request_id", "protocol", "allowed_information_boundary", "prompt"],
      `prompt request line ${index + 1}`,
      true
    );
    if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.request_id)
        || value.protocol !== "manuscript-only-v1" || !nonEmptyString(value.prompt)
        || !Array.isArray(value.allowed_information_boundary)
        || value.allowed_information_boundary.length !== 1
        || value.allowed_information_boundary[0] !== "manuscript_text") {
      throw new Error(`Invalid prompt request line ${index + 1}.`);
    }
    const mapping = mappingByRequest.get(value.request_id);
    if (!mapping || sha256(value.prompt) !== mapping.prompt_sha256) {
      throw new Error(`Prompt request does not match its private map: ${value.request_id}`);
    }
    requestIds.push(value.request_id);
  }
  requireExactIds(requestIds, new Set(mappingByRequest.keys()), "prompt request");
}

async function validateRequestMap(input: {
  requestMap: PromotionPromptRequestMap;
  manifest: PromotionProviderRunManifest;
  expectedCaseIds: string[];
  manuscriptPathByCase: Map<string, string>;
}): Promise<void> {
  if (input.requestMap.suite_id !== input.manifest.suite_id
      || input.requestMap.protocol !== input.manifest.protocol
      || input.requestMap.requests_sha256 !== input.manifest.prompt_pack.requests_sha256
      || input.requestMap.requests.length !== input.manifest.request_count) {
    throw new Error(`Provider prompt map does not match the run manifest: ${input.manifest.trial_id}`);
  }
  requireExactIds(
    input.requestMap.requests.map((request) => request.case_id),
    new Set(input.expectedCaseIds),
    "prompt map case"
  );
  for (const request of input.requestMap.requests) {
    const manuscriptPath = input.manuscriptPathByCase.get(request.case_id);
    if (!manuscriptPath) throw new Error(`Prompt map references an unknown case: ${request.case_id}`);
    const manuscript = await readOptionalFile(manuscriptPath);
    if (sha256(manuscript) !== request.manuscript_sha256) {
      throw new Error(`Current suite manuscript does not match the executed prompt pack: ${request.case_id}`);
    }
  }
}

function parseCompletedRunManifest(value: unknown, context: string): PromotionProviderRunManifest {
  if (!isRecord(value) || value.schema_version !== "1.0" || value.status !== "completed"
      || value.protocol !== "manuscript-only-v1" || value.provider !== "openai_responses_api"
      || value.evidence_class !== "external_real_provider"
      || value.provider_receipt_status !== "recorded_not_independently_verified"
      || value.provider_identity_independently_verified !== false
      || value.external_empirical_evidence_eligible !== true
      || value.independent_trial_requirement_met !== false
      || !portableIdentifier(value.run_id) || !portableIdentifier(value.suite_id)
      || !portableIdentifier(value.system_id) || !portableIdentifier(value.trial_id)
      || !nonEmptyString(value.requested_model) || !nonEmptyString(value.reasoning_effort)
      || !validTimestamp(value.started_at) || !validTimestamp(value.completed_at)
      || Date.parse(value.completed_at) < Date.parse(value.started_at)
      || !positiveInteger(value.request_count)
      || value.completed_response_count !== value.request_count || value.failed_response_count !== 0
      || value.failure !== null || !isUsage(value.usage)
      || !isPromptPack(value.prompt_pack) || !isCompletedArtifacts(value.artifacts)) {
    throw new Error(`Invalid completed external provider run manifest: ${context}`);
  }
  return value as unknown as PromotionProviderRunManifest;
}

function parseProviderOutputs(raw: string, manifest: PromotionProviderRunManifest): Array<{
  requestId: string;
  responseReceiptHash: string;
  resolvedModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  response: PromotionProviderResponse;
}> {
  return parseJsonLines(raw, "provider output").map((value, index) => {
    const context = `line ${index + 1}`;
    assertExactKeys(value, [
      "schema_version",
      "request_id",
      "provider",
      "requested_model",
      "resolved_model",
      "reasoning_effort",
      "response_id_sha256",
      "output_text",
      "output_text_sha256",
      "usage",
      "latency_ms"
    ], `provider output ${context}`, true);
    if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.request_id)
        || value.provider !== manifest.provider || value.requested_model !== manifest.requested_model
        || !nonEmptyString(value.resolved_model) || value.reasoning_effort !== manifest.reasoning_effort
        || !isSha256(value.response_id_sha256) || !nonEmptyString(value.output_text)
        || !isSha256(value.output_text_sha256) || sha256(value.output_text) !== value.output_text_sha256
        || !isRecord(value.usage) || !nonNegativeInteger(value.usage.inputTokens)
        || !nonNegativeInteger(value.usage.outputTokens) || !nonNegativeFinite(value.usage.costUsd)
        || !nonNegativeFinite(value.latency_ms)) {
      throw new Error(`Invalid provider output ${context}.`);
    }
    assertExactKeys(value.usage, ["inputTokens", "outputTokens", "costUsd"], `provider output usage ${context}`, true);
    const response = parseStrictOutputText(value.request_id, value.output_text, value.latency_ms, value.usage.costUsd);
    return {
      requestId: value.request_id,
      responseReceiptHash: value.response_id_sha256,
      resolvedModel: value.resolved_model,
      inputTokens: value.usage.inputTokens,
      outputTokens: value.usage.outputTokens,
      costUsd: value.usage.costUsd,
      response
    };
  });
}

function parseProviderResponses(raw: string): PromotionProviderResponse[] {
  return parseJsonLines(raw, "provider response").map((value, index) => {
    assertExactKeys(value, ["request_id", "decision", "concerns", "repair_owners", "latency_ms", "cost_usd"], `provider response line ${index + 1}`);
    assertConcernKeys(value, `provider response line ${index + 1}`);
    return parsePromotionProviderResponse(value, `line ${index + 1}`);
  });
}

function parsePredictions(raw: string): PromotionBenchmarkPrediction[] {
  return parseJsonLines(raw, "prediction").map((value, index) => {
    assertExactKeys(
      value,
      ["case_id", "system_id", "trial_id", "decision", "concerns", "repair_owners", "latency_ms", "cost_usd"],
      `prediction line ${index + 1}`
    );
    assertConcernKeys(value, `prediction line ${index + 1}`);
    if (!isRecord(value) || !nonEmptyString(value.case_id) || !nonEmptyString(value.system_id)
        || !nonEmptyString(value.trial_id) || !isPromotionDecision(value.decision)
        || !Array.isArray(value.concerns) || !stringArray(value.repair_owners)
        || (value.latency_ms !== undefined && !nonNegativeFinite(value.latency_ms))
        || (value.cost_usd !== undefined && !nonNegativeFinite(value.cost_usd))) {
      throw new Error(`Invalid prediction line ${index + 1}.`);
    }
    const response = parsePromotionProviderResponse({ request_id: "validation", ...value }, `prediction line ${index + 1}`);
    return {
      case_id: value.case_id,
      system_id: value.system_id,
      trial_id: value.trial_id,
      decision: response.decision,
      concerns: response.concerns,
      repair_owners: response.repair_owners,
      ...(response.latency_ms !== undefined ? { latency_ms: response.latency_ms } : {}),
      ...(response.cost_usd !== undefined ? { cost_usd: response.cost_usd } : {})
    };
  });
}

function parseStrictOutputText(
  requestId: string,
  text: string,
  latencyMs: number,
  costUsd: number
): PromotionProviderResponse {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error(`Provider output text is not valid JSON: ${requestId}`);
  }
  assertExactKeys(value, ["decision", "concerns", "repair_owners"], `provider output text ${requestId}`, true);
  assertConcernKeys(value, `provider output text ${requestId}`);
  return parsePromotionProviderResponse({
    request_id: requestId,
    ...(value as Record<string, unknown>),
    latency_ms: latencyMs,
    cost_usd: costUsd
  }, requestId);
}

function assertConcernKeys(value: unknown, context: string): void {
  if (!isRecord(value) || !Array.isArray(value.concerns)) return;
  for (const concern of value.concerns) {
    assertExactKeys(concern, ["code", "severity", "evidence_refs"], `${context} concern`);
  }
}

function assertExactKeys(value: unknown, allowed: string[], context: string, requireAll = false): void {
  if (!isRecord(value)) throw new Error(`Invalid ${context}.`);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || (requireAll && allowed.some((key) => !keys.includes(key)))) {
    throw new Error(`Unexpected fields in ${context}.`);
  }
}

function normalizedResponseJson(response: PromotionProviderResponse): string {
  return JSON.stringify({
    decision: response.decision,
    concerns: response.concerns,
    repair_owners: response.repair_owners,
    ...(response.latency_ms !== undefined ? { latency_ms: response.latency_ms } : {}),
    ...(response.cost_usd !== undefined ? { cost_usd: response.cost_usd } : {})
  });
}

function normalizedPredictionJson(prediction: PromotionBenchmarkPrediction): string {
  return JSON.stringify({
    decision: prediction.decision,
    concerns: prediction.concerns,
    repair_owners: prediction.repair_owners,
    ...(prediction.latency_ms !== undefined ? { latency_ms: prediction.latency_ms } : {}),
    ...(prediction.cost_usd !== undefined ? { cost_usd: prediction.cost_usd } : {})
  });
}

function requireExactIds(actual: string[], expected: Set<string>, label: string): void {
  if (actual.length !== expected.size || new Set(actual).size !== actual.length
      || actual.some((value) => !expected.has(value))) {
    throw new Error(`${label} coverage is incomplete, duplicated, or unexpected.`);
  }
}

function parseJsonLines(raw: string, label: string): unknown[] {
  const rows: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${label} line ${index + 1} is not valid JSON.`);
    }
  }
  if (rows.length === 0) throw new Error(`${label} artifact is empty.`);
  return rows;
}

async function resolveRunArtifact(cwd: string, runRoot: string, ref: string, label: string): Promise<string> {
  const candidate = await resolveExistingInside(cwd, path.resolve(cwd, ref), `Provider run ${label}`);
  assertStrictlyInside(runRoot, candidate, `Provider run ${label}`);
  return candidate;
}

function resolveRunArtifactTarget(cwd: string, runRoot: string, ref: string, label: string): string {
  const candidate = path.resolve(cwd, ref);
  assertStrictlyInside(cwd, candidate, `Provider run ${label}`);
  assertStrictlyInside(runRoot, candidate, `Provider run ${label}`);
  return candidate;
}

async function resolveExistingInside(root: string, candidate: string, label: string): Promise<string> {
  assertStrictlyInside(root, candidate, label);
  const realPath = await fs.realpath(candidate);
  assertStrictlyInside(root, realPath, label);
  return realPath;
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside ${root}.`);
  }
}

async function verifyFileHash(filePath: string, expected: string, label: string): Promise<void> {
  if (await sha256File(filePath) !== expected) throw new Error(`Provider run ${label} SHA-256 mismatch.`);
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error(`Promotion provider aggregate output already exists: ${outDir}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function requireMissingArtifact(filePath: string, message: string): Promise<void> {
  try {
    await fs.lstat(filePath);
    throw new Error(message);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableRef(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replace(/\\/gu, "/");
}

function isPromptPack(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.requests_path) && isSha256(value.requests_sha256)
    && nonEmptyString(value.private_map_path) && isSha256(value.private_map_sha256);
}

function isCompletedArtifacts(value: unknown): boolean {
  return isRecord(value) && nonEmptyString(value.provider_outputs_path)
    && isSha256(value.provider_outputs_sha256) && nonEmptyString(value.provider_responses_path)
    && isSha256(value.provider_responses_sha256) && nonEmptyString(value.predictions_path)
    && isSha256(value.predictions_sha256) && nonEmptyString(value.failures_path)
    && value.failures_sha256 === null;
}

function isUsage(value: unknown): boolean {
  return isRecord(value) && nonNegativeInteger(value.input_tokens)
    && nonNegativeInteger(value.output_tokens) && nonNegativeFinite(value.cost_usd);
}

function validTimestamp(value: unknown): value is string {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function portableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isPromotionDecision(value: unknown): value is PromotionDecision {
  return typeof value === "string" && (PROMOTION_DECISIONS as readonly string[]).includes(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
