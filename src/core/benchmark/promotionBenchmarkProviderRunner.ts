import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

import { writeJsonFile } from "../../utils/fs.js";
import {
  hashPromotionBenchmarkSuiteSnapshot,
  loadPromotionBenchmarkSuite,
  type PromotionBenchmarkEvidenceClass
} from "./promotionBenchmark.js";
import {
  buildOpenAiResponsesModelChoices,
  buildOpenAiResponsesReasoningChoices
} from "../../integrations/openai/modelCatalog.js";
import {
  exportPromotionBenchmarkPromptPack,
  importPromotionBenchmarkResponses,
  parsePromotionPromptRequestMap,
  parsePromotionProviderResponse,
  type PromotionPromptRequest,
  type PromotionProviderResponse
} from "./promotionBenchmarkPromptPack.js";

export type PromotionProviderName = "openai_responses_api" | "ollama_local";
export type PromotionProviderEvidenceClass = "external_real_provider" | "local_real_model" | "test_fixture";
export type PromotionExecutionEnvironment = "remote_api" | "local_runtime" | "test_fixture";
export type PromotionExecutionReceiptKind = "provider_response_id" | "local_runtime_record" | "test_fixture";

export interface PromotionProviderCompletion {
  text: string;
  responseId?: string;
  model?: string;
  totalDurationNs?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
  };
}

export interface PromotionProviderClient {
  complete(input: {
    prompt: string;
    model: string;
    reasoningEffort: string;
  }): Promise<PromotionProviderCompletion>;
}

export interface RunPromotionProviderInput {
  cwd: string;
  suitePath: string;
  outDir: string;
  provider: PromotionProviderName;
  model: string;
  modelArtifactDigest?: string;
  reasoningEffort: string;
  systemId: string;
  trialId: string;
  evidenceClass: PromotionProviderEvidenceClass;
}

export interface PromotionProviderSourceSuiteBinding {
  path: string;
  manifest_sha256: string;
  snapshot_sha256: string;
  evidence_class: PromotionBenchmarkEvidenceClass | "unspecified";
  paper_claim_eligible: boolean;
}

export interface PromotionProviderRunManifest {
  schema_version: "1.2";
  run_id: string;
  status: "running" | "completed" | "failed";
  protocol: "manuscript-only-v1";
  provider: PromotionProviderName;
  evidence_class: PromotionProviderEvidenceClass;
  execution_environment: PromotionExecutionEnvironment;
  execution_receipt_status: "recorded_not_independently_verified" | "local_runtime_hash_bound" | "test_fixture";
  provider_identity_independently_verified: false;
  external_empirical_evidence_eligible: boolean;
  real_model_empirical_evidence_eligible: boolean;
  paper_claim_evidence_eligible: boolean;
  independent_trial_requirement_met: false;
  evidence_boundary: string;
  suite_id: string;
  source_suite: PromotionProviderSourceSuiteBinding;
  system_id: string;
  trial_id: string;
  requested_model: string;
  model_artifact_digest: string | null;
  reasoning_effort: string;
  started_at: string;
  completed_at: string | null;
  request_count: number;
  completed_response_count: number;
  failed_response_count: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cost_usd: number;
  };
  prompt_pack: {
    requests_path: string;
    requests_sha256: string;
    private_map_path: string;
    private_map_sha256: string;
  };
  artifacts: {
    provider_outputs_path: string;
    provider_outputs_sha256: string | null;
    provider_responses_path: string;
    provider_responses_sha256: string | null;
    predictions_path: string | null;
    predictions_sha256: string | null;
    failures_path: string;
    failures_sha256: string | null;
  };
  failure: {
    request_id: string | null;
    error_name: string;
    message: string;
  } | null;
}

export interface RunPromotionProviderResult {
  manifest: PromotionProviderRunManifest;
  manifest_path: string;
  predictions_path: string;
}

export async function runPromotionBenchmarkProvider(
  input: RunPromotionProviderInput,
  client: PromotionProviderClient
): Promise<RunPromotionProviderResult> {
  validateInput(input);
  const cwd = path.resolve(input.cwd);
  const outDir = path.resolve(cwd, input.outDir);
  assertInside(cwd, outDir, "Provider output directory");
  await assertFreshOutput(outDir);
  assertRealModelEnvironment(input.evidenceClass);
  const sourceSuite = await inspectSourceSuite(cwd, input.suitePath);

  const promptPackDir = path.join(outDir, "prompt-pack");
  const exported = await exportPromotionBenchmarkPromptPack({
    cwd,
    suitePath: input.suitePath,
    outDir: promptPackDir
  });
  const requestsPath = path.join(promptPackDir, "requests.jsonl");
  const privateMapPath = path.join(promptPackDir, "private-request-map.json");
  const requestsText = await fs.readFile(requestsPath, "utf8");
  const privateMapText = await fs.readFile(privateMapPath, "utf8");
  const requestMap = parsePromotionPromptRequestMap(JSON.parse(privateMapText));
  if (sha256(requestsText) !== requestMap.requests_sha256
      || requestMap.requests_sha256 !== exported.requests_sha256) {
    throw new Error("Promotion provider prompt pack hash verification failed.");
  }
  const requests = parsePromptRequests(requestsText, requestMap);

  const providerOutputsPath = path.join(outDir, "provider-outputs.jsonl");
  const providerResponsesPath = path.join(outDir, "provider-responses.jsonl");
  const failuresPath = path.join(outDir, "provider-failures.jsonl");
  const manifestPath = path.join(outDir, "provider-run-manifest.json");
  const predictionsDir = path.join(outDir, "predictions");
  const startedAt = new Date().toISOString();
  const manifest: PromotionProviderRunManifest = {
    schema_version: "1.2",
    run_id: `provider-run-${sha256([
      requestMap.suite_id,
      input.systemId,
      input.trialId,
      input.provider,
      input.model,
      input.modelArtifactDigest || "no-model-artifact-digest",
      input.reasoningEffort,
      startedAt
    ].join("\0")).slice(0, 16)}`,
    status: "running",
    protocol: "manuscript-only-v1",
    provider: input.provider,
    evidence_class: input.evidenceClass,
    execution_environment: executionEnvironment(input),
    execution_receipt_status: executionReceiptStatus(input),
    provider_identity_independently_verified: false,
    external_empirical_evidence_eligible: false,
    real_model_empirical_evidence_eligible: false,
    paper_claim_evidence_eligible: false,
    independent_trial_requirement_met: false,
    evidence_boundary: input.provider === "ollama_local"
      ? "This manifest records a hash-bound local model execution with an exact model artifact digest. The runtime receipt is self-recorded rather than issued by an external provider. Paper-claim evidence additionally requires a paper-claim-eligible source suite, a valid three-trial aggregate, and the downstream confirmatory gate."
      : "This manifest distinguishes a recorded external provider execution from paper-claim eligibility. Paper-claim evidence additionally requires a paper-claim-eligible source suite, a valid three-trial aggregate, and the downstream confirmatory gate.",
    suite_id: requestMap.suite_id,
    source_suite: sourceSuite,
    system_id: input.systemId,
    trial_id: input.trialId,
    requested_model: input.model,
    model_artifact_digest: input.modelArtifactDigest || null,
    reasoning_effort: input.reasoningEffort,
    started_at: startedAt,
    completed_at: null,
    request_count: requests.length,
    completed_response_count: 0,
    failed_response_count: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0
    },
    prompt_pack: {
      requests_path: portableRef(cwd, requestsPath),
      requests_sha256: requestMap.requests_sha256,
      private_map_path: portableRef(cwd, privateMapPath),
      private_map_sha256: sha256(privateMapText)
    },
    artifacts: {
      provider_outputs_path: portableRef(cwd, providerOutputsPath),
      provider_outputs_sha256: null,
      provider_responses_path: portableRef(cwd, providerResponsesPath),
      provider_responses_sha256: null,
      predictions_path: null,
      predictions_sha256: null,
      failures_path: portableRef(cwd, failuresPath),
      failures_sha256: null
    },
    failure: null
  };
  await writeJsonFile(manifestPath, manifest);

  let activeRequestId: string | null = null;
  try {
    for (const request of requests) {
      activeRequestId = request.request_id;
      const requestStartedAt = Date.now();
      const requestStartedAtIso = new Date(requestStartedAt).toISOString();
      const completion = await client.complete({
        prompt: request.prompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort
      });
      const requestCompletedAt = Date.now();
      const latencyMs = requestCompletedAt - requestStartedAt;
      validateCompletionProvenance(completion, input.evidenceClass, request.request_id);
      const receipt = buildExecutionReceipt({
        input,
        runId: manifest.run_id,
        requestId: request.request_id,
        requestStartedAt: requestStartedAtIso,
        requestCompletedAt: new Date(requestCompletedAt).toISOString(),
        latencyMs,
        completion
      });
      const response = parseCompletion(request.request_id, completion.text, latencyMs, completion.usage?.costUsd);
      const outputRecord = {
        schema_version: "1.0",
        request_id: request.request_id,
        provider: input.provider,
        requested_model: input.model,
        resolved_model: completion.model || input.model,
        model_artifact_digest: input.modelArtifactDigest || null,
        reasoning_effort: input.reasoningEffort,
        execution_receipt_kind: receipt.kind,
        execution_receipt_sha256: receipt.sha256,
        output_text: completion.text,
        output_text_sha256: sha256(completion.text),
        usage: completion.usage || null,
        latency_ms: latencyMs
      };
      await fs.appendFile(providerOutputsPath, `${JSON.stringify(outputRecord)}\n`, "utf8");
      await fs.appendFile(providerResponsesPath, `${JSON.stringify(response)}\n`, "utf8");
      manifest.completed_response_count += 1;
      manifest.usage.input_tokens += completion.usage?.inputTokens || 0;
      manifest.usage.output_tokens += completion.usage?.outputTokens || 0;
      manifest.usage.cost_usd += completion.usage?.costUsd || 0;
      manifest.artifacts.provider_outputs_sha256 = await sha256File(providerOutputsPath);
      manifest.artifacts.provider_responses_sha256 = await sha256File(providerResponsesPath);
      await writeJsonFile(manifestPath, manifest);
    }

    const imported = await importPromotionBenchmarkResponses({
      cwd,
      requestMapPath: privateMapPath,
      responsesPath: providerResponsesPath,
      systemId: input.systemId,
      trialId: input.trialId,
      outDir: predictionsDir
    });
    const predictionsPath = path.resolve(cwd, imported.predictions_path);
    manifest.status = "completed";
    manifest.completed_at = new Date().toISOString();
    manifest.external_empirical_evidence_eligible = input.evidenceClass === "external_real_provider";
    manifest.real_model_empirical_evidence_eligible = input.evidenceClass !== "test_fixture";
    manifest.paper_claim_evidence_eligible = input.evidenceClass !== "test_fixture"
      && sourceSuite.paper_claim_eligible;
    manifest.artifacts.predictions_path = portableRef(cwd, predictionsPath);
    manifest.artifacts.predictions_sha256 = await sha256File(predictionsPath);
    await writeJsonFile(manifestPath, manifest);
    return {
      manifest,
      manifest_path: portableRef(cwd, manifestPath),
      predictions_path: portableRef(cwd, predictionsPath)
    };
  } catch (error) {
    const failure = normalizeFailure(error, activeRequestId);
    await fs.appendFile(failuresPath, `${JSON.stringify({
      schema_version: "1.0",
      ...failure
    })}\n`, "utf8");
    manifest.status = "failed";
    manifest.completed_at = new Date().toISOString();
    manifest.failed_response_count = 1;
    manifest.failure = failure;
    manifest.artifacts.failures_sha256 = await sha256File(failuresPath);
    manifest.artifacts.provider_outputs_sha256 = await sha256FileIfPresent(providerOutputsPath);
    manifest.artifacts.provider_responses_sha256 = await sha256FileIfPresent(providerResponsesPath);
    await writeJsonFile(manifestPath, manifest);
    throw new Error(
      `Promotion provider run failed; partial artifacts were preserved at ${portableRef(cwd, outDir)}: ${failure.message}`
    );
  }
}

async function inspectSourceSuite(
  cwd: string,
  suiteInputPath: string
): Promise<PromotionProviderSourceSuiteBinding> {
  const requestedSuitePath = path.resolve(cwd, suiteInputPath);
  assertStrictlyInside(cwd, requestedSuitePath, "Promotion suite");
  const suitePath = await fs.realpath(requestedSuitePath);
  assertStrictlyInside(cwd, suitePath, "Promotion suite");
  const loaded = await loadPromotionBenchmarkSuite(suitePath);
  if (!loaded.suite || loaded.issues.length > 0) {
    throw new Error(`Promotion benchmark suite validation failed: ${loaded.issues.map((issue) => issue.code).join(", ")}`);
  }
  return {
    path: portableRef(cwd, suitePath),
    manifest_sha256: await sha256File(suitePath),
    snapshot_sha256: await hashPromotionBenchmarkSuiteSnapshot(suitePath),
    evidence_class: loaded.suite.manifest.evidence_class || "unspecified",
    paper_claim_eligible: loaded.suite.manifest.paper_claim_eligible === true
  };
}

function parsePromptRequests(
  raw: string,
  requestMap: ReturnType<typeof parsePromotionPromptRequestMap>
): PromotionPromptRequest[] {
  const requests: PromotionPromptRequest[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Promotion prompt request line ${index + 1} is not valid JSON.`);
    }
    if (!isRecord(value) || value.schema_version !== "1.0" || !nonEmptyString(value.request_id)
        || value.protocol !== "manuscript-only-v1" || !nonEmptyString(value.prompt)
        || !Array.isArray(value.allowed_information_boundary)
        || value.allowed_information_boundary.length !== 1
        || value.allowed_information_boundary[0] !== "manuscript_text") {
      throw new Error(`Promotion prompt request line ${index + 1} has an invalid schema.`);
    }
    requests.push({
      schema_version: "1.0",
      request_id: value.request_id,
      protocol: "manuscript-only-v1",
      allowed_information_boundary: ["manuscript_text"],
      prompt: value.prompt
    });
  }
  if (requests.length === 0 || requests.length !== requestMap.requests.length
      || new Set(requests.map((request) => request.request_id)).size !== requests.length) {
    throw new Error("Promotion provider prompt pack request coverage is invalid.");
  }
  const mapById = new Map(requestMap.requests.map((request) => [request.request_id, request] as const));
  for (const request of requests) {
    const mapped = mapById.get(request.request_id);
    if (!mapped || sha256(request.prompt) !== mapped.prompt_sha256) {
      throw new Error(`Promotion provider prompt hash mismatch: ${request.request_id}`);
    }
  }
  return requests;
}

function parseCompletion(
  requestId: string,
  text: string,
  latencyMs: number,
  costUsd: number | undefined
): PromotionProviderResponse {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error(`Provider output is not one JSON object: ${requestId}`);
  }
  if (!isRecord(value)
      || Object.keys(value).sort().join(",") !== "concerns,decision,repair_owners") {
    throw new Error(`Provider output has unexpected top-level fields: ${requestId}`);
  }
  if (!Array.isArray(value.concerns) || value.concerns.some((concern) =>
    !isRecord(concern)
      || Object.keys(concern).sort().join(",") !== "code,evidence_refs,severity")) {
    throw new Error(`Provider output has unexpected concern fields: ${requestId}`);
  }
  return parsePromotionProviderResponse({
    request_id: requestId,
    ...value,
    latency_ms: latencyMs,
    ...(costUsd !== undefined ? { cost_usd: costUsd } : {})
  }, requestId);
}

function validateCompletionProvenance(
  completion: PromotionProviderCompletion,
  evidenceClass: PromotionProviderEvidenceClass,
  requestId: string
): void {
  if (!completion.text.trim()) throw new Error(`Provider returned empty output: ${requestId}`);
  if (evidenceClass === "test_fixture") return;
  if (evidenceClass === "external_real_provider" && !completion.responseId?.trim()) {
    throw new Error(`External provider response id is missing: ${requestId}`);
  }
  if (!completion.model?.trim()) {
    throw new Error(`Real model execution resolved model is missing: ${requestId}`);
  }
  if (!completion.usage
      || !nonNegativeInteger(completion.usage.inputTokens)
      || !nonNegativeInteger(completion.usage.outputTokens)
      || !nonNegativeFinite(completion.usage.costUsd)) {
    throw new Error(`Real model execution token usage or cost is missing: ${requestId}`);
  }
  if (evidenceClass === "local_real_model"
      && (!positiveFinite(completion.totalDurationNs))) {
    throw new Error(`Local model runtime duration is missing: ${requestId}`);
  }
}

function validateInput(input: RunPromotionProviderInput): void {
  for (const [name, value] of Object.entries({
    suitePath: input.suitePath,
    outDir: input.outDir,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    systemId: input.systemId,
    trialId: input.trialId
  })) {
    if (!nonEmptyString(value)) throw new Error(`Promotion provider input requires ${name}.`);
  }
  if (!buildOpenAiResponsesModelChoices().includes(input.model)) {
    if (input.provider === "openai_responses_api") {
      throw new Error(`Unsupported OpenAI Responses model: ${input.model}.`);
    }
  }
  if (input.provider === "openai_responses_api"
      && !buildOpenAiResponsesReasoningChoices(input.model).includes(input.reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort for ${input.model}: ${input.reasoningEffort}.`);
  }
  if (input.provider === "ollama_local" && input.reasoningEffort !== "off") {
    throw new Error("Ollama promotion runs currently require reasoningEffort=off for JSON-only evaluation.");
  }
  if (input.provider === "ollama_local" && !validModelArtifactDigest(input.modelArtifactDigest)) {
    throw new Error("Ollama promotion runs require a model artifact digest.");
  }
  if (input.provider === "openai_responses_api" && input.evidenceClass === "local_real_model") {
    throw new Error("OpenAI Responses runs cannot use local_real_model evidence class.");
  }
  if (input.provider === "ollama_local" && input.evidenceClass === "external_real_provider") {
    throw new Error("Ollama runs cannot use external_real_provider evidence class.");
  }
  if (!portableIdentifier(input.systemId) || !portableIdentifier(input.trialId)) {
    throw new Error("Promotion provider systemId and trialId must be portable identifiers.");
  }
}

function assertRealModelEnvironment(evidenceClass: PromotionProviderEvidenceClass): void {
  if (evidenceClass === "test_fixture") return;
  const fakeVariables = [
    "AUTOLABOS_FAKE_OPENAI_RESPONSE",
    "AUTOLABOS_FAKE_OPENAI_RESPONSE_SEQUENCE",
    "AUTOLABOS_FAKE_OPENAI_RESPONSE_ID",
    "AUTOLABOS_FAKE_OLLAMA_RESPONSE",
    "AUTOLABOS_FAKE_OLLAMA_RESPONSE_SEQUENCE"
  ];
  const active = fakeVariables.filter((name) => process.env[name]?.trim());
  if (active.length > 0) {
    throw new Error(`Real model evidence rejects fake response environment variables: ${active.join(", ")}`);
  }
}

function executionEnvironment(input: RunPromotionProviderInput): PromotionExecutionEnvironment {
  if (input.evidenceClass === "test_fixture") return "test_fixture";
  return input.provider === "ollama_local" ? "local_runtime" : "remote_api";
}

function executionReceiptStatus(
  input: RunPromotionProviderInput
): PromotionProviderRunManifest["execution_receipt_status"] {
  if (input.evidenceClass === "test_fixture") return "test_fixture";
  return input.provider === "ollama_local"
    ? "local_runtime_hash_bound"
    : "recorded_not_independently_verified";
}

function buildExecutionReceipt(input: {
  input: RunPromotionProviderInput;
  runId: string;
  requestId: string;
  requestStartedAt: string;
  requestCompletedAt: string;
  latencyMs: number;
  completion: PromotionProviderCompletion;
}): { kind: PromotionExecutionReceiptKind; sha256: string } {
  if (input.input.evidenceClass === "test_fixture") {
    return {
      kind: "test_fixture",
      sha256: sha256(JSON.stringify({
        request_id: input.requestId,
        output_sha256: sha256(input.completion.text)
      }))
    };
  }
  if (input.input.provider === "openai_responses_api") {
    return {
      kind: "provider_response_id",
      sha256: sha256(input.completion.responseId as string)
    };
  }
  return {
    kind: "local_runtime_record",
    sha256: sha256(JSON.stringify({
      provider: input.input.provider,
      run_id: input.runId,
      request_id: input.requestId,
      requested_model: input.input.model,
      resolved_model: input.completion.model,
      model_artifact_digest: input.input.modelArtifactDigest,
      request_started_at: input.requestStartedAt,
      request_completed_at: input.requestCompletedAt,
      latency_ms: input.latencyMs,
      total_duration_ns: input.completion.totalDurationNs,
      input_tokens: input.completion.usage?.inputTokens,
      output_tokens: input.completion.usage?.outputTokens,
      output_sha256: sha256(input.completion.text)
    }))
  };
}

async function assertFreshOutput(outDir: string): Promise<void> {
  try {
    await fs.lstat(outDir);
    throw new Error(`Promotion provider output already exists: ${outDir}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function assertInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a new directory inside the workspace.`);
  }
}

function assertStrictlyInside(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the workspace.`);
  }
}

function normalizeFailure(
  error: unknown,
  requestId: string | null
): PromotionProviderRunManifest["failure"] & {} {
  return {
    request_id: requestId,
    error_name: error instanceof Error ? error.name : "Error",
    message: error instanceof Error ? error.message : String(error)
  };
}

async function sha256File(filePath: string): Promise<string> {
  return sha256(await fs.readFile(filePath));
}

async function sha256FileIfPresent(filePath: string): Promise<string | null> {
  try {
    return await sha256File(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function portableRef(cwd: string, absolutePath: string): string {
  return path.relative(cwd, absolutePath).replace(/\\/gu, "/");
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function portableIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validModelArtifactDigest(value: unknown): value is string {
  return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{12,64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
