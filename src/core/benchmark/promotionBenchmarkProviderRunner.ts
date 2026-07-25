import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
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

const STALE_RUNNING_PROVIDER_CHECKPOINT_MS = 10 * 60 * 1000;
const PROVIDER_LEASE_HEARTBEAT_MS = 30 * 1000;

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
  resume?: boolean;
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
  resume_count: number;
  attempt_failure_count: number;
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
    attempt_failures_path: string;
    attempt_failures_sha256: string | null;
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
  assertRealModelEnvironment(input.evidenceClass);
  const sourceSuite = await inspectSourceSuite(cwd, input.suitePath);
  const lease = await acquireProviderRunLease(outDir);
  try {
  const prepared = await prepareProviderRun({ cwd, outDir, sourceSuite, input, lease });
  const {
    requests,
    privateMapPath,
    providerOutputsPath,
    providerResponsesPath,
    failuresPath,
    manifestPath,
    predictionsDir,
    manifest
  } = prepared;

  let activeRequestId: string | null = null;
  try {
    for (const request of requests.slice(manifest.completed_response_count)) {
      activeRequestId = request.request_id;
      const requestStartedAt = Date.now();
      const requestStartedAtIso = new Date(requestStartedAt).toISOString();
      const completion = await client.complete({
        prompt: request.prompt,
        model: input.model,
        reasoningEffort: input.reasoningEffort
      });
      await lease.assertOwned();
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
      await lease.assertOwned();
      await fs.appendFile(providerResponsesPath, `${JSON.stringify(response)}\n`, "utf8");
      manifest.completed_response_count += 1;
      manifest.usage.input_tokens += completion.usage?.inputTokens || 0;
      manifest.usage.output_tokens += completion.usage?.outputTokens || 0;
      manifest.usage.cost_usd += completion.usage?.costUsd || 0;
      manifest.artifacts.provider_outputs_sha256 = await sha256File(providerOutputsPath);
      manifest.artifacts.provider_responses_sha256 = await sha256File(providerResponsesPath);
      await writeJsonFile(manifestPath, manifest);
    }

    await lease.assertOwned();
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
    await lease.assertOwned();
    await writeJsonFile(manifestPath, manifest);
    return {
      manifest,
      manifest_path: portableRef(cwd, manifestPath),
      predictions_path: portableRef(cwd, predictionsPath)
    };
  } catch (error) {
    try {
      await lease.assertOwned();
    } catch {
      throw new Error("Promotion provider run lost its exclusive writer lease; no failure artifact was written.");
    }
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
  } finally {
    await lease.release();
  }
}

interface PreparedProviderRun {
  requests: PromotionPromptRequest[];
  privateMapPath: string;
  providerOutputsPath: string;
  providerResponsesPath: string;
  failuresPath: string;
  manifestPath: string;
  predictionsDir: string;
  manifest: PromotionProviderRunManifest;
}

interface ProviderRunLease {
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}

interface ProviderRunLeaseRecord {
  schema_version: "1.0";
  owner_token: string;
  process_id: number;
  acquired_at: string;
  heartbeat_at: string;
}

async function prepareProviderRun(input: {
  cwd: string;
  outDir: string;
  sourceSuite: PromotionProviderSourceSuiteBinding;
  input: RunPromotionProviderInput;
  lease: ProviderRunLease;
}): Promise<PreparedProviderRun> {
  if (input.input.resume) return prepareResumedProviderRun(input);
  await assertFreshOutput(input.outDir);

  const promptPackDir = path.join(input.outDir, "prompt-pack");
  const exported = await exportPromotionBenchmarkPromptPack({
    cwd: input.cwd,
    suitePath: input.input.suitePath,
    outDir: promptPackDir
  });
  await input.lease.assertOwned();
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
  const providerOutputsPath = path.join(input.outDir, "provider-outputs.jsonl");
  const providerResponsesPath = path.join(input.outDir, "provider-responses.jsonl");
  const failuresPath = path.join(input.outDir, "provider-failures.jsonl");
  const attemptFailuresPath = path.join(input.outDir, "provider-attempt-failures.jsonl");
  const manifestPath = path.join(input.outDir, "provider-run-manifest.json");
  const predictionsDir = path.join(input.outDir, "predictions");
  const startedAt = new Date().toISOString();
  const manifest: PromotionProviderRunManifest = {
    schema_version: "1.2",
    run_id: `provider-run-${sha256([
      requestMap.suite_id,
      input.input.systemId,
      input.input.trialId,
      input.input.provider,
      input.input.model,
      input.input.modelArtifactDigest || "no-model-artifact-digest",
      input.input.reasoningEffort,
      startedAt
    ].join("\0")).slice(0, 16)}`,
    status: "running",
    protocol: "manuscript-only-v1",
    provider: input.input.provider,
    evidence_class: input.input.evidenceClass,
    execution_environment: executionEnvironment(input.input),
    execution_receipt_status: executionReceiptStatus(input.input),
    provider_identity_independently_verified: false,
    external_empirical_evidence_eligible: false,
    real_model_empirical_evidence_eligible: false,
    paper_claim_evidence_eligible: false,
    independent_trial_requirement_met: false,
    evidence_boundary: input.input.provider === "ollama_local"
      ? "This manifest records a hash-bound local model execution with an exact model artifact digest. The runtime receipt is self-recorded rather than issued by an external provider. Paper-claim evidence additionally requires a paper-claim-eligible source suite, a valid three-trial aggregate, and the downstream confirmatory gate."
      : "This manifest distinguishes a recorded external provider execution from paper-claim eligibility. Paper-claim evidence additionally requires a paper-claim-eligible source suite, a valid three-trial aggregate, and the downstream confirmatory gate.",
    suite_id: requestMap.suite_id,
    source_suite: input.sourceSuite,
    system_id: input.input.systemId,
    trial_id: input.input.trialId,
    requested_model: input.input.model,
    model_artifact_digest: input.input.modelArtifactDigest || null,
    reasoning_effort: input.input.reasoningEffort,
    started_at: startedAt,
    completed_at: null,
    request_count: requests.length,
    completed_response_count: 0,
    failed_response_count: 0,
    resume_count: 0,
    attempt_failure_count: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0
    },
    prompt_pack: {
      requests_path: portableRef(input.cwd, requestsPath),
      requests_sha256: requestMap.requests_sha256,
      private_map_path: portableRef(input.cwd, privateMapPath),
      private_map_sha256: sha256(privateMapText)
    },
    artifacts: {
      provider_outputs_path: portableRef(input.cwd, providerOutputsPath),
      provider_outputs_sha256: null,
      provider_responses_path: portableRef(input.cwd, providerResponsesPath),
      provider_responses_sha256: null,
      predictions_path: null,
      predictions_sha256: null,
      failures_path: portableRef(input.cwd, failuresPath),
      failures_sha256: null,
      attempt_failures_path: portableRef(input.cwd, attemptFailuresPath),
      attempt_failures_sha256: null
    },
    failure: null
  };
  await writeJsonFile(manifestPath, manifest);
  return {
    requests,
    privateMapPath,
    providerOutputsPath,
    providerResponsesPath,
    failuresPath,
    manifestPath,
    predictionsDir,
    manifest
  };
}

async function prepareResumedProviderRun(input: {
  cwd: string;
  outDir: string;
  sourceSuite: PromotionProviderSourceSuiteBinding;
  input: RunPromotionProviderInput;
  lease: ProviderRunLease;
}): Promise<PreparedProviderRun> {
  const promptPackDir = path.join(input.outDir, "prompt-pack");
  const requestsPath = path.join(promptPackDir, "requests.jsonl");
  const privateMapPath = path.join(promptPackDir, "private-request-map.json");
  const providerOutputsPath = path.join(input.outDir, "provider-outputs.jsonl");
  const providerResponsesPath = path.join(input.outDir, "provider-responses.jsonl");
  const failuresPath = path.join(input.outDir, "provider-failures.jsonl");
  const attemptFailuresPath = path.join(input.outDir, "provider-attempt-failures.jsonl");
  const manifestPath = path.join(input.outDir, "provider-run-manifest.json");
  const predictionsDir = path.join(input.outDir, "predictions");
  const rawManifestText = await fs.readFile(manifestPath, "utf8");
  const rawManifest = JSON.parse(rawManifestText) as unknown;
  if (!isRecord(rawManifest) || rawManifest.schema_version !== "1.2"
      || (rawManifest.status !== "failed" && rawManifest.status !== "running")) {
    throw new Error("Promotion provider resume requires one failed or stale-running schema-1.2 run manifest.");
  }
  const manifest = rawManifest as unknown as PromotionProviderRunManifest;
  const failedResume = manifest.status === "failed";
  const interruptedResume = manifest.status === "running";
  if (manifest.provider !== input.input.provider
      || manifest.evidence_class !== input.input.evidenceClass
      || manifest.system_id !== input.input.systemId
      || manifest.trial_id !== input.input.trialId
      || manifest.requested_model !== input.input.model
      || manifest.model_artifact_digest !== (input.input.modelArtifactDigest || null)
      || manifest.reasoning_effort !== input.input.reasoningEffort
      || manifest.protocol !== "manuscript-only-v1"
      || !sameSourceSuiteBinding(manifest.source_suite, input.sourceSuite)
      || (failedResume && (manifest.failure === null || manifest.failed_response_count !== 1))
      || (interruptedResume && (manifest.failure !== null || manifest.failed_response_count !== 0
        || manifest.completed_at !== null))
      || manifest.artifacts.predictions_path !== null
      || manifest.artifacts.predictions_sha256 !== null) {
    throw new Error("Promotion provider resume input does not match the interrupted run contract.");
  }
  if (interruptedResume) {
    const manifestAgeMs = Date.now() - (await fs.stat(manifestPath)).mtimeMs;
    if (manifestAgeMs < STALE_RUNNING_PROVIDER_CHECKPOINT_MS) {
      throw new Error("Promotion provider resume refuses a running checkpoint that is not stale.");
    }
  }
  const expectedRefs = {
    requests: portableRef(input.cwd, requestsPath),
    privateMap: portableRef(input.cwd, privateMapPath),
    outputs: portableRef(input.cwd, providerOutputsPath),
    responses: portableRef(input.cwd, providerResponsesPath),
    failures: portableRef(input.cwd, failuresPath)
  };
  if (manifest.prompt_pack.requests_path !== expectedRefs.requests
      || manifest.prompt_pack.private_map_path !== expectedRefs.privateMap
      || manifest.artifacts.provider_outputs_path !== expectedRefs.outputs
      || manifest.artifacts.provider_responses_path !== expectedRefs.responses
      || manifest.artifacts.failures_path !== expectedRefs.failures) {
    throw new Error("Promotion provider resume artifact paths do not match the run directory.");
  }

  const requestsText = await fs.readFile(requestsPath, "utf8");
  const privateMapText = await fs.readFile(privateMapPath, "utf8");
  const requestMap = parsePromotionPromptRequestMap(JSON.parse(privateMapText));
  if (sha256(requestsText) !== manifest.prompt_pack.requests_sha256
      || requestMap.requests_sha256 !== manifest.prompt_pack.requests_sha256
      || sha256(privateMapText) !== manifest.prompt_pack.private_map_sha256
      || requestMap.suite_id !== manifest.suite_id) {
    throw new Error("Promotion provider resume prompt-pack verification failed.");
  }
  const requests = parsePromptRequests(requestsText, requestMap);
  if (requests.length !== manifest.request_count
      || !nonNegativeInteger(manifest.completed_response_count)
      || manifest.completed_response_count > requests.length
      || (failedResume && manifest.completed_response_count === requests.length)) {
    throw new Error("Promotion provider resume request coverage is invalid.");
  }

  const observedOutputsText = await readTextIfPresent(providerOutputsPath);
  const observedResponsesText = await readTextIfPresent(providerResponsesPath);
  let outputsText = observedOutputsText;
  let responsesText = observedResponsesText;
  let interruptionRecord: Record<string, unknown> | null = null;
  if (interruptedResume) {
    await input.lease.assertOwned();
    const archivedPreimages = await archiveInterruptedProviderPreimages({
      cwd: input.cwd,
      outDir: input.outDir,
      rawManifestText,
      outputsText: observedOutputsText,
      responsesText: observedResponsesText
    });
    const recoveredOutputs = parseJsonLinesRecoverFinalRecord(observedOutputsText, "provider output");
    const recoveredResponses = parseJsonLinesRecoverFinalRecord(observedResponsesText, "provider response");
    if (recoveredResponses.rows.length > recoveredOutputs.rows.length) {
      throw new Error("Promotion provider resume found responses without matching provider outputs.");
    }
    const recoveredCount = Math.min(recoveredOutputs.rows.length, recoveredResponses.rows.length);
    outputsText = canonicalJsonLines(recoveredOutputs.rows.slice(0, recoveredCount));
    responsesText = canonicalJsonLines(recoveredResponses.rows.slice(0, recoveredCount));
    interruptionRecord = {
      schema_version: "1.1",
      request_id: null,
      error_name: "InterruptedCheckpointRecovery",
      message: "Recovered a stale running checkpoint after the prior process ended without a terminal manifest.",
      recovered_at: new Date().toISOString(),
      prior_manifest_sha256: sha256(rawManifestText),
      prior_manifest_ref: archivedPreimages.manifest_ref,
      prior_manifest_completed_response_count: manifest.completed_response_count,
      recovered_response_count: recoveredCount,
      observed_provider_outputs_sha256: sha256(observedOutputsText),
      observed_provider_outputs_ref: archivedPreimages.outputs_ref,
      observed_provider_responses_sha256: sha256(observedResponsesText),
      observed_provider_responses_ref: archivedPreimages.responses_ref,
      prior_declared_provider_outputs_sha256: manifest.artifacts.provider_outputs_sha256,
      prior_declared_provider_responses_sha256: manifest.artifacts.provider_responses_sha256,
      discarded_output_record_count: recoveredOutputs.rows.length - recoveredCount,
      discarded_response_record_count: recoveredResponses.rows.length - recoveredCount,
      discarded_output_bytes: Buffer.byteLength(observedOutputsText) - Buffer.byteLength(outputsText),
      discarded_response_bytes: Buffer.byteLength(observedResponsesText) - Buffer.byteLength(responsesText)
    };
  } else {
    verifyOptionalArtifactHash(outputsText, manifest.artifacts.provider_outputs_sha256, "provider outputs");
    verifyOptionalArtifactHash(responsesText, manifest.artifacts.provider_responses_sha256, "provider responses");
  }
  const outputs = parseJsonLinesAllowEmpty(outputsText, "provider output");
  const responses = parseJsonLinesAllowEmpty(responsesText, "provider response");
  if ((!interruptedResume && outputs.length !== manifest.completed_response_count)
      || responses.length !== outputs.length) {
    throw new Error("Promotion provider resume partial artifact counts do not match the manifest.");
  }
  const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  for (const [index, output] of outputs.entries()) {
    const request = requests[index];
    const response = responses[index];
    if (!request || response === undefined) {
      throw new Error("Promotion provider resume partial artifact ordering is invalid.");
    }
    if (!isRecord(output) || output.schema_version !== "1.0"
        || output.request_id !== request.request_id || output.provider !== input.input.provider
        || output.requested_model !== input.input.model || !nonEmptyString(output.resolved_model)
        || output.model_artifact_digest !== (input.input.modelArtifactDigest || null)
        || output.reasoning_effort !== input.input.reasoningEffort
        || !isSha256String(output.execution_receipt_sha256)
        || !nonEmptyString(output.output_text) || sha256(output.output_text) !== output.output_text_sha256
        || !isRecord(output.usage) || !nonNegativeInteger(output.usage.inputTokens)
        || !nonNegativeInteger(output.usage.outputTokens) || !nonNegativeFinite(output.usage.costUsd)
        || !nonNegativeFinite(output.latency_ms)) {
      throw new Error(`Promotion provider resume found an invalid output record: ${request.request_id}`);
    }
    const outputResponse = parseCompletion(
      request.request_id,
      output.output_text,
      output.latency_ms,
      output.usage.costUsd
    );
    const persistedResponse = parsePromotionProviderResponse(response, `resume ${request.request_id}`);
    if (persistedResponse.request_id !== request.request_id
        || comparableResponse(persistedResponse) !== comparableResponse(outputResponse)) {
      throw new Error(`Promotion provider resume output/response mismatch: ${request.request_id}`);
    }
    usage.input_tokens += output.usage.inputTokens;
    usage.output_tokens += output.usage.outputTokens;
    usage.cost_usd += output.usage.costUsd;
  }
  if (!interruptedResume && (usage.input_tokens !== manifest.usage.input_tokens
      || usage.output_tokens !== manifest.usage.output_tokens
      || Math.abs(usage.cost_usd - manifest.usage.cost_usd) > 1e-12)) {
    throw new Error("Promotion provider resume usage does not match partial outputs.");
  }

  const archivedText = await readTextIfPresent(attemptFailuresPath);
  const priorAttemptHash = manifest.artifacts.attempt_failures_sha256;
  verifyOptionalArtifactHash(archivedText, priorAttemptHash, "provider attempt failures");
  let combinedAttemptText: string;
  if (failedResume) {
    const failureText = await fs.readFile(failuresPath, "utf8");
    if (!manifest.artifacts.failures_sha256
        || sha256(failureText) !== manifest.artifacts.failures_sha256
        || parseJsonLinesAllowEmpty(failureText, "provider failure").length !== 1) {
      throw new Error("Promotion provider resume failure artifact verification failed.");
    }
    combinedAttemptText = `${archivedText}${failureText}`;
    await input.lease.assertOwned();
    await fs.unlink(failuresPath);
  } else {
    if (manifest.artifacts.failures_sha256 !== null
        || (await readTextIfPresent(failuresPath)).trim().length > 0
        || !interruptionRecord) {
      throw new Error("Promotion provider stale-running resume found an unexpected failure artifact.");
    }
    combinedAttemptText = `${archivedText}${JSON.stringify(interruptionRecord)}\n`;
    await input.lease.assertOwned();
    await fs.writeFile(providerOutputsPath, outputsText, "utf8");
    await input.lease.assertOwned();
    await fs.writeFile(providerResponsesPath, responsesText, "utf8");
    manifest.completed_response_count = outputs.length;
    manifest.usage = usage;
    manifest.artifacts.provider_outputs_sha256 = outputsText ? sha256(outputsText) : null;
    manifest.artifacts.provider_responses_sha256 = responsesText ? sha256(responsesText) : null;
  }
  await input.lease.assertOwned();
  await fs.writeFile(attemptFailuresPath, combinedAttemptText, "utf8");

  manifest.status = "running";
  manifest.completed_at = null;
  manifest.failed_response_count = 0;
  manifest.failure = null;
  manifest.external_empirical_evidence_eligible = false;
  manifest.real_model_empirical_evidence_eligible = false;
  manifest.paper_claim_evidence_eligible = false;
  manifest.resume_count = (nonNegativeInteger(manifest.resume_count) ? manifest.resume_count : 0) + 1;
  manifest.attempt_failure_count = parseJsonLinesAllowEmpty(combinedAttemptText, "provider attempt failure").length;
  manifest.artifacts.failures_sha256 = null;
  manifest.artifacts.attempt_failures_path = portableRef(input.cwd, attemptFailuresPath);
  manifest.artifacts.attempt_failures_sha256 = sha256(combinedAttemptText);
  await input.lease.assertOwned();
  await writeJsonFile(manifestPath, manifest);
  return {
    requests,
    privateMapPath,
    providerOutputsPath,
    providerResponsesPath,
    failuresPath,
    manifestPath,
    predictionsDir,
    manifest
  };
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

async function acquireProviderRunLease(outDir: string): Promise<ProviderRunLease> {
  const leaseDir = `${outDir}.provider-run-lease`;
  const ownerPath = path.join(leaseDir, "owner.json");
  const ownerToken = `${process.pid}-${randomUUID()}`;
  for (;;) {
    try {
      await fs.mkdir(leaseDir);
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const heartbeatMs = await providerLeaseHeartbeatTime(leaseDir, ownerPath);
      if (Date.now() - heartbeatMs < STALE_RUNNING_PROVIDER_CHECKPOINT_MS) {
        throw new Error("Promotion provider output is locked by an active writer lease.");
      }
      const quarantine = `${leaseDir}.stale-${ownerToken}`;
      try {
        await fs.rename(leaseDir, quarantine);
        await fs.rm(quarantine, { recursive: true, force: true });
      } catch (takeoverError) {
        if (isNodeError(takeoverError) && takeoverError.code === "ENOENT") continue;
        throw takeoverError;
      }
    }
  }

  const acquiredAt = new Date().toISOString();
  let lost = false;
  const writeHeartbeat = async (): Promise<void> => {
    const current = await readProviderLeaseRecord(ownerPath);
    if (current && current.owner_token !== ownerToken) {
      lost = true;
      throw new Error("Promotion provider writer lease ownership changed.");
    }
    const record: ProviderRunLeaseRecord = {
      schema_version: "1.0",
      owner_token: ownerToken,
      process_id: process.pid,
      acquired_at: acquiredAt,
      heartbeat_at: new Date().toISOString()
    };
    const temporaryPath = path.join(leaseDir, `.owner-${ownerToken}.tmp`);
    await fs.writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "w" });
    await fs.rename(temporaryPath, ownerPath);
  };
  await writeHeartbeat();
  const heartbeat = setInterval(() => {
    void writeHeartbeat().catch(() => {
      lost = true;
    });
  }, PROVIDER_LEASE_HEARTBEAT_MS);
  heartbeat.unref();

  return {
    async assertOwned(): Promise<void> {
      if (lost) throw new Error("Promotion provider writer lease was lost.");
      const current = await readProviderLeaseRecord(ownerPath);
      if (!current || current.owner_token !== ownerToken) {
        lost = true;
        throw new Error("Promotion provider writer lease was lost.");
      }
    },
    async release(): Promise<void> {
      clearInterval(heartbeat);
      const current = await readProviderLeaseRecord(ownerPath);
      if (current?.owner_token === ownerToken) {
        await fs.rm(leaseDir, { recursive: true, force: true });
      }
    }
  };
}

async function providerLeaseHeartbeatTime(leaseDir: string, ownerPath: string): Promise<number> {
  const owner = await readProviderLeaseRecord(ownerPath);
  const heartbeat = owner ? Date.parse(owner.heartbeat_at) : Number.NaN;
  if (Number.isFinite(heartbeat)) return heartbeat;
  return (await fs.stat(leaseDir)).mtimeMs;
}

async function readProviderLeaseRecord(filePath: string): Promise<ProviderRunLeaseRecord | null> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    return null;
  }
  return isRecord(value)
    && value.schema_version === "1.0"
    && nonEmptyString(value.owner_token)
    && nonNegativeInteger(value.process_id)
    && nonEmptyString(value.acquired_at)
    && nonEmptyString(value.heartbeat_at)
    ? value as unknown as ProviderRunLeaseRecord
    : null;
}

async function archiveInterruptedProviderPreimages(input: {
  cwd: string;
  outDir: string;
  rawManifestText: string;
  outputsText: string;
  responsesText: string;
}): Promise<{ manifest_ref: string; outputs_ref: string; responses_ref: string }> {
  const snapshotId = sha256(input.rawManifestText).slice(0, 16);
  const snapshotDir = path.join(input.outDir, "provider-attempt-snapshots", snapshotId);
  await fs.mkdir(snapshotDir, { recursive: true });
  const manifestPath = path.join(snapshotDir, "prior-provider-run-manifest.json");
  const outputsPath = path.join(snapshotDir, "observed-provider-outputs.jsonl");
  const responsesPath = path.join(snapshotDir, "observed-provider-responses.jsonl");
  await Promise.all([
    fs.writeFile(manifestPath, input.rawManifestText, "utf8"),
    fs.writeFile(outputsPath, input.outputsText, "utf8"),
    fs.writeFile(responsesPath, input.responsesText, "utf8")
  ]);
  return {
    manifest_ref: portableRef(input.cwd, manifestPath),
    outputs_ref: portableRef(input.cwd, outputsPath),
    responses_ref: portableRef(input.cwd, responsesPath)
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

async function readTextIfPresent(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function verifyOptionalArtifactHash(raw: string, expected: string | null, label: string): void {
  if (!raw && expected === null) return;
  if (!raw || !expected || sha256(raw) !== expected) {
    throw new Error(`Promotion provider resume ${label} hash verification failed.`);
  }
}

function parseJsonLinesAllowEmpty(raw: string, label: string): unknown[] {
  const rows: unknown[] = [];
  for (const [index, line] of raw.split(/\r?\n/gu).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`Promotion provider resume ${label} line ${index + 1} is not valid JSON.`);
    }
  }
  return rows;
}

function parseJsonLinesRecoverFinalRecord(
  raw: string,
  label: string
): { rows: unknown[]; truncated_final_record: boolean } {
  const rows: unknown[] = [];
  const lines = raw.split(/\r?\n/gu);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      const laterNonEmpty = lines.slice(index + 1).some((candidate) => candidate.trim());
      if (laterNonEmpty) {
        throw new Error(`Promotion provider resume ${label} line ${index + 1} is not valid JSON.`);
      }
      return { rows, truncated_final_record: true };
    }
  }
  return { rows, truncated_final_record: false };
}

function canonicalJsonLines(rows: unknown[]): string {
  return rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
}

function comparableResponse(response: PromotionProviderResponse): string {
  return JSON.stringify({
    decision: response.decision,
    concerns: response.concerns,
    repair_owners: response.repair_owners,
    ...(response.latency_ms !== undefined ? { latency_ms: response.latency_ms } : {}),
    ...(response.cost_usd !== undefined ? { cost_usd: response.cost_usd } : {})
  });
}

function sameSourceSuiteBinding(
  left: PromotionProviderSourceSuiteBinding,
  right: PromotionProviderSourceSuiteBinding
): boolean {
  return left.path === right.path
    && left.manifest_sha256 === right.manifest_sha256
    && left.snapshot_sha256 === right.snapshot_sha256
    && left.evidence_class === right.evidence_class
    && left.paper_claim_eligible === right.paper_claim_eligible;
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

function isSha256String(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
