import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { RunRecord } from "../../types.js";
import { AutoLabOSRuntime, bootstrapAutoLabOSRuntime } from "../../runtime/createRuntime.js";
import { buildWorkspaceRunRoot } from "../runs/runPaths.js";
import { readPersistedRunEvents, type AutoLabOSEvent } from "../events.js";
import { applyWithSafetyNet, type HarnessApplyResult } from "./harnessApplier.js";
import {
  CodexOAuthResponsesLLMClient,
  LLMClient,
  OllamaLLMClient,
  OpenAiResponsesLLMClient
} from "../llm/client.js";
import { resolveCodexOAuthCredentials } from "../../integrations/codex/oauthAuth.js";
import { CodexOAuthResponsesTextClient } from "../../integrations/codex/oauthResponsesTextClient.js";
import { OllamaClient } from "../../integrations/ollama/ollamaClient.js";
import { DEFAULT_OLLAMA_BASE_URL } from "../../integrations/ollama/modelCatalog.js";
import { ensureDir, fileExists } from "../../utils/fs.js";

export const META_HARNESS_PROMPT_NODES = [
  "generate_hypotheses",
  "design_experiments",
  "analyze_results",
  "review"
] as const;

export type MetaHarnessNode = (typeof META_HARNESS_PROMPT_NODES)[number];

export interface MetaHarnessOptions {
  cwd: string;
  runs: number;
  nodes: MetaHarnessNode[];
  externalRunRoots?: string[];
  noApply?: boolean;
  dryRun?: boolean;
}

export interface MetaHarnessResult {
  contextDir: string;
  diffText?: string;
  targetFile?: string;
  applied?: HarnessApplyResult;
  lines: string[];
}

interface MetaHarnessRunSummary {
  run: RunRecord;
  paperReadinessScore: number | null;
}

interface PromptTargetMapEntry {
  run_id: string;
  source_artifact: string;
  target_node: string;
  recommended_prompt_node: MetaHarnessNode;
  prompt_file: string;
  priority?: string;
  diagnostic_ids?: string[];
  problem_summary?: string;
  recheck_condition?: string;
}

interface MetaHarnessDeps {
  bootstrapRuntime: typeof bootstrapAutoLabOSRuntime;
  createLlm: (runtime: AutoLabOSRuntime) => LLMClient;
  callLlm: (client: LLMClient, input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  applyWithSafetyNet: typeof applyWithSafetyNet;
  now: () => Date;
}

export async function runMetaHarness(
  options: MetaHarnessOptions,
  deps: Partial<MetaHarnessDeps> = {}
): Promise<MetaHarnessResult> {
  if ((options.externalRunRoots || []).length > 0 && !options.noApply) {
    throw new Error("External meta-harness contexts are read-only in this slice; use --no-apply.");
  }
  const resolvedDeps: MetaHarnessDeps = {
    bootstrapRuntime: bootstrapAutoLabOSRuntime,
    createLlm: createMetaHarnessLlm,
    callLlm: defaultCallLlm,
    applyWithSafetyNet,
    now: () => new Date(),
    ...deps
  };

  const bootstrap = await resolvedDeps.bootstrapRuntime({
    cwd: options.cwd,
    allowInteractiveSetup: false
  });
  if (!bootstrap.runtime) {
    throw new Error("AutoLabOS runtime must be configured before meta-harness can run.");
  }

  const timestamp = formatTimestamp(resolvedDeps.now());
  const contextDir = path.join(options.cwd, "outputs", "meta-harness", timestamp);
  const selectedRuns = await selectRecentRuns(bootstrap.runtime, options.runs);
  await buildMetaHarnessContext({
    cwd: options.cwd,
    contextDir,
    runs: selectedRuns,
    nodes: options.nodes,
    externalRunRoots: options.externalRunRoots || []
  });

  if (options.noApply) {
    return {
      contextDir,
      lines: [
        `Meta-harness context prepared: ${contextDir}`,
        ...formatExternalRunLines(options.externalRunRoots || []),
        `Use codex --context ${contextDir} for manual review.`
      ]
    };
  }

  const taskPath = path.join(contextDir, "TASK.md");
  const systemPrompt = await fs.readFile(taskPath, "utf8");
  const userPrompt = await assembleContextPrompt(contextDir);
  const client = resolvedDeps.createLlm(bootstrap.runtime);
  const llmResponse = await resolvedDeps.callLlm(client, { systemPrompt, userPrompt });
  const parsed = parseMetaHarnessResponse(llmResponse);
  if (!parsed) {
    return {
      contextDir,
      lines: [
        `Meta-harness context prepared: ${contextDir}`,
        ...formatExternalRunLines(options.externalRunRoots || []),
        "LLM response did not match the required TARGET_FILE + unified diff format.",
        "No files were changed."
      ]
    };
  }

  if (options.dryRun) {
    return {
      contextDir,
      diffText: parsed.diffText,
      targetFile: parsed.targetFile,
      lines: [
        `Meta-harness context prepared: ${contextDir}`,
        ...formatExternalRunLines(options.externalRunRoots || []),
        `TARGET_FILE: ${parsed.targetFile}`,
        parsed.diffText
      ]
    };
  }

  const absoluteTargetFile = path.join(options.cwd, parsed.targetFile);
  const originalContent = await fs.readFile(absoluteTargetFile, "utf8");
  const newContent = applyUnifiedDiff(originalContent, parsed.diffText);
  const scoreBefore = computeAveragePaperReadinessScore(selectedRuns);
  const applyResult = await resolvedDeps.applyWithSafetyNet({
    targetFile: absoluteTargetFile,
    newContent,
    source: "meta-harness",
    candidateId: timestamp,
    scoreBefore
  });

  return {
    contextDir,
    diffText: parsed.diffText,
    targetFile: parsed.targetFile,
    applied: applyResult,
    lines: [
      `Meta-harness context prepared: ${contextDir}`,
      ...formatExternalRunLines(options.externalRunRoots || []),
      `TARGET_FILE: ${parsed.targetFile}`,
      applyResult.applied
        ? `Applied safely and committed. Audit log: ${applyResult.auditLogPath}`
        : applyResult.rolledBack
          ? `Validation failed; restored original file. Audit log: ${applyResult.auditLogPath}`
          : `No file changes were applied. Audit log: ${applyResult.auditLogPath}`
    ]
  };
}

async function buildMetaHarnessContext(input: {
  cwd: string;
  contextDir: string;
  runs: MetaHarnessRunSummary[];
  nodes: MetaHarnessNode[];
  externalRunRoots: string[];
}): Promise<void> {
  await ensureDir(input.contextDir);
  await writeTaskFile(input.contextDir);

  const requestedPromptNodes = new Set<MetaHarnessNode>(input.nodes);
  const promptTargetMap: PromptTargetMapEntry[] = [];

  const evalHistoryPath = path.join(input.cwd, "outputs", "eval-harness", "history.jsonl");
  if (await fileExists(evalHistoryPath)) {
    await copyFileToContext(evalHistoryPath, path.join(input.contextDir, "outputs", "eval-harness", "history.jsonl"));
  }

  for (const runSummary of input.runs) {
    const { run } = runSummary;
    const runRoot = buildWorkspaceRunRoot(input.cwd, run.id);
    const runContextDir = path.join(input.contextDir, "runs", run.id);
    await ensureDir(runContextDir);
    for (const node of input.nodes) {
      const filteredEvents = filterRunEventsByNode(
        readPersistedRunEvents({
          runsDir: path.join(input.cwd, ".autolabos", "runs"),
          runId: run.id,
          limit: 500
        }),
        node
      );
      await fs.writeFile(
        path.join(runContextDir, `${node}_events.jsonl`),
        filteredEvents.map((event) => JSON.stringify(event)).join("\n") + (filteredEvents.length > 0 ? "\n" : ""),
        "utf8"
      );

      const nodeArtifactPaths = nodeArtifactPathsForMetaHarnessNode(node, runRoot);
      for (const nodeArtifactPath of nodeArtifactPaths) {
        if (await fileExists(nodeArtifactPath)) {
          await copyFileToContext(nodeArtifactPath, path.join(runContextDir, path.basename(nodeArtifactPath)));
        }
      }
    }

    promptTargetMap.push(...await collectPromptTargetMapEntries(runRoot, run.id));

    const paperArtifactPaths = [
      path.join(runRoot, "paper", "paper_readiness.json"),
      path.join(runRoot, "paper", "paper_critique.json"),
      path.join(runRoot, "paper", "readiness_risks.json"),
      path.join(runRoot, "paper", "render_validation.json"),
      path.join(runRoot, "paper", "compile_report.json"),
      path.join(runRoot, "paper", "compiled_page_validation.json"),
      path.join(runRoot, "paper", "submission_validation.json"),
      path.join(runRoot, "paper", "scientific_validation.json"),
      path.join(runRoot, "paper", "manuscript_quality_gate.json"),
      path.join(runRoot, "paper", "gate_decision.json"),
      path.join(runRoot, "paper", "citation_consistency.json"),
      path.join(runRoot, "paper", "claim_evidence_table.json")
    ];
    for (const paperArtifactPath of paperArtifactPaths) {
      if (await fileExists(paperArtifactPath)) {
        await copyFileToContext(paperArtifactPath, path.join(runContextDir, path.basename(paperArtifactPath)));
      }
    }
  }

  promptTargetMap.push(...await copyExternalRunContexts({
    contextDir: input.contextDir,
    externalRunRoots: input.externalRunRoots
  }));

  for (const entry of promptTargetMap) {
    requestedPromptNodes.add(entry.recommended_prompt_node);
  }
  for (const node of META_HARNESS_PROMPT_NODES) {
    const promptPath = await resolveMetaHarnessPromptPath(input.cwd, node);
    if (requestedPromptNodes.has(node) && promptPath) {
      await copyFileToContext(promptPath, path.join(input.contextDir, "node-prompts", `${node}.md`));
    }
  }
  await fs.writeFile(
    path.join(input.contextDir, "prompt_target_map.json"),
    `${JSON.stringify({ generated_at: new Date().toISOString(), targets: promptTargetMap }, null, 2)}\n`,
    "utf8"
  );
}

async function writeTaskFile(contextDir: string): Promise<void> {
  const body = [
    "당신은 harness 엔지니어입니다. 위의 소스 코드, 실행 traces, 점수를 모두 읽으세요.",
    "paper_readiness.overall_score를 높일 수 있는 노드 프롬프트 파일의 개선안을 하나 제안하세요.",
    "review/node_strengthening_recommendations.json 또는 review/paper_scale_diagnostics.json이 있으면, 그 artifact가 지목한 target_node와 recheck_condition을 우선 반영하세요.",
    "prompt_target_map.json이 있으면, target_node가 직접 node-prompts 파일을 갖지 않는 경우에도 recommended_prompt_node를 사용해 가장 가까운 강화 가능 프롬프트로 결함을 되돌리세요.",
    "paper/render_validation.json, paper/compile_report.json, paper/submission_validation.json, paper/scientific_validation.json, paper/manuscript_quality_gate.json, paper/gate_decision.json이 있으면 템플릿, 인용, BibTeX/style 파일, 표/그림, page-budget, manuscript-quality, scientific-quality 결함도 원인 노드로 되돌려 분석하세요.",
    "샘플 수 부족, seed 반복 부재, 한 문제 차이의 headline gain, smoke-test 수준 train budget, 핵심 문헌 누락은 polish가 아니라 upstream node 강화 대상으로 다루세요.",
    "반드시 다음 형식으로만 출력하세요:",
    "TARGET_FILE: node-prompts/<node>.md",
    "--- a/node-prompts/<node>.md",
    "+++ b/node-prompts/<node>.md",
    "@@ ... @@",
    "(unified diff 본문)",
    "TypeScript 소스(.ts 파일)는 절대 변경하지 마세요."
  ].join("\n");
  await fs.writeFile(path.join(contextDir, "TASK.md"), `${body}\n`, "utf8");
}

async function assembleContextPrompt(contextDir: string): Promise<string> {
  const files = await listFilesRecursively(contextDir);
  const contentBlocks: string[] = [];
  for (const filePath of files) {
    if (path.basename(filePath) === "TASK.md") {
      continue;
    }
    const relative = path.relative(contextDir, filePath).replace(/\\/g, "/");
    const content = await fs.readFile(filePath, "utf8");
    contentBlocks.push(`## FILE: ${relative}\n${content}`);
  }
  return contentBlocks.join("\n\n");
}

async function copyExternalRunContexts(input: {
  contextDir: string;
  externalRunRoots: string[];
}): Promise<PromptTargetMapEntry[]> {
  const promptTargets: PromptTargetMapEntry[] = [];
  if (input.externalRunRoots.length === 0) {
    return promptTargets;
  }
  const externalRoot = path.join(input.contextDir, "external-runs");
  await ensureDir(externalRoot);
  const manifest: Array<{
    source_id: string;
    source_label: string;
    status: "available" | "missing";
    copied_artifacts: string[];
    missing_optional_artifacts: string[];
  }> = [];

  for (const [index, externalRunRoot] of input.externalRunRoots.entries()) {
    const sourceId = `external-${index + 1}`;
    const sourceDir = path.join(externalRoot, sourceId);
    const sourceLabel = path.basename(path.resolve(externalRunRoot)) || sourceId;
    const sourceExists = await fileExists(externalRunRoot);
    await ensureDir(sourceDir);
    if (!sourceExists) {
      const missingEntry = {
        source_id: sourceId,
        source_label: sourceLabel,
        status: "missing" as const,
        copied_artifacts: [],
        missing_optional_artifacts: [...EXTERNAL_CONTEXT_ARTIFACTS].map((artifact) => artifact.replace(/\\/g, "/"))
      };
      manifest.push(missingEntry);
      await fs.writeFile(path.join(sourceDir, "manifest.json"), `${JSON.stringify(missingEntry, null, 2)}\n`, "utf8");
      continue;
    }

    const copiedArtifacts: string[] = [];
    const missingOptionalArtifacts: string[] = [];
    for (const artifact of EXTERNAL_CONTEXT_ARTIFACTS) {
      const sourcePath = path.join(externalRunRoot, artifact);
      if (!(await fileExists(sourcePath))) {
        missingOptionalArtifacts.push(artifact.replace(/\\/g, "/"));
        continue;
      }
      await copyFileToContext(sourcePath, path.join(sourceDir, artifact));
      copiedArtifacts.push(artifact.replace(/\\/g, "/"));
    }
    const entry = {
      source_id: sourceId,
      source_label: sourceLabel,
      status: "available" as const,
      copied_artifacts: copiedArtifacts,
      missing_optional_artifacts: missingOptionalArtifacts
    };
    manifest.push(entry);
    promptTargets.push(...await collectPromptTargetMapEntries(externalRunRoot, sourceId, `external-runs/${sourceId}/`));
    await fs.writeFile(path.join(sourceDir, "manifest.json"), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
  }

  await fs.writeFile(path.join(externalRoot, "manifest.json"), `${JSON.stringify({ sources: manifest }, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(input.contextDir, "manifest.json"),
    `${JSON.stringify(
      {
        mode: "external_context",
        external_context_count: manifest.length,
        external_contexts: manifest,
        note: "External run roots are copied as read-only context and are not scored or auto-applied."
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return promptTargets;
}

const EXTERNAL_CONTEXT_ARTIFACTS = [
  "events.jsonl",
  "result_analysis.json",
  "result_analysis_synthesis.json",
  "baseline_comparison.json",
  "result_table.json",
  "transition_recommendation.json",
  path.join("analysis", "evidence_scale_assessment.json"),
  path.join("review", "decision.json"),
  path.join("review", "review_packet.json"),
  path.join("review", "paper_critique.json"),
  path.join("review", "minimum_gate.json"),
  path.join("review", "paper_quality_evaluation.json"),
  path.join("review", "paper_scale_diagnostics.json"),
  path.join("review", "node_strengthening_recommendations.json"),
  path.join("review", "readiness_risks.json"),
  path.join("paper", "paper_readiness.json"),
  path.join("paper", "paper_critique.json"),
  path.join("paper", "readiness_risks.json"),
  path.join("paper", "render_validation.json"),
  path.join("paper", "compile_report.json"),
  path.join("paper", "compiled_page_validation.json"),
  path.join("paper", "submission_validation.json"),
  path.join("paper", "scientific_validation.json"),
  path.join("paper", "manuscript_quality_gate.json"),
  path.join("paper", "gate_decision.json"),
  path.join("paper", "citation_consistency.json"),
  path.join("paper", "claim_evidence_table.json")
] as const;

function formatExternalRunLines(externalRunRoots: string[]): string[] {
  if (externalRunRoots.length === 0) {
    return [];
  }
  return [`External run contexts included: ${externalRunRoots.length}`];
}

function filterRunEventsByNode(events: AutoLabOSEvent[], node: MetaHarnessNode): AutoLabOSEvent[] {
  return events.filter((event) => event.node === node);
}

function nodeArtifactPathsForMetaHarnessNode(node: MetaHarnessNode, runRoot: string): string[] {
  if (node === "analyze_results") {
    return [path.join(runRoot, "result_analysis.json")];
  }
  if (node === "review") {
    return [
      path.join(runRoot, "review", "decision.json"),
      path.join(runRoot, "review", "minimum_gate.json"),
      path.join(runRoot, "review", "paper_quality_evaluation.json"),
      path.join(runRoot, "review", "paper_scale_diagnostics.json"),
      path.join(runRoot, "review", "node_strengthening_recommendations.json"),
      path.join(runRoot, "review", "readiness_risks.json"),
      path.join(runRoot, "review", "paper_critique.json")
    ];
  }
  return [];
}

async function collectPromptTargetMapEntries(runRoot: string, runId: string, artifactPrefix = ""): Promise<PromptTargetMapEntry[]> {
  const entries: PromptTargetMapEntry[] = [];
  const strengtheningPath = path.join(runRoot, "review", "node_strengthening_recommendations.json");
  const strengthening = await readJsonObjectIfPresent(strengtheningPath);
  const recommendations = Array.isArray(strengthening?.recommendations) ? strengthening.recommendations : [];
  for (const recommendation of recommendations) {
    if (!isRecord(recommendation)) {
      continue;
    }
    const targetNode = asString(recommendation.node);
    const promptNode = mapStrengtheningTargetToPromptNode(targetNode);
    if (!targetNode || !promptNode) {
      continue;
    }
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}review/node_strengthening_recommendations.json`,
      target_node: targetNode,
      recommended_prompt_node: promptNode,
      prompt_file: `node-prompts/${promptNode}.md`,
      priority: asString(recommendation.priority) || undefined,
      diagnostic_ids: asStringArray(recommendation.diagnostic_ids),
      problem_summary: asString(recommendation.problem_summary) || undefined,
      recheck_condition: asString(recommendation.recheck_condition) || undefined
    });
  }

  const diagnosticsPath = path.join(runRoot, "review", "paper_scale_diagnostics.json");
  const diagnostics = await readJsonObjectIfPresent(diagnosticsPath);
  const diagnosticRows = Array.isArray(diagnostics?.diagnostics) ? diagnostics.diagnostics : [];
  for (const diagnostic of diagnosticRows) {
    if (!isRecord(diagnostic)) {
      continue;
    }
    const targetNode = asString(diagnostic.target_node) || asString(diagnostic.source_node);
    const promptNode = mapStrengtheningTargetToPromptNode(targetNode);
    if (!targetNode || !promptNode) {
      continue;
    }
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}review/paper_scale_diagnostics.json`,
      target_node: targetNode,
      recommended_prompt_node: promptNode,
      prompt_file: `node-prompts/${promptNode}.md`,
      priority: asString(diagnostic.severity) === "blocking" ? "high" : "medium",
      diagnostic_ids: [asString(diagnostic.id)].filter(Boolean),
      problem_summary: asString(diagnostic.summary) || undefined,
      recheck_condition: asString(diagnostic.recheck_condition) || undefined
    });
  }

  const renderValidation = await readJsonObjectIfPresent(path.join(runRoot, "paper", "render_validation.json"));
  const renderIssues = Array.isArray(renderValidation?.issues) ? renderValidation.issues.filter(isRecord) : [];
  if (asString(renderValidation?.status) === "fail") {
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}paper/render_validation.json`,
      target_node: "write_paper",
      recommended_prompt_node: "review",
      prompt_file: "node-prompts/review.md",
      priority: "high",
      diagnostic_ids: renderIssues.map((issue) => asString(issue.code)).filter(Boolean),
      problem_summary: summarizeArtifactIssueCodes(renderIssues, "Render validation reported blocking paper-build or paper-surface issues."),
      recheck_condition: "paper/render_validation.json reports status=pass and required template, bibliography, citation, table, figure, and page-budget checks pass."
    });
  }

  const compileReport = await readJsonObjectIfPresent(path.join(runRoot, "paper", "compile_report.json"));
  const compileIssueCodes = summarizeCompileReportIssueCodes(compileReport);
  if (compileIssueCodes.length > 0) {
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}paper/compile_report.json`,
      target_node: "write_paper",
      recommended_prompt_node: "review",
      prompt_file: "node-prompts/review.md",
      priority: "high",
      diagnostic_ids: compileIssueCodes,
      problem_summary: `Compile report contains paper-build issues that can invalidate rendered references or template output. Codes: ${compileIssueCodes.join(", ")}.`,
      recheck_condition: "paper/compile_report.json has no BibTeX style-file failures or unresolved bibliography build errors."
    });
  }

  const manuscriptQualityGate = await readJsonObjectIfPresent(path.join(runRoot, "paper", "manuscript_quality_gate.json"));
  const remainingManuscriptIssues = Array.isArray(manuscriptQualityGate?.issues_after)
    ? manuscriptQualityGate.issues_after.filter(isRecord)
    : [];
  if (remainingManuscriptIssues.length > 0 || asString(manuscriptQualityGate?.action) === "stop") {
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}paper/manuscript_quality_gate.json`,
      target_node: "write_paper",
      recommended_prompt_node: "review",
      prompt_file: "node-prompts/review.md",
      priority: asString(manuscriptQualityGate?.action) === "stop" ? "high" : "medium",
      diagnostic_ids: remainingManuscriptIssues.map((issue) => asString(issue.code)).filter(Boolean),
      problem_summary: summarizeArtifactIssueCodes(remainingManuscriptIssues, "Manuscript-quality gate reported remaining paper-surface issues."),
      recheck_condition: "paper/manuscript_quality_gate.json has no fail issues and remaining warnings are non-misleading."
    });
  }

  const scientificValidation = await readJsonObjectIfPresent(path.join(runRoot, "paper", "scientific_validation.json"));
  const missingEvidence = collectScientificMissingEvidence(scientificValidation);
  const scientificStatus = asString(scientificValidation?.status);
  if (missingEvidence.length > 0 || scientificStatus === "fail") {
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}paper/scientific_validation.json`,
      target_node: "run_experiments",
      recommended_prompt_node: "design_experiments",
      prompt_file: "node-prompts/design_experiments.md",
      priority: scientificStatus === "fail" ? "high" : "medium",
      diagnostic_ids: missingEvidence,
      problem_summary: missingEvidence.length > 0
        ? `Scientific validation is missing: ${missingEvidence.join(", ")}.`
        : "Scientific validation failed without a richer upstream evidence plan.",
      recheck_condition: "paper/scientific_validation.json no longer reports missing evidence categories for the intended claim ceiling."
    });
  }

  const gateDecision = await readJsonObjectIfPresent(path.join(runRoot, "paper", "gate_decision.json"));
  const gateDecisionIssueCodes = summarizeGateDecisionIssueCodes(gateDecision);
  if (gateDecisionIssueCodes.length > 0) {
    entries.push({
      run_id: runId,
      source_artifact: `${artifactPrefix}paper/gate_decision.json`,
      target_node: "write_paper",
      recommended_prompt_node: "review",
      prompt_file: "node-prompts/review.md",
      priority: "high",
      diagnostic_ids: gateDecisionIssueCodes,
      problem_summary: `Scientific gate decision reports manuscript consistency defects. Codes: ${gateDecisionIssueCodes.join(", ")}.`,
      recheck_condition: "paper/gate_decision.json has no blocking table/figure consistency defects."
    });
  }

  return entries;
}

async function resolveMetaHarnessPromptPath(cwd: string, node: MetaHarnessNode): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "../../..");
  const candidates = Array.from(new Set([
    path.join(cwd, "node-prompts", `${node}.md`),
    path.join(repoRoot, "node-prompts", `${node}.md`)
  ]));
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function summarizeCompileReportIssueCodes(report: Record<string, unknown> | null | undefined): string[] {
  if (!report) {
    return [];
  }
  const raw = JSON.stringify(report);
  const codes: string[] = [];
  if (/I could[^\n]*open style file\s+[^\s]+\.bst/iu.test(raw) || /I found no style file/iu.test(raw)) {
    codes.push("missing_bibliography_style_file");
  }
  if (/Empty [^\n]*thebibliography[^\n]*environment/iu.test(raw) || /I found no \\citation commands/iu.test(raw)) {
    codes.push("empty_bibliography");
  }
  return Array.from(new Set(codes));
}

function collectScientificMissingEvidence(report: Record<string, unknown> | null | undefined): string[] {
  if (!report) {
    return [];
  }
  const topLevel = asStringArray(report.missing_evidence_categories) || [];
  const diagnostics = isRecord(report.evidence_diagnostics) ? report.evidence_diagnostics : undefined;
  const nested = asStringArray(diagnostics?.missing_evidence_categories) || [];
  return Array.from(new Set([...topLevel, ...nested]));
}

function summarizeGateDecisionIssueCodes(report: Record<string, unknown> | null | undefined): string[] {
  if (!report) {
    return [];
  }
  const raw = JSON.stringify(report);
  const codes: string[] = [];
  if (/Table 1 and Figure 1 report conflicting aggregate accuracy values/iu.test(raw)) {
    codes.push("table_figure_aggregate_accuracy_conflict");
  }
  return codes;
}

function summarizeArtifactIssueCodes(issues: Record<string, unknown>[], fallback: string): string {
  const codes = Array.from(new Set(issues.map((issue) => asString(issue.code)).filter(Boolean)));
  return codes.length > 0 ? `${fallback} Codes: ${codes.join(", ")}.` : fallback;
}

function mapStrengtheningTargetToPromptNode(targetNode: string): MetaHarnessNode | undefined {
  if ((META_HARNESS_PROMPT_NODES as readonly string[]).includes(targetNode)) {
    return targetNode as MetaHarnessNode;
  }
  if (targetNode === "implement_experiments" || targetNode === "run_experiments") {
    return "design_experiments";
  }
  if (targetNode === "write_paper" || targetNode === "figure_audit") {
    return "review";
  }
  if (targetNode === "collect_papers" || targetNode === "analyze_papers") {
    return "generate_hypotheses";
  }
  return undefined;
}

async function readJsonObjectIfPresent(filePath: string): Promise<Record<string, unknown> | undefined> {
  if (!(await fileExists(filePath))) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return values.length > 0 ? values : undefined;
}

async function selectRecentRuns(runtime: AutoLabOSRuntime, count: number): Promise<MetaHarnessRunSummary[]> {
  const runs = await runtime.runStore.listRuns();
  const selected = runs
    .filter((run) => run.status === "completed")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, count);
  return Promise.all(
    selected.map(async (run) => ({
      run,
      paperReadinessScore: await readPaperReadinessScore(runtime.paths.cwd, run.id)
    }))
  );
}

function createMetaHarnessLlm(runtime: AutoLabOSRuntime): LLMClient {
  const providers = runtime.config.providers;
  if (providers.llm_mode === "openai_api") {
    return new OpenAiResponsesLLMClient(runtime.openAiTextClient, {
      model: providers.openai.chat_model || providers.openai.model,
      reasoningEffort: providers.openai.chat_reasoning_effort || providers.openai.reasoning_effort
    });
  }
  if (providers.llm_mode === "ollama") {
    return new OllamaLLMClient(
      new OllamaClient(providers.ollama?.base_url || DEFAULT_OLLAMA_BASE_URL),
      { model: providers.ollama?.chat_model || providers.ollama?.research_model }
    );
  }
  const codexOAuthText = new CodexOAuthResponsesTextClient(() => resolveCodexOAuthCredentials(), {
    model: providers.codex.chat_model || providers.codex.model,
    reasoningEffort: providers.codex.chat_reasoning_effort || providers.codex.reasoning_effort
  });
  return new CodexOAuthResponsesLLMClient(codexOAuthText, {
    model: providers.codex.chat_model || providers.codex.model,
    reasoningEffort: providers.codex.chat_reasoning_effort || providers.codex.reasoning_effort
  });
}

async function defaultCallLlm(
  client: LLMClient,
  input: { systemPrompt: string; userPrompt: string }
): Promise<string> {
  const completion = await client.complete(input.userPrompt, {
    systemPrompt: input.systemPrompt
  });
  return completion.text;
}

export function parseMetaHarnessResponse(
  raw: string
): { targetFile: string; diffText: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const targetMatch = normalized.match(/^TARGET_FILE:\s+(.+)$/m);
  const diffStart = normalized.indexOf("--- a/");
  if (!targetMatch || diffStart < 0) {
    return null;
  }
  const targetFile = targetMatch[1].trim();
  const diffText = normalized.slice(diffStart).trim();
  if (!targetFile.startsWith("node-prompts/")) {
    return null;
  }
  if (!diffText.includes("+++ b/")) {
    return null;
  }
  return { targetFile, diffText };
}

export function applyUnifiedDiff(originalContent: string, diffText: string): string {
  const lines = diffText.replace(/\r\n/g, "\n").split("\n");
  const hunks: Array<{ oldStart: number; oldCount: number; lines: string[] }> = [];
  let index = 0;
  while (index < lines.length && !lines[index].startsWith("@@")) {
    index += 1;
  }
  while (index < lines.length) {
    const header = lines[index];
    const match = header.match(/^@@\s+\-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!match) {
      throw new Error("Invalid unified diff hunk header.");
    }
    const oldStart = Number(match[1]);
    const oldCount = Number(match[2] || "1");
    index += 1;
    const hunkLines: string[] = [];
    while (index < lines.length && !lines[index].startsWith("@@")) {
      hunkLines.push(lines[index]);
      index += 1;
    }
    hunks.push({ oldStart, oldCount, lines: hunkLines });
  }

  const sourceLines = originalContent.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let sourceIndex = 0;

  for (const hunk of hunks) {
    const targetIndex = Math.max(hunk.oldStart - 1, 0);
    while (sourceIndex < targetIndex) {
      output.push(sourceLines[sourceIndex]);
      sourceIndex += 1;
    }
    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        output.push(line.slice(1));
        sourceIndex += 1;
      } else if (line.startsWith("-")) {
        sourceIndex += 1;
      } else if (line.startsWith("+")) {
        output.push(line.slice(1));
      } else if (line === "\\ No newline at end of file") {
        continue;
      } else {
        throw new Error("Invalid unified diff body line.");
      }
    }
  }

  while (sourceIndex < sourceLines.length) {
    output.push(sourceLines[sourceIndex]);
    sourceIndex += 1;
  }

  return output.join("\n");
}

function computeAveragePaperReadinessScore(runs: MetaHarnessRunSummary[]): number | null {
  const scores = runs
    .map((run) => run.paperReadinessScore)
    .filter((score): score is number => typeof score === "number" && Number.isFinite(score));
  if (scores.length === 0) {
    return null;
  }
  return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100) / 100;
}

async function readPaperReadinessScore(cwd: string, runId: string): Promise<number | null> {
  const paperReadinessPath = path.join(buildWorkspaceRunRoot(cwd, runId), "paper", "paper_readiness.json");
  if (!(await fileExists(paperReadinessPath))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(paperReadinessPath, "utf8")) as { overall_score?: unknown };
    return typeof parsed.overall_score === "number" && Number.isFinite(parsed.overall_score)
      ? parsed.overall_score
      : null;
  } catch {
    return null;
  }
}

async function copyFileToContext(sourcePath: string, targetPath: string): Promise<void> {
  await ensureDir(path.dirname(targetPath));
  await fs.copyFile(sourcePath, targetPath);
}

async function listFilesRecursively(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const nextPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(nextPath)));
    } else if (entry.isFile()) {
      files.push(nextPath);
    }
  }
  return files.sort();
}

function formatTimestamp(now: Date): string {
  return now.toISOString().replace(/[:]/g, "-").replace(/\.\d{3}Z$/, "Z");
}
