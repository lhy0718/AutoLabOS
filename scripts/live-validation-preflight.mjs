#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const validationRoot = process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT
  ? resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE_ROOT)
  : resolve(repoRoot, "..", ".autolabos-validation");
const workspaceRoot = resolve(process.env.AUTOLABOS_VALIDATION_WORKSPACE || join(validationRoot, "live-validation"));
const outDir = resolve(process.env.AUTOLABOS_VALIDATION_PREFLIGHT_OUT || join(repoRoot, "outputs", "live-validation-preflight"));
const briefSourceValue = String(process.env.AUTOLABOS_VALIDATION_BRIEF_SOURCE || "").trim();
const briefSource = briefSourceValue ? resolve(repoRoot, briefSourceValue) : undefined;
const briefRelativePath = process.env.AUTOLABOS_VALIDATION_BRIEF || join("briefs", "live-validation-brief.md");
const briefTarget = join(workspaceRoot, briefRelativePath);
const preflightProfile = String(
  process.env.AUTOLABOS_VALIDATION_PREFLIGHT_PROFILE || "generic"
).trim().toLowerCase();
if (!["generic", "ml-cuda-acl"].includes(preflightProfile)) {
  throw new Error(
    `Unsupported AUTOLABOS_VALIDATION_PREFLIGHT_PROFILE=${JSON.stringify(preflightProfile)}. ` +
    "Use generic or ml-cuda-acl."
  );
}
const runMlCudaAclChecks = preflightProfile === "ml-cuda-acl";
const aclTemplatePath = process.env.AUTOLABOS_VALIDATION_ACL_TEMPLATE
  ? resolve(repoRoot, process.env.AUTOLABOS_VALIDATION_ACL_TEMPLATE)
  : undefined;
let briefPreparationMode = "unresolved";

function csvEnv(name, fallback = []) {
  const raw = process.env[name] || "";
  const values = raw.split(",").map((value) => value.trim()).filter(Boolean);
  return values.length > 0 ? values : fallback;
}

const requiredPythonModules = csvEnv("AUTOLABOS_VALIDATION_REQUIRED_PYTHON_MODULES", [
  "torch",
  "transformers",
  "datasets",
  "accelerate"
]);
const optionalPythonModules = csvEnv("AUTOLABOS_VALIDATION_OPTIONAL_PYTHON_MODULES", ["lm_eval"]);
const hfCacheRoot = process.env.HF_HOME || join(process.env.HOME || "", ".cache", "huggingface");
const codexResearchModel =
  process.env.AUTOLABOS_VALIDATION_CODEX_MODEL || "gpt-5.6-sol";
const codexChatModel =
  process.env.AUTOLABOS_VALIDATION_CODEX_CHAT_MODEL || "gpt-5.6-terra";
const codexExperimentModel =
  process.env.AUTOLABOS_VALIDATION_CODEX_EXPERIMENT_MODEL || codexResearchModel;
const openAiResearchModel =
  process.env.AUTOLABOS_VALIDATION_OPENAI_MODEL || "gpt-5.6-sol";
const openAiChatModel =
  process.env.AUTOLABOS_VALIDATION_OPENAI_CHAT_MODEL || "gpt-5.6-terra";
const openAiExperimentModel =
  process.env.AUTOLABOS_VALIDATION_OPENAI_EXPERIMENT_MODEL || openAiResearchModel;
const validationLlmMode = normalizeValidationLlmMode(
  process.env.AUTOLABOS_VALIDATION_LLM_MODE || "codex_chatgpt_only"
);
const ollamaBaseUrl = String(
  process.env.AUTOLABOS_VALIDATION_OLLAMA_BASE_URL || "http://127.0.0.1:11434"
).trim();
const ollamaResearchModel = String(
  process.env.AUTOLABOS_VALIDATION_OLLAMA_RESEARCH_MODEL || ""
).trim();
const ollamaChatModel = String(
  process.env.AUTOLABOS_VALIDATION_OLLAMA_CHAT_MODEL || ollamaResearchModel
).trim();
const ollamaExperimentModel = String(
  process.env.AUTOLABOS_VALIDATION_OLLAMA_EXPERIMENT_MODEL || ollamaResearchModel
).trim();
const ollamaVisionModel = String(
  process.env.AUTOLABOS_VALIDATION_OLLAMA_VISION_MODEL || ollamaResearchModel
).trim();
const modelCacheCandidates = csvEnv("AUTOLABOS_VALIDATION_MODEL_CACHE_DIRS").map((name) => join(hfCacheRoot, "hub", name));
const datasetCacheRoot = join(hfCacheRoot, "datasets");
const expectedDatasets = csvEnv("AUTOLABOS_VALIDATION_EXPECTED_DATASET_CACHE_DIRS");

if (validationLlmMode === "ollama" && !ollamaResearchModel) {
  throw new Error(
    "AUTOLABOS_VALIDATION_OLLAMA_RESEARCH_MODEL is required when " +
    "AUTOLABOS_VALIDATION_LLM_MODE=ollama."
  );
}

function normalizeValidationLlmMode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["codex", "codex_chatgpt_only", "openai_api", "ollama"].includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `Unsupported AUTOLABOS_VALIDATION_LLM_MODE=${JSON.stringify(value)}. ` +
    "Use codex, codex_chatgpt_only, openai_api, or ollama."
  );
}

function yamlScalar(value) {
  return JSON.stringify(String(value));
}

function providerConfigLines() {
  const lines = [
    "providers:",
    `  llm_mode: ${validationLlmMode}`,
    "  codex:",
    `    model: ${yamlScalar(codexResearchModel)}`,
    `    chat_model: ${yamlScalar(codexChatModel)}`,
    `    experiment_model: ${yamlScalar(codexExperimentModel)}`,
    "    reasoning_effort: high",
    "    chat_reasoning_effort: medium",
    "    experiment_reasoning_effort: high",
    "    auth_required: true",
    "    fast_mode: false",
    "  openai:",
    `    model: ${yamlScalar(openAiResearchModel)}`,
    `    chat_model: ${yamlScalar(openAiChatModel)}`,
    `    experiment_model: ${yamlScalar(openAiExperimentModel)}`,
    "    reasoning_effort: medium",
    "    chat_reasoning_effort: medium",
    "    experiment_reasoning_effort: high",
    "    api_key_required: true"
  ];
  if (validationLlmMode === "ollama") {
    lines.push(
      "  ollama:",
      `    base_url: ${yamlScalar(ollamaBaseUrl)}`,
      `    chat_model: ${yamlScalar(ollamaChatModel)}`,
      `    research_model: ${yamlScalar(ollamaResearchModel)}`,
      `    experiment_model: ${yamlScalar(ollamaExperimentModel)}`,
      `    vision_model: ${yamlScalar(ollamaVisionModel)}`
    );
  }
  return lines;
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd || repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeout || 30_000,
      env: { ...process.env, ...(options.env || {}) }
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error.stdout === "string" ? error.stdout.trim() : "",
      stderr: typeof error.stderr === "string" ? error.stderr.trim() : error.message
    };
  }
}

function existsDirectory(path) {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function ensureWorkspace() {
  mkdirSync(join(workspaceRoot, ".autolabos", "runs"), { recursive: true });
  mkdirSync(join(workspaceRoot, ".autolabos", "logs"), { recursive: true });
  mkdirSync(outDir, { recursive: true });

  if (existsSync(briefTarget)) {
    if (!statSync(briefTarget).isFile() || readFileSync(briefTarget, "utf8").trim() === "") {
      throw new Error("Existing governed brief target is not a readable non-empty file: " + briefTarget);
    }
    if (briefSource) {
      if (!existsSync(briefSource)) {
        throw new Error("Missing explicit live-validation brief source: " + briefSource);
      }
      if (!readFileSync(briefSource).equals(readFileSync(briefTarget))) {
        throw new Error(
          "Refusing to overwrite existing governed brief target: " + briefTarget + ". " +
          "Omit AUTOLABOS_VALIDATION_BRIEF_SOURCE to validate the existing target, or choose a new target path."
        );
      }
    }
    briefPreparationMode = "existing_target_validated";
  } else {
    if (!briefSource) {
      throw new Error(
        "No governed brief exists at " + briefTarget + ". " +
        "Set AUTOLABOS_VALIDATION_BRIEF_SOURCE to an explicit governed brief before running preflight."
      );
    }
    if (!existsSync(briefSource)) {
      throw new Error("Missing explicit live-validation brief source: " + briefSource);
    }
    mkdirSync(dirname(briefTarget), { recursive: true });
    copyFileSync(briefSource, briefTarget, fsConstants.COPYFILE_EXCL);
    briefPreparationMode = "explicit_source_copied";
  }

  if (!existsSync(join(workspaceRoot, "ISSUES.md"))) {
    writeFileSync(join(workspaceRoot, "ISSUES.md"), "## Active issues\n\nnone\n", "utf8");
  }
  writeFileSync(
    join(workspaceRoot, ".autolabos", "config.yaml"),
    [
      "version: 1",
      "project_name: live-validation",
      ...providerConfigLines(),
      "analysis:",
      `  responses_model: ${yamlScalar(openAiResearchModel)}`,
      "papers:",
      "  max_results: 80",
      "  per_second_limit: 1",
      "research:",
      `  default_topic: ${process.env.AUTOLABOS_VALIDATION_DEFAULT_TOPIC || "bounded condition-sweep validation"}`,
      "  default_constraints:",
      "    - fixed execution budget",
      "    - explicit baseline and comparator result table",
      `  default_objective_metric: ${process.env.AUTOLABOS_VALIDATION_DEFAULT_OBJECTIVE_METRIC || "primary metric delta versus baseline"}`,
      "workflow:",
      "  mode: agent_approval",
      "  wizard_enabled: true",
      "  approval_mode: manual",
      "  execution_approval_mode: manual",
      "experiments:",
      "  runner: local_python",
      "  timeout_sec: 14400",
      "  network_policy: declared",
      "  network_purpose: model_download",
      "  candidate_isolation: attempt_snapshot_restore",
      "paper:",
      "  template: acl",
      "  build_pdf: true",
      "  latex_engine: auto_install",
      "  validation_mode: strict_paper",
      "paths:",
      "  runs_dir: .autolabos/runs",
      "  logs_dir: .autolabos/logs",
      ""
    ].join("\n"),
    "utf8"
  );
}

function pythonModuleReport() {
  if (!runMlCudaAclChecks) {
    return { ok: true, skipped: true, reason: "not selected by generic preflight profile" };
  }
  const code = `
import importlib.util, json
mods = ${JSON.stringify([...requiredPythonModules, ...optionalPythonModules])}
report = {m: bool(importlib.util.find_spec(m)) for m in mods}
try:
    import torch
    report["torch_cuda_available"] = bool(torch.cuda.is_available())
    report["torch_cuda_device_count"] = int(torch.cuda.device_count())
    report["torch_cuda_names"] = [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())]
except Exception as exc:
    report["torch_cuda_error"] = str(exc)
print(json.dumps(report, sort_keys=True))
`;
  const result = run("python3", ["-c", code], { timeout: 60_000 });
  if (!result.ok) {
    return { ok: false, error: result.stderr || result.stdout };
  }
  try {
    return { ok: true, ...(JSON.parse(result.stdout) || {}) };
  } catch (error) {
    return { ok: false, error: error.message, raw: result.stdout };
  }
}

async function doctorReport() {
  const doctorModulePath = join(repoRoot, "dist", "core", "doctor.js");
  if (!existsSync(doctorModulePath)) {
    return { available: false, status: "fail", reason: "dist/core/doctor.js is missing; run npm run build first." };
  }
  const { runDoctorReport, getDoctorAggregateStatus, mapDoctorCheckForApi } = await import(doctorModulePath);
  const pdfAnalysisMode = validationLlmMode === "openai_api"
    ? "responses_api_pdf"
    : validationLlmMode === "ollama"
      ? "ollama_vision"
      : "codex_text_image_hybrid";
  const report = await runDoctorReport(
    {},
    {
      llmMode: validationLlmMode,
      pdfAnalysisMode,
      openAiApiKeyConfigured: Boolean(String(process.env.OPENAI_API_KEY || "").trim()),
      codexResearchModel,
      ollamaBaseUrl,
      ollamaChatModel,
      ollamaResearchModel,
      ollamaVisionModel,
      workspaceRoot,
      approvalMode: "manual",
      executionApprovalMode: "manual",
      dependencyMode: "local_python",
      sessionMode: "fresh",
      codeExecutionExpected: true,
      candidateIsolation: "attempt_snapshot_restore",
      networkPolicy: "declared",
      networkPurpose: "model_download",
      includeHarnessValidation: true,
      includeHarnessTestRecords: false,
      maxHarnessFindings: 30,
      researchBriefPath: briefRelativePath
    }
  );
  const checks = report.checks.map((check) => mapDoctorCheckForApi(check));
  return {
    available: true,
    status: getDoctorAggregateStatus({ checks: report.checks, harness: report.harness }),
    readiness: report.readiness,
    checks,
    harness: report.harness
  };
}

function buildChecks({ pythonReport, doctor }) {
  const cachedModelDirs = modelCacheCandidates.filter((candidatePath) => existsDirectory(candidatePath));
  const datasetDirs = expectedDatasets.filter((name) => existsDirectory(join(datasetCacheRoot, name)));
  const commands = {
    node: run("node", ["--version"]),
    npm: run("npm", ["--version"]),
    python3: run("python3", ["--version"]),
    pip3: run("pip3", ["--version"]),
    expect: run("expect", ["-v"]),
    disk: run("df", ["-h", workspaceRoot]),
    memory: run("free", ["-h"])
  };
  if (runMlCudaAclChecks) {
    commands.nvidiaSmi = run("nvidia-smi", [
      "--query-gpu=name,memory.total,driver_version",
      "--format=csv,noheader"
    ]);
    commands.latexmk = run("latexmk", ["--version"]);
    commands.pdflatex = run("pdflatex", ["--version"]);
    commands.bibtex = run("bibtex", ["--version"]);
  }

  const checks = [
    {
      id: "provider_profile_matches_request",
      ok: doctor.readiness?.llmMode === validationLlmMode,
      detail: `requested=${validationLlmMode}, diagnosed=${doctor.readiness?.llmMode || "unknown"}`
    },
    {
      id: "validation_workspace_writable",
      ok: existsDirectory(workspaceRoot) && existsDirectory(join(workspaceRoot, ".autolabos", "runs")),
      detail: workspaceRoot
    },
    {
      id: "governed_brief_frozen",
      ok: existsSync(briefTarget),
      detail: briefRelativePath + " (" + briefPreparationMode + ")"
    },
    {
      id: "node_runtime",
      ok: commands.node.ok,
      detail: commands.node.stdout || commands.node.stderr
    },
    {
      id: "npm_runtime",
      ok: commands.npm.ok,
      detail: commands.npm.stdout || commands.npm.stderr
    },
    {
      id: "python_runtime",
      ok: commands.python3.ok,
      detail: commands.python3.stdout || commands.python3.stderr
    },
    {
      id: "tty_automation_available",
      ok: commands.expect.ok,
      severity: commands.expect.ok ? "ok" : "warn",
      detail: commands.expect.ok
        ? commands.expect.stdout || commands.expect.stderr
        : "expect is unavailable; Python PTY fallback is required for automated TUI validation."
    },
    {
      id: "doctor_engine",
      ok: doctor.available === true && doctor.status !== "fail",
      detail: doctor.available ? "doctor status=" + doctor.status : doctor.reason
    }
  ];

  if (runMlCudaAclChecks) {
    const requiredModulesOk = requiredPythonModules.every((name) => pythonReport[name] === true);
    const cudaOk =
      pythonReport.torch_cuda_available === true &&
      Number(pythonReport.torch_cuda_device_count || 0) >= 1;
    const builtInAclTemplate = join(repoRoot, "dist", "core", "latex", "aclTemplate.js");
    checks.push(
      {
        id: "required_python_modules",
        ok: requiredModulesOk,
        detail: requiredPythonModules
          .map((name) => name + "=" + (pythonReport[name] === true ? "yes" : "no"))
          .join(", ")
      },
      {
        id: "cuda_visible",
        ok: cudaOk,
        detail: pythonReport.torch_cuda_names
          ? pythonReport.torch_cuda_names.join("; ")
          : pythonReport.torch_cuda_error || "unknown"
      },
      {
        id: "nvidia_smi_available",
        ok: commands.nvidiaSmi.ok,
        detail: commands.nvidiaSmi.stdout || commands.nvidiaSmi.stderr
      },
      {
        id: "model_cache_available",
        ok: modelCacheCandidates.length === 0 || cachedModelDirs.length > 0,
        detail: modelCacheCandidates.length === 0
          ? "no model cache candidates configured"
          : cachedModelDirs.length + "/" + modelCacheCandidates.length + " configured model cache candidate(s) present"
      },
      {
        id: "datasets_cached",
        ok: expectedDatasets.length === 0 || datasetDirs.length === expectedDatasets.length,
        detail: expectedDatasets.length === 0
          ? "no dataset cache directories configured"
          : datasetDirs.length + "/" + expectedDatasets.length + " configured dataset cache directories present"
      },
      {
        id: "evaluator_available",
        ok: pythonReport.lm_eval === true,
        severity: pythonReport.lm_eval === true ? "ok" : "warn",
        detail: pythonReport.lm_eval === true
          ? "lm_eval module available"
          : "lm_eval is not installed; use a node-owned local evaluator or install the external harness before a paper-ready claim."
      },
      {
        id: "acl_template_available",
        ok: aclTemplatePath ? existsSync(aclTemplatePath) : existsSync(builtInAclTemplate),
        detail: aclTemplatePath ? "explicit ACL template path" : "built-in ACL template runtime"
      },
      {
        id: "acl_latex_engine_available",
        ok: commands.latexmk.ok || commands.pdflatex.ok,
        detail: commands.latexmk.stdout || commands.pdflatex.stdout ||
          commands.pdflatex.stderr || commands.latexmk.stderr
      },
      {
        id: "acl_bibliography_tool_available",
        ok: commands.bibtex.ok,
        detail: commands.bibtex.stdout || commands.bibtex.stderr
      }
    );
  }
  return { checks, commands };
}

function markdownReport(summary) {
  const requiredBlockers = summary.checks
    .filter((check) => check.ok !== true && check.severity !== "warn")
    .map((check) => check.id);
  const warnings = summary.checks
    .filter((check) => check.ok !== true && check.severity === "warn")
    .map((check) => check.id);
  return [
    "# Live Validation Preflight Report",
    "",
    `Generated: ${summary.generatedAt}`,
    "",
    "## Verdict",
    "",
    `- Profile: ${summary.preflightProfile}`,
    `- LLM provider: ${summary.validationLlmMode}`,
    `- Ready for selected profile: ${summary.readyForSelectedProfile ? "yes" : "no"}`,
    `- Required blockers: ${requiredBlockers.length ? requiredBlockers.join(", ") : "none"}`,
    `- Warnings: ${warnings.length ? warnings.join(", ") : "none"}`,
    "",
    "## Workspace",
    "",
    `- Validation workspace: <validation-workspace>/live-validation`,
    `- Brief: ${summary.briefRelativePath}`,
    `- Brief preparation: ${summary.briefPreparationMode}`,
    "",
    "## Checks",
    "",
    ...summary.checks.map((check) => `- ${check.ok ? "PASS" : check.severity === "warn" ? "WARN" : "FAIL"} ${check.id}: ${check.detail}`),
    "",
    "## Doctor",
    "",
    `- Status: ${summary.doctor.status || "unavailable"}`,
    `- Blocked: ${summary.doctor.readiness?.blocked === true ? "yes" : summary.doctor.readiness?.blocked === false ? "no" : "unknown"}`,
    "",
    "## Next Action",
    "",
    summary.readyForSelectedProfile
      ? "Start the live-validation run from the validation workspace after running the TUI `/doctor` surface."
      : "Resolve required blockers for the selected profile before starting the run. Warnings may be accepted only if the brief and audit ceiling explicitly account for them.",
    ""
  ].join("\n");
}

async function main() {
  ensureWorkspace();
  const pythonReport = pythonModuleReport();
  const doctor = await doctorReport();
  const { checks, commands } = buildChecks({ pythonReport, doctor });
  const requiredBlockers = checks.filter((check) => check.ok !== true && check.severity !== "warn");
  const summary = {
    generatedAt: new Date().toISOString(),
    preflightProfile,
    validationLlmMode,
    repoRoot,
    validationRoot,
    workspaceRoot,
    outDir,
    briefSource,
    briefRelativePath,
    briefTarget,
    briefPreparationMode,
    pythonReport,
    commands,
    doctor,
    checks,
    readyForSelectedProfile: requiredBlockers.length === 0
  };
  writeFileSync(join(outDir, "preflight-summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  writeFileSync(join(outDir, "preflight-report.md"), markdownReport(summary), "utf8");
  process.stdout.write(`Validation preflight profile=${summary.preflightProfile} ready=${summary.readyForSelectedProfile ? "yes" : "no"}\n`);
  process.stdout.write(`Report: outputs/live-validation-preflight/preflight-report.md\n`);
  if (requiredBlockers.length > 0) {
    process.stdout.write(`Blockers: ${requiredBlockers.map((check) => check.id).join(", ")}\n`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
