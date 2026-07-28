#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { hashCanonical } from "../lib/corpus.mjs";
import {
  adjudicateJudgeRepeats,
  buildBlindedJudgeInstances,
  buildDisagreementInstance,
  buildJudgeRequest,
  validateJudgeResponse,
} from "../lib/judge.mjs";

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail("Expected value-bearing --protocol, --bindings, --config, --corpus-root, --judge-id, and --output arguments.");
    }
    args[key.slice(2)] = value;
  }
  for (const key of [
    "protocol",
    "bindings",
    "config",
    "corpus-root",
    "judge-id",
    "output",
  ]) {
    if (!args[key]) fail(`--${key} is required.`);
  }
  return args;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(resolve(filePath), "utf8"));
}

function fileSha256(filePath) {
  return createHash("sha256")
    .update(readFileSync(resolve(filePath)))
    .digest("hex");
}

function atomicWrite(filePath, value) {
  const target = resolve(filePath);
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

async function fetchJson(url, options = {}, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`non_json_http_response:${response.status}`);
    }
    if (!response.ok) {
      throw new Error(`http_${response.status}:${value.error || "request_failed"}`);
    }
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function validateFileBinding(binding, actualPath, label) {
  if (!binding || typeof binding.file_sha256 !== "string") {
    throw new Error(`${label}_binding_invalid`);
  }
  const actual = fileSha256(actualPath);
  if (actual !== binding.file_sha256) {
    throw new Error(`${label}_file_sha256_mismatch:${actual}`);
  }
}

function resolveBindingPath(binding, bindingsPath, label) {
  if (!binding || typeof binding.path !== "string" || !binding.path.trim()) {
    throw new Error(`${label}_binding_path_invalid`);
  }
  return resolve(dirname(bindingsPath), binding.path);
}

function validateExistingCheckpoint(existing, identity, instances) {
  if (existing.identity_sha256 !== identity) {
    throw new Error("existing_checkpoint_identity_mismatch");
  }
  const {
    content_sha256: checkpointHash,
    ...checkpointPayload
  } = existing;
  if (
    typeof checkpointHash !== "string"
    || checkpointHash !== hashCanonical(checkpointPayload)
  ) {
    throw new Error("existing_checkpoint_content_hash_mismatch");
  }
  const expectedInstances = new Map(
    instances.map((instance) => [instance.instance_id, instance]),
  );
  const observedIds = new Set();
  for (const result of existing.results || []) {
    if (!result || typeof result.instance_id !== "string") {
      throw new Error("existing_checkpoint_result_invalid");
    }
    if (observedIds.has(result.instance_id)) {
      throw new Error(`existing_checkpoint_result_duplicate:${result.instance_id}`);
    }
    observedIds.add(result.instance_id);
    const expected = expectedInstances.get(result.instance_id);
    if (!expected) {
      throw new Error(`existing_checkpoint_result_unexpected:${result.instance_id}`);
    }
    if (result.source_instance_sha256 !== expected.source_instance_sha256) {
      throw new Error(
        `existing_checkpoint_source_hash_mismatch:${result.instance_id}`,
      );
    }
    const { content_sha256: resultHash, ...resultPayload } = result;
    if (
      typeof resultHash !== "string"
      || resultHash !== hashCanonical(resultPayload)
    ) {
      throw new Error(
        `existing_checkpoint_result_hash_mismatch:${result.instance_id}`,
      );
    }
  }
}

function summarizeFailure(result) {
  return {
    completed_at: result.completed_at,
    status: result.status,
    reason_codes: result.reason_codes || [],
  };
}

async function runJudgeRequest({
  baseUrl,
  model,
  prompt,
  instance,
  seed,
  options,
  timeoutMs,
}) {
  const request = buildJudgeRequest({ prompt, instance });
  const body = {
    model,
    messages: request.messages,
    stream: false,
    think: false,
    format: request.format,
    options: {
      temperature: options.temperature,
      top_p: options.top_p,
      num_ctx: options.num_ctx,
      num_predict: options.num_predict,
      seed,
    },
    keep_alive: options.keep_alive,
  };
  const attempts = [];
  for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
    const startedAt = new Date().toISOString();
    try {
      const response = await fetchJson(
        `${baseUrl}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      const rawContent = response?.message?.content;
      const validation = validateJudgeResponse(rawContent, instance);
      const record = {
        attempt_index: attemptIndex + 1,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        request_sha256: hashCanonical(body),
        request_input_sha256: request.request_input_sha256,
        request_messages_sha256: request.request_messages_sha256,
        response_content_sha256:
          typeof rawContent === "string"
            ? createHash("sha256").update(rawContent).digest("hex")
            : null,
        raw_content: typeof rawContent === "string" ? rawContent : null,
        response_metadata: {
          model: response.model,
          created_at: response.created_at,
          done: response.done,
          done_reason: response.done_reason,
          total_duration_ns: response.total_duration,
          load_duration_ns: response.load_duration,
          prompt_eval_count: response.prompt_eval_count,
          prompt_eval_duration_ns: response.prompt_eval_duration,
          eval_count: response.eval_count,
          eval_duration_ns: response.eval_duration,
        },
        valid: validation.valid,
        reason_codes: validation.reasons,
        parsed_cells: validation.valid ? validation.cells : null,
      };
      attempts.push(record);
      if (validation.valid) {
        return { valid: true, attempts, parsed: validation };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({
        attempt_index: attemptIndex + 1,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        request_sha256: hashCanonical(body),
        request_input_sha256: request.request_input_sha256,
        request_messages_sha256: request.request_messages_sha256,
        valid: false,
        reason_codes: [
          error instanceof Error && error.name === "AbortError"
            ? "judge_request_timeout"
            : `judge_request_failed:${message}`,
        ],
      });
      return { valid: false, attempts };
    }
  }
  return { valid: false, attempts };
}

async function evaluateInstance({
  baseUrl,
  model,
  prompt,
  instance,
  options,
  repeatSeeds,
  tiebreakSeed,
  timeoutMs,
  previous,
}) {
  const startedAt = new Date().toISOString();
  const priorFailures = [
    ...(previous?.prior_failures || []),
    ...(previous && previous.status !== "complete"
      ? [summarizeFailure(previous)]
      : []),
  ];
  const first = await runJudgeRequest({
    baseUrl,
    model,
    prompt,
    instance,
    seed: repeatSeeds[0],
    options,
    timeoutMs,
  });
  if (!first.valid) {
    return incompleteResult(instance, startedAt, priorFailures, {
      repeat_1: first,
    });
  }
  const second = await runJudgeRequest({
    baseUrl,
    model,
    prompt,
    instance,
    seed: repeatSeeds[1],
    options,
    timeoutMs,
  });
  if (!second.valid) {
    return incompleteResult(instance, startedAt, priorFailures, {
      repeat_1: first,
      repeat_2: second,
    });
  }
  const disagreementInstance = buildDisagreementInstance(
    instance,
    first.parsed,
    second.parsed,
  );
  let tiebreak;
  if (disagreementInstance) {
    tiebreak = await runJudgeRequest({
      baseUrl,
      model,
      prompt,
      instance: disagreementInstance,
      seed: tiebreakSeed,
      options,
      timeoutMs,
    });
    if (!tiebreak.valid) {
      return incompleteResult(instance, startedAt, priorFailures, {
        repeat_1: first,
        repeat_2: second,
        tiebreak,
      });
    }
  }
  const adjudicated = adjudicateJudgeRepeats({
    instance,
    first: first.parsed,
    second: second.parsed,
    tiebreak: tiebreak?.parsed,
  });
  const payload = {
    instance_id: instance.instance_id,
    source_instance_sha256: instance.source_instance_sha256,
    bundle_id: instance.bundle_id,
    paper_id: instance.paper_id,
    claim_index: instance.claim_index,
    status: "complete",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    prior_failures: priorFailures,
    cell_mapping: instance.cells.map((cell) => ({
      cell_id: cell.cell_id,
      identification_model: cell.identification_model,
      candidate_count: cell.candidates.length,
    })),
    runs: {
      repeat_1: first,
      repeat_2: second,
      ...(tiebreak ? { disagreement_tiebreak: tiebreak } : {}),
    },
    ...adjudicated,
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function incompleteResult(instance, startedAt, priorFailures, runs) {
  const reasonCodes = [
    ...new Set(
      Object.values(runs)
        .flatMap((run) => run.attempts || [])
        .flatMap((attempt) => attempt.reason_codes || []),
    ),
  ].sort();
  const payload = {
    instance_id: instance.instance_id,
    source_instance_sha256: instance.source_instance_sha256,
    bundle_id: instance.bundle_id,
    paper_id: instance.paper_id,
    claim_index: instance.claim_index,
    status: "incomplete",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    prior_failures: priorFailures,
    reason_codes: reasonCodes,
    runs,
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

function buildCheckpoint({
  existing,
  identity,
  judge,
  runtime,
  expectedCount,
  results,
}) {
  const orderedResults = [...results.values()].sort((left, right) =>
    left.instance_id.localeCompare(right.instance_id));
  const completeCount = orderedResults.filter(
    (result) => result.status === "complete",
  ).length;
  const payload = {
    schema_version: 1,
    artifact_kind: "independent_blinded_excerpt_judgments",
    analysis_class: "confirmatory_independent_rejudging",
    identity_sha256: identity,
    started_at: existing?.started_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    judge,
    runtime,
    expected_instance_count: expectedCount,
    observed_instance_count: orderedResults.length,
    complete_instance_count: completeCount,
    incomplete_instance_ids: orderedResults
      .filter((result) => result.status !== "complete")
      .map((result) => result.instance_id),
    confirmatory_eligible:
      orderedResults.length === expectedCount && completeCount === expectedCount,
    results: orderedResults,
  };
  return { ...payload, content_sha256: hashCanonical(payload) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const protocolPath = resolve(args.protocol);
  const bindingsPath = resolve(args.bindings);
  const configPath = resolve(args.config);
  const corpusRoot = resolve(args["corpus-root"]);
  const outputPath = resolve(args.output);
  const runnerPath = fileURLToPath(import.meta.url);
  const protocol = readJson(protocolPath);
  const bindings = readJson(bindingsPath);
  const config = readJson(configPath);
  const judge = bindings.judges.find((item) => item.id === args["judge-id"]);
  if (!judge) throw new Error(`judge_binding_missing:${args["judge-id"]}`);
  validateFileBinding(bindings.protocol, protocolPath, "protocol");
  validateFileBinding(bindings.config, configPath, "config");
  const promptPath = resolveBindingPath(bindings.prompt, bindingsPath, "prompt");
  const boundRunnerPath = resolveBindingPath(
    bindings.runner,
    bindingsPath,
    "runner",
  );
  validateFileBinding(bindings.prompt, promptPath, "prompt");
  validateFileBinding(bindings.runner, runnerPath, "runner");
  if (runnerPath !== boundRunnerPath) {
    throw new Error("runner_binding_path_mismatch");
  }
  const prompt = readJson(promptPath);
  const bindingsFileSha256 = fileSha256(bindingsPath);
  const baseUrl = (args["base-url"] || bindings.runtime.base_url).replace(/\/$/u, "");
  const [version, tags] = await Promise.all([
    fetchJson(`${baseUrl}/api/version`),
    fetchJson(`${baseUrl}/api/tags`),
  ]);
  if (version.version !== bindings.runtime.ollama_version) {
    throw new Error(`ollama_version_mismatch:${version.version}`);
  }
  const installed = tags.models?.find(
    (item) => item.name === judge.model_tag || item.model === judge.model_tag,
  );
  if (!installed || installed.digest !== judge.model_digest) {
    throw new Error(`judge_model_digest_mismatch:${installed?.digest || "missing"}`);
  }
  const protocolJudge = protocol.independent_judges.find(
    (item) => item.id === judge.id,
  );
  if (!protocolJudge || protocolJudge.model_tag !== judge.model_tag) {
    throw new Error("judge_protocol_binding_mismatch");
  }
  for (const optionName of ["temperature", "top_p", "num_ctx"]) {
    if (
      bindings.generation_options?.[optionName]
      !== protocol.independent_judge_contract.generation_options[optionName]
    ) {
      throw new Error(`judge_generation_option_mismatch:${optionName}`);
    }
  }
  const instances = buildBlindedJudgeInstances({ config, corpusRoot });
  if (instances.length !== protocol.units.expected_error_instances) {
    throw new Error(`judge_instance_count_mismatch:${instances.length}`);
  }
  const identity = hashCanonical({
    execution_bindings_file_sha256: bindingsFileSha256,
    protocol_file_sha256: bindings.protocol.file_sha256,
    config_file_sha256: bindings.config.file_sha256,
    prompt_file_sha256: bindings.prompt.file_sha256,
    runner_file_sha256: bindings.runner.file_sha256,
    judge_id: judge.id,
    model_tag: judge.model_tag,
    model_digest: judge.model_digest,
    ollama_version: version.version,
    source_instance_hashes: instances.map((instance) => instance.source_instance_sha256),
  });
  const existing = existsSync(outputPath) ? readJson(outputPath) : undefined;
  if (existing) validateExistingCheckpoint(existing, identity, instances);
  const results = new Map(
    (existing?.results || []).map((result) => [result.instance_id, result]),
  );
  const repeatSeeds = protocol.independent_judge_contract.generation_options.repeat_seeds;
  const tiebreakSeed = protocol.independent_judge_contract.generation_options.disagreement_tiebreak_seed;
  const options = bindings.generation_options;
  const timeoutMs = bindings.runtime.request_timeout_ms;
  for (let index = 0; index < instances.length; index += 1) {
    const instance = instances[index];
    const previous = results.get(instance.instance_id);
    if (previous?.status === "complete") continue;
    process.stdout.write(
      `[${judge.id}] ${index + 1}/${instances.length} ${instance.instance_id}\n`,
    );
    const result = await evaluateInstance({
      baseUrl,
      model: judge.model_tag,
      prompt,
      instance,
      options,
      repeatSeeds,
      tiebreakSeed,
      timeoutMs,
      previous,
    });
    results.set(instance.instance_id, result);
    atomicWrite(outputPath, buildCheckpoint({
      existing,
      identity,
      judge,
      runtime: {
        provider: "ollama",
        version: version.version,
        base_url: baseUrl,
        generation_options: options,
        hardware: bindings.hardware,
        execution_bindings_file_sha256: bindingsFileSha256,
      },
      expectedCount: instances.length,
      results,
    }));
  }
  const finalArtifact = buildCheckpoint({
    existing,
    identity,
    judge,
    runtime: {
      provider: "ollama",
      version: version.version,
      base_url: baseUrl,
      generation_options: options,
      hardware: bindings.hardware,
      execution_bindings_file_sha256: bindingsFileSha256,
    },
    expectedCount: instances.length,
    results,
  });
  atomicWrite(outputPath, finalArtifact);
  if (!finalArtifact.confirmatory_eligible) {
    fail(
      `${judge.id} incomplete: ${finalArtifact.complete_instance_count}/${finalArtifact.expected_instance_count}`,
      3,
    );
  }
}

try {
  await main();
} catch (error) {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
}
