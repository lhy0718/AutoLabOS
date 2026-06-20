import path from "node:path";
import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";

import type { ExperimentComparisonContract } from "../experimentGovernance.js";

export interface ExperimentDesignImplementationValidationFinding {
  code: string;
  severity: "block" | "warn";
  message: string;
  evidence?: string;
}

export interface ExperimentDesignImplementationValidationReport {
  version: 1;
  generated_at: string;
  verdict: "allow" | "block";
  summary: string;
  checked_items: string[];
  findings: ExperimentDesignImplementationValidationFinding[];
  contract?: {
    plan_id: string;
    comparison_mode: ExperimentComparisonContract["comparison_mode"];
    baseline_first_required: boolean;
    objective_metric_name: string;
  };
}

export interface PlannedConditionImplementationContract {
  required_condition_count?: number;
  required_run_count?: number;
  seed_schedule?: number[];
  minimum_seeds_per_condition?: number;
  baseline_condition_marker?: string;
  required_condition_markers?: string[];
  primary_metric_key?: string;
  full_evaluation_required?: boolean;
  minimum_eval_examples_per_task?: Record<string, number>;
}

export async function validateDesignImplementationAlignment(input: {
  comparisonContract?: ExperimentComparisonContract;
  plannedConditionContract?: PlannedConditionImplementationContract;
  attempt: {
    runCommand: string;
    testCommand?: string;
    scriptPath?: string;
    metricsPath: string;
    workingDir: string;
    publicDir: string;
    changedFiles: string[];
    publicArtifacts: string[];
  };
}): Promise<ExperimentDesignImplementationValidationReport> {
  const findings: ExperimentDesignImplementationValidationFinding[] = [];
  const checkedItems: string[] = [];
  const commandPaths = extractCommandPaths(input.attempt.runCommand, input.attempt.workingDir);
  const testCommandPaths = extractCommandPaths(input.attempt.testCommand || "", input.attempt.workingDir);
  const allCommandPaths = dedupeStrings([...commandPaths, ...testCommandPaths]);
  const scriptText = await readImplementationSurfaceText(input.attempt.scriptPath);
  const publicContractText = await readPublicContractSurfaceText(
    input.attempt.publicDir,
    input.attempt.publicArtifacts
  );

  if (input.attempt.scriptPath && /\.py$/iu.test(input.attempt.scriptPath)) {
    checkedItems.push("python_runnable_surface");
    findings.push(...validatePythonRunnableSurface(input.attempt.scriptPath, scriptText));
  }

  checkedItems.push("run_command_paths");
  if (input.attempt.scriptPath) {
    checkedItems.push("script_path_binding");
    const referencedScript = allCommandPaths.find((candidate) => isRunnableScript(candidate));
    const runCommandTargetsScriptPath =
      referencedScript &&
      (samePath(referencedScript, input.attempt.scriptPath) ||
        (await missingSameNamedScriptReference(referencedScript, input.attempt.scriptPath)) ||
        (await shellWrapperReferencesScriptPath(referencedScript, input.attempt.scriptPath)));
    if (referencedScript && !runCommandTargetsScriptPath) {
      findings.push({
        code: "RUN_COMMAND_SCRIPT_MISMATCH",
        severity: "block",
        message: "run_command references a different executable script than script_path.",
        evidence: `script_path=${input.attempt.scriptPath}; run_command_script=${referencedScript}`
      });
    }
  }

  if (input.attempt.scriptPath) {
    const publicRunCommandWrappers = await findPublicRunCommandWrappers(
      input.attempt.publicDir,
      input.attempt.publicArtifacts
    );
    if (publicRunCommandWrappers.length > 0) {
      checkedItems.push("public_run_command_wrapper_binding");
    }
    for (const wrapperPath of publicRunCommandWrappers) {
      if (samePath(wrapperPath, input.attempt.scriptPath)) {
        continue;
      }
      const wrapperTargetsScriptPath = await shellWrapperReferencesScriptPath(wrapperPath, input.attempt.scriptPath);
      if (!wrapperTargetsScriptPath) {
        findings.push({
          code: "PUBLIC_RUN_COMMAND_WRAPPER_SCRIPT_MISMATCH",
          severity: "block",
          message: "A published run_command.sh exists but does not launch the reported script_path.",
          evidence: `script_path=${input.attempt.scriptPath}; public_run_command=${wrapperPath}`
        });
      }
      const unsupportedWrapperFlags = await findUnsupportedWrapperScriptFlags(wrapperPath, scriptText);
      if (unsupportedWrapperFlags.length > 0) {
        findings.push({
          code: "PUBLIC_RUN_COMMAND_WRAPPER_UNSUPPORTED_ARGS",
          severity: "block",
          message: "A published run_command.sh passes CLI options that the reported script_path does not accept.",
          evidence: `script_path=${input.attempt.scriptPath}; public_run_command=${wrapperPath}; unsupported=${unsupportedWrapperFlags.join(", ")}`
        });
      }
    }
  }

  checkedItems.push("public_artifact_binding");
  if (
    input.attempt.scriptPath &&
    isSubpath(input.attempt.scriptPath, input.attempt.publicDir) &&
    !input.attempt.publicArtifacts.some((artifactPath) => samePath(artifactPath, input.attempt.scriptPath || ""))
  ) {
    findings.push({
      code: "PUBLIC_SCRIPT_NOT_DECLARED",
      severity: "block",
      message: "The published script lives in the public experiment directory but was not declared as a public artifact.",
      evidence: `script_path=${input.attempt.scriptPath}; public_dir=${input.attempt.publicDir}`
    });
  }

  checkedItems.push("changed_file_binding");
  if (
    input.attempt.scriptPath &&
    !input.attempt.changedFiles.some((changedPath) => samePath(changedPath, input.attempt.scriptPath || ""))
  ) {
    findings.push({
      code: "SCRIPT_NOT_DECLARED_CHANGED",
      severity: "warn",
      message: "script_path was not included in changed_files. Artifact publication may still work, but auditability is weaker.",
      evidence: `script_path=${input.attempt.scriptPath}`
    });
  }

  checkedItems.push("metrics_path_consistency");
  const referencedMetricsPath = findMetricsPathReference(allCommandPaths);
  if (referencedMetricsPath && !samePath(referencedMetricsPath, input.attempt.metricsPath)) {
    findings.push({
      code: "METRICS_PATH_MISMATCH",
      severity: "block",
      message: "A metrics path was declared in the command surface, but it does not match the locked metrics_path.",
      evidence: `metrics_path=${input.attempt.metricsPath}; command_metrics_path=${referencedMetricsPath}`
    });
  }

  checkedItems.push("baseline_contract_presence");
  if (input.comparisonContract?.baseline_first_required) {
    const baselineSignal = `${input.attempt.runCommand}\n${scriptText}`.toLowerCase();
    if (!/(baseline|control|comparator|greedy)/u.test(baselineSignal)) {
      findings.push({
        code: "BASELINE_SIGNAL_MISSING",
        severity: "warn",
        message: "The locked comparison contract requires a baseline-first evaluation, but the implementation surface does not expose an obvious baseline signal.",
        evidence: `plan_id=${input.comparisonContract.plan_id}; baseline_candidates=${input.comparisonContract.baseline_candidate_ids.join(", ") || "none"}`
      });
    }
  }

  if (input.plannedConditionContract) {
    checkedItems.push("planned_condition_contract_alignment");
    const plannedFindings = validatePlannedConditionImplementationSurface({
      contract: input.plannedConditionContract,
      scriptText,
      publicContractText,
      runCommand: input.attempt.runCommand,
      testCommand: input.attempt.testCommand || ""
    });
    findings.push(...plannedFindings);
  }

  const blockingFindings = findings.filter((finding) => finding.severity === "block");
  const summary = blockingFindings.length > 0
    ? `Design-to-implementation validation blocked handoff with ${blockingFindings.length} blocking finding(s).`
    : findings.length > 0
      ? `Design-to-implementation validation passed with ${findings.length} warning(s).`
      : "Design-to-implementation validation passed.";

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    verdict: blockingFindings.length > 0 ? "block" : "allow",
    summary,
    checked_items: checkedItems,
    findings,
    contract: input.comparisonContract
      ? {
          plan_id: input.comparisonContract.plan_id,
          comparison_mode: input.comparisonContract.comparison_mode,
          baseline_first_required: input.comparisonContract.baseline_first_required,
          objective_metric_name: input.comparisonContract.objective_metric_name
        }
      : undefined
  };
}

export function validateVerificationCommandSurface(input: {
  comparisonContract?: ExperimentComparisonContract;
  verificationCommand: string;
  workingDir: string;
  scriptPath?: string;
  metricsPath: string;
  runCommand: string;
}): ExperimentDesignImplementationValidationReport {
  const findings: ExperimentDesignImplementationValidationFinding[] = [];
  const checkedItems = ["verification_command_script_binding", "verification_command_metrics_binding"];
  const verificationPaths = extractCommandPaths(input.verificationCommand, input.workingDir);
  const verificationScript = verificationPaths.find((candidate) => isRunnableScript(candidate));
  const runCommandPaths = extractCommandPaths(input.runCommand || "", input.workingDir);
  const runCommandScript = runCommandPaths.find((candidate) => isRunnableScript(candidate));
  const verificationUsesPublishedRunWrapper =
    verificationScript &&
    runCommandScript &&
    path.extname(verificationScript) === ".sh" &&
    samePath(verificationScript, runCommandScript);
  const verificationUsesScriptPathWrapperTarget =
    input.scriptPath &&
    verificationScript &&
    runCommandScript &&
    path.extname(input.scriptPath) === ".sh" &&
    samePath(input.scriptPath, runCommandScript) &&
    shellWrapperReferencesScriptPathSync(input.scriptPath, verificationScript);
  if (verificationUsesPublishedRunWrapper) {
    checkedItems.push("verification_command_run_wrapper_binding");
  }
  if (verificationUsesScriptPathWrapperTarget) {
    checkedItems.push("verification_command_wrapper_target_binding");
  }
  if (
    input.scriptPath &&
    verificationScript &&
    !samePath(verificationScript, input.scriptPath) &&
    !verificationUsesPublishedRunWrapper &&
    !verificationUsesScriptPathWrapperTarget
  ) {
    findings.push({
      code: "VERIFY_COMMAND_SCRIPT_MISMATCH",
      severity: "block",
      message: "Local verification references a different script than script_path.",
      evidence: `script_path=${input.scriptPath}; verify_command_script=${verificationScript}`
    });
  }

  const verificationMetricsPath = findMetricsPathReference(verificationPaths);
  if (verificationMetricsPath && !samePath(verificationMetricsPath, input.metricsPath)) {
    findings.push({
      code: "VERIFY_COMMAND_METRICS_PATH_MISMATCH",
      severity: "block",
      message: "Local verification references a metrics path that does not match the locked metrics_path.",
      evidence: `metrics_path=${input.metricsPath}; verify_command_metrics_path=${verificationMetricsPath}`
    });
  }

  if (input.comparisonContract?.baseline_first_required) {
    checkedItems.push("verification_baseline_contract_presence");
    const baselineSignal = `${input.runCommand}\n${input.verificationCommand}`.toLowerCase();
    if (!/(baseline|control|comparator|greedy)/u.test(baselineSignal)) {
      findings.push({
        code: "VERIFY_COMMAND_BASELINE_SIGNAL_MISSING",
        severity: "warn",
        message: "Verification surface does not expose an obvious baseline signal for a baseline-first contract.",
        evidence: `plan_id=${input.comparisonContract.plan_id}`
      });
    }
  }

  const blockingFindings = findings.filter((finding) => finding.severity === "block");
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    verdict: blockingFindings.length > 0 ? "block" : "allow",
    summary:
      blockingFindings.length > 0
        ? `Verification command validation blocked execution with ${blockingFindings.length} blocking finding(s).`
        : findings.length > 0
          ? `Verification command validation passed with ${findings.length} warning(s).`
          : "Verification command validation passed.",
    checked_items: checkedItems,
    findings,
    contract: input.comparisonContract
      ? {
          plan_id: input.comparisonContract.plan_id,
          comparison_mode: input.comparisonContract.comparison_mode,
          baseline_first_required: input.comparisonContract.baseline_first_required,
          objective_metric_name: input.comparisonContract.objective_metric_name
        }
      : undefined
  };
}

function validatePlannedConditionImplementationSurface(input: {
  contract: PlannedConditionImplementationContract;
  scriptText: string;
  publicContractText: string;
  runCommand: string;
  testCommand: string;
}): ExperimentDesignImplementationValidationFinding[] {
  const findings: ExperimentDesignImplementationValidationFinding[] = [];
  const implementationExecutionText = stripAutoLabOSPlannedConditionContractBlock(input.scriptText);
  const implementationSignal = `${input.runCommand}\n${input.testCommand}\n${implementationExecutionText}`;
  const publicSignal = input.publicContractText;
  const requiredMarkers = dedupeStrings(input.contract.required_condition_markers || []);
  const baselineMarker = input.contract.baseline_condition_marker || requiredMarkers[0];
  if (requiredMarkers.length > 0) {
    const missingMarkers = requiredMarkers.filter((marker) => !hasMarkerSignal(implementationSignal, marker));
    if (missingMarkers.length > 0) {
      findings.push({
        code: "PLANNED_CONDITION_MARKERS_MISSING",
        severity: "block",
        message: "The implementation surface does not preserve all required planned condition markers.",
        evidence: `missing=${missingMarkers.join(", ")}; required=${requiredMarkers.join(", ")}`
      });
    }
  }

  if (baselineMarker && requiredMarkers.length > 1) {
    const missingBaselineMaterializationEvidence = findBaselineMarkerMissingFromDeclaredConditionCatalogEvidence(
      input.scriptText,
      baselineMarker
    );
    if (missingBaselineMaterializationEvidence) {
      findings.push({
        code: "PLANNED_BASELINE_MARKER_NOT_MATERIALIZED",
        severity: "block",
        message:
          "The implementation indexes the locked baseline marker, but the declared condition catalog does not materialize that marker.",
        evidence: missingBaselineMaterializationEvidence
      });
    }

    const declaredMarkerOrder = extractDeclaredConditionMarkerOrder(input.scriptText, requiredMarkers);
    if (declaredMarkerOrder.length > 1 && declaredMarkerOrder[0] !== baselineMarker) {
      findings.push({
        code: "PLANNED_BASELINE_ORDER_MISMATCH",
        severity: "block",
        message: "The implementation exposes a planned condition order that does not put the locked baseline first.",
        evidence: `first=${declaredMarkerOrder[0]}; baseline=${baselineMarker}`
      });
    }
  }

  const requiredConditionCount = normalizePositiveInteger(input.contract.required_condition_count);
  if (requiredConditionCount !== undefined) {
    const declaredConditionCount = extractDeclaredConditionCount(implementationSignal, requiredMarkers);
    if (declaredConditionCount !== undefined && declaredConditionCount < requiredConditionCount) {
      findings.push({
        code: "PLANNED_CONDITION_COUNT_CONTRACTED",
        severity: "block",
        message: "The implementation declares fewer conditions than the approved design contract.",
        evidence: `declared=${declaredConditionCount}; required=${requiredConditionCount}`
      });
    }
    if (declaredConditionCount !== undefined && declaredConditionCount > requiredConditionCount) {
      findings.push({
        code: "PLANNED_CONDITION_COUNT_EXPANDED",
        severity: "block",
        message: "The implementation declares more conditions than the approved design contract.",
        evidence: `declared=${declaredConditionCount}; required=${requiredConditionCount}`
      });
    }
    const publicMarkerCount = requiredMarkers.filter((marker) => hasMarkerSignal(publicSignal, marker)).length;
    const requiredPublicMarkerCount =
      requiredMarkers.length >= requiredConditionCount ? requiredConditionCount : requiredMarkers.length;
    if (publicMarkerCount > 0 && publicMarkerCount < requiredPublicMarkerCount) {
      findings.push({
        code: "PUBLIC_CONDITION_MARKERS_CONTRACTED",
        severity: "block",
        message: "Published implementation docs expose fewer planned condition markers than the approved design contract.",
        evidence: `public_markers=${publicMarkerCount}; required=${requiredPublicMarkerCount}`
      });
    }
  }

  const seedSchedule = (input.contract.seed_schedule || [])
    .map((seed) => normalizePositiveInteger(seed))
    .filter((seed): seed is number => seed !== undefined);
  if (seedSchedule.length > 1) {
    const missingSeeds = seedSchedule.filter((seed) => !hasNumberSignal(implementationSignal, seed));
    if (missingSeeds.length > 0) {
      findings.push({
        code: "PLANNED_SEED_SCHEDULE_MISSING",
        severity: "block",
        message: "The implementation surface does not preserve the planned repeated-seed schedule.",
        evidence: `missing=${missingSeeds.join(", ")}; required=${seedSchedule.join(", ")}`
      });
    }
  }

  const requiredRunCount = normalizePositiveInteger(input.contract.required_run_count);
  if (requiredRunCount !== undefined) {
    const declaredRunCount = extractDeclaredRunCount(implementationSignal);
    const inferredRunCount =
      requiredMarkers.length > 0 && seedSchedule.length > 0 ? requiredMarkers.length * seedSchedule.length : undefined;
    const bestVisibleRunCount = Math.max(declaredRunCount || 0, inferredRunCount || 0) || undefined;
    if (bestVisibleRunCount !== undefined && bestVisibleRunCount < requiredRunCount) {
      findings.push({
        code: "PLANNED_RUN_COUNT_CONTRACTED",
        severity: "block",
        message: "The implementation exposes fewer condition-by-seed runs than the approved design contract.",
        evidence: `visible=${bestVisibleRunCount}; required=${requiredRunCount}`
      });
    }
    const publicRunCounts = extractDeclaredRunCounts(publicSignal);
    const contractedPublicRunCounts = publicRunCounts.filter((count) => count < requiredRunCount);
    if (contractedPublicRunCounts.length > 0) {
      findings.push({
        code: "PUBLIC_RUN_COUNT_CONTRACTED",
        severity: "block",
        message: "Published implementation docs declare fewer runs than the approved design contract.",
        evidence: `public_declared=${Math.max(...contractedPublicRunCounts)}; required=${requiredRunCount}`
      });
    }

    const missingPerRunHelperEvidence = findMissingPerRunExecutionHelperEvidence(input.scriptText);
    if (missingPerRunHelperEvidence) {
      findings.push({
        code: "PLANNED_PER_RUN_EXECUTION_HELPER_MISSING",
        severity: "block",
        message:
          "The implementation declares the planned condition-by-seed schedule but its runner resolver cannot call any concrete per-run execution helper.",
        evidence: `${missingPerRunHelperEvidence}; required_runs=${requiredRunCount}`
      });
    }

    const undefinedPerRunDependencyEvidence = findPerRunHelperUndefinedDependencyEvidence(input.scriptText);
    if (undefinedPerRunDependencyEvidence) {
      findings.push({
        code: "PLANNED_PER_RUN_HELPER_UNDEFINED_DEPENDENCY",
        severity: "block",
        message:
          "The implementation exposes a per-run helper, but that helper calls a concrete train/evaluate/model hook that is neither defined nor imported.",
        evidence: `${undefinedPerRunDependencyEvidence}; py_compile_sufficient=false; required_runs=${requiredRunCount}`
      });
    }

    const loaderPathDefaultsEvidence = findEntrypointLoaderPathDefaultsAfterDataLoaderEvidence(input.scriptText);
    if (loaderPathDefaultsEvidence) {
      findings.push({
        code: "PLANNED_ENTRYPOINT_LOADER_PATH_DEFAULTS_AFTER_DATA_LOADER",
        severity: "block",
        message:
          "The implementation materializes its data bundle before defaulting runtime path aliases needed by generated loaders.",
        evidence: `${loaderPathDefaultsEvidence}; py_compile_sufficient=false; required_runs=${requiredRunCount}`
      });
    }

    const incompatibleRuntimeEntrypointEvidence = findRuntimeEntrypointMissingArgsKwargEvidence(input.scriptText);
    if (incompatibleRuntimeEntrypointEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_ENTRYPOINT_ARGS_INCOMPATIBLE",
        severity: "block",
        message:
          "The implementation exposes a study entrypoint that run_experiments can call with args=, but the function signature cannot accept that keyword.",
        evidence: incompatibleRuntimeEntrypointEvidence
      });
    }

    const missingCliInvocationEvidence = findMissingCliEntrypointInvocationEvidence(
      input.scriptText,
      input.runCommand
    );
    if (missingCliInvocationEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_CLI_ENTRYPOINT_NOT_INVOKED",
        severity: "block",
        message:
          "The implementation defines a planned study runner but the Python CLI surface will not invoke it when run_experiments executes the script.",
        evidence: missingCliInvocationEvidence
      });
    }

    const earlyMainGuardEvidence = findEarlyMainGuardBeforeGovernedScheduleEvidence(
      input.scriptText,
      input.runCommand
    );
    if (earlyMainGuardEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_EARLY_MAIN_GUARD",
        severity: "block",
        message:
          "The Python CLI main guard appears before the governed schedule contract is fully declared, so run_experiments can execute before the condition plan exists.",
        evidence: earlyMainGuardEvidence
      });
    }

    const unresolvedDefaultFactoryEvidence = findUnresolvedDefaultFactoryBeforeDefinitionEvidence(
      input.scriptText,
      input.runCommand
    );
    if (unresolvedDefaultFactoryEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_DEFAULT_FACTORY_UNRESOLVED",
        severity: "block",
        message:
          "The Python runtime surface uses a dataclass field default_factory before that factory is defined, so the class body can fail before run_experiments starts.",
        evidence: unresolvedDefaultFactoryEvidence
      });
    }

    const missingEntrypointStageHelperEvidence = findMissingEntrypointStageHelperEvidence(
      input.scriptText,
      input.runCommand
    );
    if (missingEntrypointStageHelperEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_ENTRYPOINT_STAGE_HELPER_MISSING",
        severity: "block",
        message:
          "The Python entrypoint dispatches to a required runtime stage helper, but none of the advertised helper candidates are defined.",
        evidence: `${missingEntrypointStageHelperEvidence}; required_runs=${requiredRunCount}`
      });
    }

    const missingCallableResolverEvidence = findMissingGenericCallableResolverEvidence(
      input.scriptText,
      input.runCommand
    );
    if (missingCallableResolverEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_CALLABLE_RESOLVER_TARGET_MISSING",
        severity: "block",
        message:
          "The Python entrypoint resolves a required callable from advertised candidates, but none of those candidates are defined.",
        evidence: `${missingCallableResolverEvidence}; required_runs=${requiredRunCount}`
      });
    }

    const unsafeArgparseDefaultEvidence = findUnsafeArgparseEmptyNumericDefaultEvidence(
      input.scriptText,
      input.runCommand
    );
    if (unsafeArgparseDefaultEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_ARGPARSE_EMPTY_NUMERIC_DEFAULT",
        severity: "block",
        message:
          "The Python CLI parser can fail before execution because a numeric argparse default is wired to an empty environment-derived string.",
        evidence: `${unsafeArgparseDefaultEvidence}; required_runs=${requiredRunCount}`
      });
    }

    const unresolvedRuntimeGuardEvidence = findUnresolvedRuntimeGuardEvidence(input.scriptText);
    if (unresolvedRuntimeGuardEvidence) {
      findings.push({
        code: "PLANNED_RUNTIME_EXECUTION_GUARD_UNRESOLVED",
        severity: "block",
        message:
          "The implementation still exposes an unresolved runtime guard where the planned study execution loop should be.",
        evidence: unresolvedRuntimeGuardEvidence
      });
    }

    const lockedConditionResolverMismatchEvidence = findLockedConditionResolverMismatchEvidence(
      input.scriptText,
      requiredMarkers
    );
    if (lockedConditionResolverMismatchEvidence) {
      findings.push({
        code: "PLANNED_LOCKED_CONDITION_RESOLVER_MISMATCH",
        severity: "block",
        message:
          "The implementation declares the locked condition catalog, but its runtime resolver cannot discover that catalog and can collapse to zero conditions.",
        evidence: lockedConditionResolverMismatchEvidence
      });
    }
  }

  const minimumEvalExamples = Object.values(input.contract.minimum_eval_examples_per_task || {})
    .map((value) => normalizePositiveInteger(value))
    .filter((value): value is number => value !== undefined);
  const requiredEvalMinimum =
    input.contract.full_evaluation_required && minimumEvalExamples.length > 0
      ? Math.max(...minimumEvalExamples)
      : undefined;
  if (requiredEvalMinimum !== undefined) {
    const declaredEvalLimits = extractDeclaredEvaluationLimits(implementationSignal);
    const contractedEvalLimits = declaredEvalLimits.filter((limit) => limit > 0 && limit < requiredEvalMinimum);
    if (contractedEvalLimits.length > 0) {
      findings.push({
        code: "PLANNED_FULL_EVAL_CONTRACTED",
        severity: "block",
        message: "The implementation exposes a hard evaluation-example cap below the approved full-validation contract.",
        evidence: `declared_cap=${Math.min(...contractedEvalLimits)}; required_minimum=${requiredEvalMinimum}`
      });
    }
  }

  return findings;
}

const PER_RUN_EXECUTION_HELPER_NAMES = [
  "run_condition_seed",
  "run_condition_seed_experiment",
  "run_single_condition_seed_experiment",
  "execute_condition_seed_run",
  "execute_single_run",
  "run_single_study_cell",
  "run_single_condition_seed",
  "train_and_evaluate_condition",
  "run_one_condition",
  "run_condition_experiment",
  "run_single_condition",
  "execute_condition",
  "execute_training_condition"
];

const PUBLIC_STUDY_ENTRYPOINT_PATTERN =
  /^(?:run|execute|orchestrate)_[A-Za-z0-9_]*(?:study|experiment|workflow|orchestration|pipeline|matrix|schedule|conditions)$/u;

function findRuntimeEntrypointMissingArgsKwargEvidence(scriptText: string): string | undefined {
  if (!scriptText) {
    return undefined;
  }
  for (const signature of extractPublicStudyEntrypointSignatures(scriptText)) {
    if (pythonSignatureAcceptsKeyword(signature.parameters, "args")) {
      continue;
    }
    return `entrypoint=${signature.name}; line=${signature.line}; signature=${signature.name}(${signature.parameters.trim()})`;
  }
  return undefined;
}

function extractPublicStudyEntrypointSignatures(
  scriptText: string
): Array<{ name: string; parameters: string; line: number }> {
  const signatures: Array<{ name: string; parameters: string; line: number }> = [];
  for (const match of scriptText.matchAll(
    /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(?:->\s*[^:\n]+)?\s*:/gmu
  )) {
    const name = match[1] || "";
    if (!PUBLIC_STUDY_ENTRYPOINT_PATTERN.test(name) || PER_RUN_EXECUTION_HELPER_NAMES.includes(name)) {
      continue;
    }
    signatures.push({
      name,
      parameters: match[2] || "",
      line: scriptText.slice(0, match.index).split(/\r?\n/u).length
    });
  }
  return signatures;
}

function pythonSignatureAcceptsKeyword(parameters: string, keyword: string): boolean {
  return splitPythonParameterList(parameters).some((parameter) => {
    const trimmed = parameter.trim();
    if (trimmed.startsWith("**")) {
      return true;
    }
    const bareName = trimmed
      .replace(/^\*/u, "")
      .split("=")[0]
      .split(":")[0]
      ?.trim();
    return bareName === keyword;
  });
}

function splitPythonParameterList(parameters: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < parameters.length; index += 1) {
    const char = parameters[index] || "";
    const previous = parameters[index - 1] || "";
    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if ((char === ")" || char === "]" || char === "}") && depth > 0) {
      depth -= 1;
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts;
}

function findMissingCliEntrypointInvocationEvidence(scriptText: string, runCommand: string): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  const hasMainGuard = /\n\s*if\s+__name__\s*==\s*["']__main__["']\s*:/u.test(`\n${scriptText}`);
  if (hasMainGuard) {
    return undefined;
  }
  const callableEntrypoints = extractPublicStudyEntrypointSignatures(scriptText)
    .map((signature) => `${signature.name}:${signature.line}`)
    .slice(0, 8);
  const hasParserSurface =
    /\n\s*def\s+(?:parse_args|parse_cli_args|build_arg_parser)\s*\(/u.test(`\n${scriptText}`) ||
    /--metrics-path/u.test(scriptText);
  const commandPassesRuntimeFlags = /--(?:metrics-path|metrics-out|output-dir|results-dir|cache-dir)\b/u.test(runCommand);
  if (callableEntrypoints.length === 0 || (!hasParserSurface && !commandPassesRuntimeFlags)) {
    return undefined;
  }
  return `run_command_executes_python_script=true; main_guard=missing; entrypoints=${callableEntrypoints.join(", ") || "none"}; cli_surface=${hasParserSurface ? "present" : "not_detected"}; command_runtime_flags=${commandPassesRuntimeFlags ? "present" : "not_detected"}`;
}

function findEarlyMainGuardBeforeGovernedScheduleEvidence(
  scriptText: string,
  runCommand: string
): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  const guardMatch = /\n\s*if\s+__name__\s*==\s*["']__main__["']\s*:/u.exec(`\n${scriptText}`);
  if (!guardMatch || guardMatch.index === undefined) {
    return undefined;
  }
  const guardIndex = Math.max(0, guardMatch.index - 1);
  const scheduleSignals = [
    "PLANNED_CONDITION_MARKERS",
    "REQUIRED_CONDITION_MARKERS",
    "REQUIRED_CONDITION_COUNT",
    "REQUIRED_RUN_COUNT",
    "SEED_SCHEDULE"
  ];
  const lateSignals = scheduleSignals
    .map((signal) => ({ signal, index: scriptText.indexOf(signal, guardIndex + 1) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  if (lateSignals.length === 0) {
    return undefined;
  }
  const firstLateSignal = lateSignals[0];
  return [
    `main_guard_line=${lineNumberAtIndex(scriptText, guardIndex)}`,
    `late_schedule_signal=${firstLateSignal.signal}`,
    `late_schedule_line=${lineNumberAtIndex(scriptText, firstLateSignal.index)}`
  ].join("; ");
}

function lineNumberAtIndex(text: string, index: number): number {
  if (index <= 0) {
    return 1;
  }
  return text.slice(0, index).split("\n").length;
}

function findUnresolvedDefaultFactoryBeforeDefinitionEvidence(
  scriptText: string,
  runCommand: string
): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  const builtinFactories = new Set([
    "bytearray",
    "bytes",
    "dict",
    "float",
    "frozenset",
    "int",
    "list",
    "set",
    "str",
    "tuple"
  ]);
  for (const match of scriptText.matchAll(/\bfield\s*\([^)]*\bdefault_factory\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b(?!\s*\.)/gu)) {
    const factoryName = match[1] || "";
    if (!factoryName || builtinFactories.has(factoryName)) {
      continue;
    }
    const matchIndex = match.index || 0;
    const prefix = scriptText.slice(0, matchIndex);
    if (hasPythonCallableDefinitionSignal(prefix, factoryName)) {
      continue;
    }
    return [
      `default_factory=${factoryName}`,
      `field_line=${lineNumberAtIndex(scriptText, matchIndex)}`,
      "definition=missing_before_field"
    ].join("; ");
  }
  return undefined;
}

function findMissingEntrypointStageHelperEvidence(scriptText: string, runCommand: string): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  const hasStageDispatchSurface =
    /Missing required\s+\{?stage_name\}?\s+helper;\s*tried/iu.test(scriptText) ||
    /\bentrypoint_call_stage\s*\(/iu.test(scriptText);
  if (!hasStageDispatchSurface) {
    return undefined;
  }
  const dispatchWindows = extractEntrypointStageDispatchWindows(scriptText);
  for (const windowText of dispatchWindows) {
    const candidates = extractPythonStringLiterals(windowText)
      .filter((literal) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(literal))
      .filter((literal) => literal.includes("_"))
      .filter((literal) => !/^(?:__main__|metrics_path|output_dir|run_id)$/u.test(literal));
    const uniqueCandidates = dedupeStrings(candidates);
    if (uniqueCandidates.length === 0) {
      continue;
    }
    const missingCandidates = uniqueCandidates.filter((name) => !hasPythonCallableDefinitionSignal(scriptText, name));
    if (missingCandidates.length === uniqueCandidates.length) {
      return `missing_stage_helper_candidates=${uniqueCandidates.slice(0, 10).join(", ")}`;
    }
  }
  return undefined;
}

function extractEntrypointStageDispatchWindows(scriptText: string): string[] {
  const windows: string[] = [];
  for (const match of scriptText.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*entrypoint_call_stage\s*\(/giu)) {
    const start = match.index || 0;
    const nextDispatch = /\b[A-Za-z_][A-Za-z0-9_]*entrypoint_call_stage\s*\(/giu.exec(scriptText.slice(start + 1));
    const maxEnd = nextDispatch?.index !== undefined
      ? start + 1 + nextDispatch.index
      : Math.min(scriptText.length, start + 1800);
    windows.push(scriptText.slice(start, maxEnd));
  }
  if (windows.length === 0 && /Missing required\s+\{?stage_name\}?\s+helper;\s*tried/iu.test(scriptText)) {
    windows.push(scriptText);
  }
  return windows;
}

function findMissingGenericCallableResolverEvidence(scriptText: string, runCommand: string): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  const resolverWindows = extractGenericCallableResolverWindows(scriptText);
  for (const windowText of resolverWindows) {
    const candidates = extractPythonStringLiterals(windowText)
      .filter((literal) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(literal))
      .filter((literal) => literal.includes("_"))
      .filter((literal) => !/^(?:__main__|args|available|candidate_names|purpose)$/u.test(literal));
    const purpose =
      extractGenericCallableResolverPurpose(windowText) ||
      (/\bruntime\s+context\s+resolution\b/iu.test(windowText) ? "runtime context resolution" : "required callable");
    const uniqueCandidates = dedupeStrings(candidates);
    if (uniqueCandidates.length === 0) {
      continue;
    }
    const missingCandidates = uniqueCandidates.filter((name) => !hasPythonCallableDefinitionSignal(scriptText, name));
    if (missingCandidates.length === uniqueCandidates.length) {
      return [
        `purpose=${purpose}`,
        `missing_callable_candidates=${uniqueCandidates.slice(0, 10).join(", ")}`
      ].join("; ");
    }
  }
  return undefined;
}

function extractGenericCallableResolverWindows(scriptText: string): string[] {
  const windows: string[] = [];
  const resolverPatterns = [
    /\b[A-Za-z_][A-Za-z0-9_]*lookup_callable\s*\(/giu,
    /\b[A-Za-z_][A-Za-z0-9_]*resolve_callable\s*\(/giu,
    /\b[A-Za-z_][A-Za-z0-9_]*resolve_orchestration_helper\s*\(/giu,
    /\b[A-Za-z_][A-Za-z0-9_]*entry_call\s*\(/giu
  ];
  for (const pattern of resolverPatterns) {
    for (const match of scriptText.matchAll(pattern)) {
      const start = match.index || 0;
      windows.push(scriptText.slice(start, Math.min(scriptText.length, start + 1600)));
    }
  }
  if (/(?:No callable found for|No orchestration helper found for|No compatible orchestration helper found)\b/iu.test(scriptText)) {
    const failureMatch = /(?:No callable found for|No orchestration helper found for|No compatible orchestration helper found)\b/iu.exec(scriptText);
    if (failureMatch?.index !== undefined) {
      const start = Math.max(0, failureMatch.index - 1600);
      windows.push(scriptText.slice(start, Math.min(scriptText.length, failureMatch.index + 1600)));
    }
  }
  return windows;
}

function extractGenericCallableResolverPurpose(windowText: string): string | undefined {
  const purposeMatch =
    /\b[A-Za-z_][A-Za-z0-9_]*resolve_orchestration_helper\s*\(\s*["']([^"']{3,80})["']/iu.exec(windowText) ||
    /purpose\s*=\s*["']([^"']{3,80})["']/iu.exec(windowText) ||
    /,\s*["']([^"']{3,80})["']\s*\)/u.exec(windowText);
  return purposeMatch?.[1]?.replace(/\s+/gu, " ").trim();
}

function findUnsafeArgparseEmptyNumericDefaultEvidence(scriptText: string, runCommand: string): string | undefined {
  if (!scriptText || !runCommandExecutesPythonScript(runCommand)) {
    return undefined;
  }
  if (!/\bargparse\b/u.test(scriptText) || !/\badd_argument\s*\(/u.test(scriptText)) {
    return undefined;
  }
  const emptyEnvDefaultNames = extractEmptyEnvDefaultConstantNames(scriptText);
  if (emptyEnvDefaultNames.length === 0) {
    return undefined;
  }
  const unsafeDefaultNames = new Set(emptyEnvDefaultNames);
  for (const helperMatch of scriptText.matchAll(
    /\b(?:_env_optional_int|_env_int|_env_optional_float|_env_float)\s*\([^)]*\b([A-Z][A-Z0-9_]{2,})\b\s*\)/gu
  )) {
    const constantName = helperMatch[1] || "";
    if (unsafeDefaultNames.has(constantName)) {
      unsafeDefaultNames.add(helperMatch[0] || "");
    }
  }
  const singleLineEvidence = findUnsafeArgparseEmptyNumericDefaultLineEvidence(scriptText, emptyEnvDefaultNames);
  if (singleLineEvidence) {
    return singleLineEvidence;
  }
  for (const match of scriptText.matchAll(/\badd_argument\s*\(([\s\S]*?)\)/gu)) {
    const callText = match[1] || "";
    if (!/\btype\s*=\s*(?:int|float)\b/u.test(callText)) {
      continue;
    }
    const defaultMatch = /\bdefault\s*=\s*([^,\n)]+)/u.exec(callText);
    const defaultExpr = defaultMatch?.[1]?.trim() || "";
    if (!defaultExpr) {
      continue;
    }
    const referencedEmptyDefault = emptyEnvDefaultNames.find((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "u").test(defaultExpr));
    if (!referencedEmptyDefault) {
      continue;
    }
    const flag = extractPythonStringLiterals(callText).find((literal) => literal.startsWith("--")) || "numeric_flag";
    return [
      `flag=${flag}`,
      `empty_default=${referencedEmptyDefault}`,
      `line=${lineNumberAtIndex(scriptText, match.index || 0)}`
    ].join("; ");
  }
  return undefined;
}

function findUnsafeArgparseEmptyNumericDefaultLineEvidence(
  scriptText: string,
  emptyEnvDefaultNames: string[]
): string | undefined {
  const lines = scriptText.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (!/\badd_argument\s*\(/u.test(line) || !/\btype\s*=\s*(?:int|float)\b/u.test(line)) {
      continue;
    }
    const referencedEmptyDefault = emptyEnvDefaultNames.find((name) =>
      new RegExp(`\\b${escapeRegExp(name)}\\b`, "u").test(line)
    );
    if (!referencedEmptyDefault) {
      continue;
    }
    const flagMatch = /["'](--[a-z0-9][a-z0-9_-]*)["']/iu.exec(line);
    return [
      `flag=${flagMatch?.[1] || "numeric_flag"}`,
      `empty_default=${referencedEmptyDefault}`,
      `line=${index + 1}`
    ].join("; ");
  }
  return undefined;
}

function extractEmptyEnvDefaultConstantNames(scriptText: string): string[] {
  const names: string[] = [];
  const pattern =
    /^\s*([A-Z][A-Z0-9_]{2,})\s*=\s*(?:os\.)?environ\.get\([^\n,]+,\s*["']{2}\s*\)\s*(?:\.strip\(\))?/gmu;
  for (const match of scriptText.matchAll(pattern)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return dedupeStrings(names);
}

function runCommandExecutesPythonScript(runCommand: string): boolean {
  return /(?:^|\s)(?:python3?|python)\b[\s\S]*?\.py(?:["\\']|\s|$)/u.test(runCommand);
}

function findUnresolvedRuntimeGuardEvidence(scriptText: string): string | undefined {
  if (!scriptText) {
    return undefined;
  }
  const guardPatterns = [
    {
      label: "missing_locked_study_execution_helper",
      pattern: /No locked study execution helper is available/iu
    },
    {
      label: "missing_study_sweep_controller",
      pattern: /Unable to resolve the study sweep controller from module globals/iu
    },
    {
      label: "chunk_placeholder_reference",
      pattern: /expected chunk_[A-Za-z0-9_]+/iu
    }
  ];
  const hits = guardPatterns
    .filter((entry) => entry.pattern.test(scriptText))
    .map((entry) => entry.label);
  return hits.length > 0 ? `runtime_guard=${hits.join(", ")}` : undefined;
}

function findLockedConditionResolverMismatchEvidence(scriptText: string, requiredMarkers: string[]): string | undefined {
  if (!scriptText || !/No locked conditions are available to select from/iu.test(scriptText)) {
    return undefined;
  }
  const resolverBody =
    extractTopLevelPythonFunctionBlock(scriptText, "_get_locked_condition_specs") ||
    extractTopLevelPythonFunctionBlock(scriptText, "get_locked_condition_specs") ||
    extractTopLevelPythonFunctionBlock(scriptText, "_resolve_locked_condition_specs") ||
    extractTopLevelPythonFunctionBlock(scriptText, "resolve_locked_condition_specs");
  if (!resolverBody) {
    return undefined;
  }
  const visibleCatalogNames = [
    "LOCKED_CONDITION_SPECS",
    "STUDY_CONDITION_SPECS",
    "REQUIRED_CONDITION_SPECS",
    "PLANNED_CONDITION_SPECS"
  ].filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "u").test(scriptText));
  if (visibleCatalogNames.length === 0) {
    return undefined;
  }
  const resolverLiterals = new Set(extractPythonStringLiterals(resolverBody));
  const missingCatalogNames = visibleCatalogNames.filter((name) => !resolverLiterals.has(name));
  if (missingCatalogNames.length === 0) {
    return undefined;
  }
  const expectedMarkersVisible = requiredMarkers.filter((marker) => hasMarkerSignal(scriptText, marker)).length;
  if (expectedMarkersVisible === 0) {
    return undefined;
  }
  const resolverNames = [...resolverLiterals].filter((literal) => /(?:CONDITION|CONDITIONS|SCHEDULE|SPECS)/u.test(literal));
  return `declared_catalog=${visibleCatalogNames.join(", ")}; resolver_candidates=${resolverNames.join(", ") || "none"}; missing_from_resolver=${missingCatalogNames.join(", ")}`;
}

function extractTopLevelPythonFunctionBlock(scriptText: string, functionName: string): string | undefined {
  const escaped = escapeRegExp(functionName);
  const match = new RegExp(`^\\s*def\\s+${escaped}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:\\n]+)?\\s*:`, "mu").exec(scriptText);
  if (!match) {
    return undefined;
  }
  const start = match.index;
  const rest = scriptText.slice(start + match[0].length);
  const nextTopLevel = /\n(?=\S)/u.exec(rest);
  return nextTopLevel ? scriptText.slice(start, start + match[0].length + nextTopLevel.index) : scriptText.slice(start);
}

function extractTopLevelPythonFunctionBlocks(
  scriptText: string,
  functionName: string
): Array<{ block: string; line: number }> {
  const escaped = escapeRegExp(functionName);
  const blocks: Array<{ block: string; line: number }> = [];
  for (const match of scriptText.matchAll(
    new RegExp(`^\\s*def\\s+${escaped}\\s*\\([^)]*\\)\\s*(?:->\\s*[^:\\n]+)?\\s*:`, "gmu")
  )) {
    const start = match.index || 0;
    const rest = scriptText.slice(start + match[0].length);
    const nextTopLevel = /\n(?=\S)/u.exec(rest);
    const end = nextTopLevel ? start + match[0].length + nextTopLevel.index : scriptText.length;
    blocks.push({
      block: scriptText.slice(start, end),
      line: lineNumberAtIndex(scriptText, start)
    });
  }
  return blocks;
}

function findEntrypointLoaderPathDefaultsAfterDataLoaderEvidence(scriptText: string): string | undefined {
  if (!scriptText) {
    return undefined;
  }
  for (const { block, line } of extractTopLevelPythonFunctionBlocks(scriptText, "_autolabos_entrypoint_run")) {
    const loaderIndex = block.indexOf("_autolabos_entrypoint_loaded_data(config)");
    const pathAliasIndex = block.indexOf("for _autolabos_paths_alias in ('paths', 'output_paths', 'artifact_paths'");
    if (loaderIndex < 0 || pathAliasIndex < 0 || loaderIndex > pathAliasIndex) {
      continue;
    }
    if (!/\bload_task_bundle\s*\(/u.test(scriptText) && !/\bartifact_paths\b/u.test(scriptText)) {
      continue;
    }
    return `entrypoint=_autolabos_entrypoint_run; line=${line}; loader_before_path_alias=true; missing_alias=artifact_paths`;
  }
  return undefined;
}

function findMissingPerRunExecutionHelperEvidence(scriptText: string): string | undefined {
  if (!scriptText) {
    return undefined;
  }
  const hasPerRunResolverFailure =
    /No callable per-run execution helper was found/iu.test(scriptText) ||
    /Unable to locate a runnable execution helper/iu.test(scriptText) ||
    /No (?:condition[-\s]?seed|per[-\s]?run|condition) (?:execution )?helper (?:was )?found/iu.test(scriptText);
  if (!hasPerRunResolverFailure) {
    return undefined;
  }
  const referencedHelpers = extractPerRunResolverCandidateNames(scriptText);
  const candidateNames = referencedHelpers.length > 0
    ? referencedHelpers
    : PER_RUN_EXECUTION_HELPER_NAMES;
  const missingCandidates = candidateNames.filter((name) => !hasPythonCallableDefinitionSignal(scriptText, name));
  if (missingCandidates.length < candidateNames.length) {
    return undefined;
  }
  const renderedCandidates = candidateNames.slice(0, 10).join(", ");
  return `missing_callable_candidates=${renderedCandidates}`;
}

function findPerRunHelperUndefinedDependencyEvidence(scriptText: string): string | undefined {
  if (!scriptText) {
    return undefined;
  }
  const missingDependencies: Array<{ helperName: string; dependencyName: string; line: number }> = [];
  for (const helperName of PER_RUN_EXECUTION_HELPER_NAMES) {
    const block = extractTopLevelPythonFunctionBlock(scriptText, helperName);
    if (!block) {
      continue;
    }
    const blockStart = scriptText.indexOf(block);
    for (const match of block.matchAll(/\b((?:execute|run|train|evaluate)_[A-Za-z0-9_]*(?:condition|model|state|evaluation|training)[A-Za-z0-9_]*)\s*\(/gu)) {
      const dependencyName = match[1] || "";
      if (!dependencyName || dependencyName === helperName) {
        continue;
      }
      if (hasPythonCallableDefinitionSignal(scriptText, dependencyName)) {
        continue;
      }
      missingDependencies.push({
        helperName,
        dependencyName,
        line: lineNumberAtIndex(scriptText, blockStart + (match.index || 0))
      });
    }
  }
  const first = missingDependencies[0];
  if (!first) {
    return undefined;
  }
  return [
    `helper=${first.helperName}`,
    `missing_dependency=${first.dependencyName}`,
    `line=${first.line}`
  ].join("; ");
}

function extractPerRunResolverCandidateNames(scriptText: string): string[] {
  const names: string[] = [];
  const failureMatches = [
    ...scriptText.matchAll(/No callable per-run execution helper was found/giu),
    ...scriptText.matchAll(/Unable to locate a runnable execution helper/giu),
    ...scriptText.matchAll(/No (?:condition[-\s]?seed|per[-\s]?run|condition) (?:execution )?helper (?:was )?found/giu)
  ];
  for (const match of failureMatches) {
    const start = Math.max(0, (match.index || 0) - 1600);
    const windowText = scriptText.slice(start, match.index || 0);
    for (const literal of extractPythonStringLiterals(windowText)) {
      if (PER_RUN_EXECUTION_HELPER_NAMES.includes(literal) || /(?:run|execute|train).*condition|condition.*seed/iu.test(literal)) {
        names.push(literal);
      }
    }
  }
  return dedupeStrings(names);
}

function extractPythonStringLiterals(text: string): string[] {
  const literals: string[] = [];
  for (const match of text.matchAll(/["']([A-Za-z_][A-Za-z0-9_]*)["']/gu)) {
    if (match[1]) {
      literals.push(match[1]);
    }
  }
  return literals;
}

function hasPythonCallableDefinitionSignal(scriptText: string, name: string): boolean {
  const escaped = escapeRegExp(name);
  const patterns = [
    new RegExp(`^\\s*(?:async\\s+)?def\\s+${escaped}\\s*\\(`, "mu"),
    new RegExp(`^\\s*class\\s+${escaped}\\s*\\(`, "mu"),
    new RegExp(`^\\s*${escaped}\\s*=\\s*(?:lambda\\b|functools\\.partial\\b|partial\\b)`, "mu"),
    new RegExp(`^\\s*from\\s+[A-Za-z0-9_.]+\\s+import\\s+(?:[^\\n#]*,\\s*)?${escaped}(?:\\s*,|\\s+as\\s+|\\s*(?:#.*)?$)`, "mu")
  ];
  return patterns.some((pattern) => pattern.test(scriptText));
}

function hasMarkerSignal(text: string, marker: string): boolean {
  const escaped = escapeRegExp(marker);
  const flexible = escaped.replace(/_/gu, "[_\\s.-]*");
  return new RegExp(`(?:^|[^A-Za-z0-9])${flexible}(?:$|[^A-Za-z0-9])`, "iu").test(text);
}

function findBaselineMarkerMissingFromDeclaredConditionCatalogEvidence(
  scriptText: string,
  baselineMarker: string
): string | undefined {
  if (!scriptText || !baselineMarker) {
    return undefined;
  }
  const indexesBaselineMap = /\b(?:[A-Z][A-Z0-9_]*_)?CONDITION(?:S)?_BY_MARKER\s*\[\s*BASELINE_[A-Z0-9_]*MARKER\s*\]/u.test(
    scriptText
  );
  if (!indexesBaselineMap) {
    return undefined;
  }
  const literalCatalogMarkers = extractDeclaredLiteralConditionCatalogMarkers(scriptText);
  if (literalCatalogMarkers.length > 0 && !literalCatalogMarkers.includes(baselineMarker)) {
    return `baseline=${baselineMarker}; declared_markers=${literalCatalogMarkers.slice(0, 12).join(", ")}`;
  }
  const inferredCatalogMarkers = extractInferredParameterizedConditionGridMarkers(scriptText);
  if (inferredCatalogMarkers.length > 0 && !inferredCatalogMarkers.includes(baselineMarker)) {
    return `baseline=${baselineMarker}; inferred_markers=${inferredCatalogMarkers.slice(0, 12).join(", ")}`;
  }
  return undefined;
}

function extractDeclaredLiteralConditionCatalogMarkers(scriptText: string): string[] {
  const catalogPatterns = [
    /\b(?:REQUIRED|PLANNED|LOCKED|STUDY)?_?CONDITION_MARKERS\b\s*=\s*(?:\(|\[)([\s\S]*?)(?:\)|\])/gu,
    /\b(?:REQUIRED|PLANNED|LOCKED|STUDY)?_?CONDITION_ORDER\b\s*=\s*(?:\(|\[)([\s\S]*?)(?:\)|\])/gu
  ];
  const markers: string[] = [];
  for (const pattern of catalogPatterns) {
    for (const match of scriptText.matchAll(pattern)) {
      markers.push(...extractPythonStringLiterals(match[1] || "").filter((literal) => /condition|baseline|candidate/iu.test(literal)));
    }
  }
  return dedupeStrings(markers);
}

function extractInferredParameterizedConditionGridMarkers(scriptText: string): string[] {
  if (!/\bf\s*["']condition_\{[^"']+\}_parameter_\{[^"']+\}["']/u.test(scriptText)) {
    return [];
  }
  if (!/\.rstrip\(\s*["']0["']\s*\)\.rstrip\(\s*["']\.["']\s*\)/u.test(scriptText)) {
    return [];
  }
  const gridMatch = /\b[A-Z][A-Z0-9_]*CONDITION_GRID\b\s*=\s*\(([\s\S]*?)\n\s*\)/u.exec(scriptText);
  if (!gridMatch) {
    return [];
  }
  const markers: string[] = [];
  for (const pair of (gridMatch[1] || "").matchAll(/\(\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*\)/gu)) {
    const primary = pair[1] || "";
    const secondary = normalizeMarkerNumberText(pair[2] || "");
    if (primary && secondary) {
      markers.push(`condition_${primary}_parameter_${secondary.replace(/\./gu, "_")}`);
    }
  }
  return dedupeStrings(markers);
}

function stripAutoLabOSPlannedConditionContractBlock(text: string): string {
  return text.replace(
    /\n?# _autolabos_planned_condition_contract_marker_start\n[\s\S]*?# _autolabos_planned_condition_contract_marker_end\n?/gu,
    "\n"
  );
}

function normalizeMarkerNumberText(value: string): string {
  const normalized = value.replace(/0+$/u, "").replace(/\.$/u, "");
  return normalized.length > 0 ? normalized : "0";
}

function hasNumberSignal(text: string, value: number): boolean {
  return new RegExp(`(?:^|[^0-9])${escapeRegExp(String(value))}(?:$|[^0-9])`, "u").test(text);
}

function extractDeclaredConditionCount(text: string, requiredMarkers: string[]): number | undefined {
  const counts: number[] = [];
  for (const match of text.matchAll(
    /\b(?:required|planned|locked)?_?condition_?count\b\s*[:=]\s*(\d+)/giu
  )) {
    const parsed = normalizePositiveInteger(Number.parseInt(match[1] || "", 10));
    if (parsed !== undefined) {
      counts.push(parsed);
    }
  }
  if (requiredMarkers.length > 0) {
    const visibleMarkerCount = requiredMarkers.filter((marker) => hasMarkerSignal(text, marker)).length;
    if (visibleMarkerCount > 0) {
      counts.push(visibleMarkerCount);
    }
  }
  return counts.length > 0 ? Math.max(...counts) : undefined;
}

function extractDeclaredRunCount(text: string): number | undefined {
  const counts = extractDeclaredRunCounts(text);
  return counts.length > 0 ? Math.max(...counts) : undefined;
}

function extractDeclaredRunCounts(text: string): number[] {
  const counts: number[] = [];
  for (const match of text.matchAll(/\b(?:required|planned|total)?_?run_?count\b\s*[:=]\s*(\d+)/giu)) {
    const parsed = normalizePositiveInteger(Number.parseInt(match[1] || "", 10));
    if (parsed !== undefined) {
      counts.push(parsed);
    }
  }
  for (const match of text.matchAll(/\b(\d+)\s+total\s+runs?\b|\btotal\s+runs?\s*[:=]\s*(\d+)\b/giu)) {
    const parsed = normalizePositiveInteger(Number.parseInt(match[1] || match[2] || "", 10));
    if (parsed !== undefined) {
      counts.push(parsed);
    }
  }
  for (const match of text.matchAll(/\b(?:train\/eval|train[-\s]?eval|train[-\s]?and[-\s]?eval)\s+jobs?\b\s*[:=]\s*(\d+)/giu)) {
    const parsed = normalizePositiveInteger(Number.parseInt(match[1] || "", 10));
    if (parsed !== undefined) {
      counts.push(parsed);
    }
  }
  return counts;
}

function extractDeclaredEvaluationLimits(text: string): number[] {
  const limits: number[] = [];
  const patterns = [
    /\b(?:max_eval_examples_per_task|max_eval_samples_per_task|max_eval_examples|max_eval_samples|eval_examples_per_task|eval_samples_per_task)\b\s*[:=]\s*(\d+)/giu,
    /\b(?:max[-\s]?eval[-\s]?(?:examples|samples)(?:[-\s]?per[-\s]?task)?)\b\s*[:=]\s*(\d+)/giu
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const parsed = normalizePositiveInteger(Number.parseInt(match[1] || "", 10));
      if (parsed !== undefined) {
        limits.push(parsed);
      }
    }
  }
  return limits;
}

function extractDeclaredConditionMarkerOrder(text: string, requiredMarkers: string[]): string[] {
  const assignments = [
    ...text.matchAll(
      /\b(?:PLANNED_CONDITION_MARKERS|LOCKED_CONDITION_MARKERS|CONDITION_MARKERS|LOCKED_CONDITION_ORDER)\b\s*=\s*(?:\(|\[)([\s\S]*?)(?:\)|\])/gu
    )
  ];
  for (const assignment of assignments) {
    const body = assignment[1] || "";
    const markers = extractConditionMarkersFromText(body, requiredMarkers);
    if (markers.length > 0) {
      return markers;
    }
  }
  return extractConditionMarkersFromText(text, requiredMarkers);
}

function extractConditionMarkersFromText(text: string, requiredMarkers: string[]): string[] {
  const orderedRequiredMarkers = requiredMarkers
    .map((marker) => {
      const match = new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(marker).replace(/_/gu, "[_\\s.-]*")}(?:$|[^A-Za-z0-9])`, "iu").exec(text);
      return match ? { marker, index: match.index } : undefined;
    })
    .filter((entry): entry is { marker: string; index: number } => entry !== undefined)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.marker);
  if (orderedRequiredMarkers.length > 0) {
    return dedupeStrings(orderedRequiredMarkers);
  }
  return dedupeStrings(extractPythonStringLiterals(text).filter((literal) => /condition|baseline|candidate/iu.test(literal)));
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function safeReadText(filePath: string | undefined): Promise<string> {
  if (!filePath) {
    return "";
  }
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readImplementationSurfaceText(scriptPath: string | undefined): Promise<string> {
  const directText = await safeReadText(scriptPath);
  if (!scriptPath || !/\.sh$/iu.test(scriptPath) || !directText) {
    return directText;
  }
  const wrapperDir = path.dirname(scriptPath);
  const referencedPaths = extractCommandPaths(directText, wrapperDir)
    .filter((candidate) => !samePath(candidate, scriptPath) && isRunnableScript(candidate));
  const targetTexts: string[] = [];
  for (const referencedPath of referencedPaths) {
    const targetText = await safeReadText(referencedPath);
    if (targetText) {
      targetTexts.push(targetText);
    }
  }
  return [directText, ...targetTexts].join("\n");
}

async function readPublicContractSurfaceText(publicDir: string, publicArtifacts: string[]): Promise<string> {
  const artifactNames = new Set(publicArtifacts.map((artifactPath) => path.basename(artifactPath)));
  const candidateNames = [
    "README.md",
    "README_study_report.md",
    "bootstrap_contract.json",
    "locked_condition_contract.json",
    "experiment_plan.yaml",
    "study_spec.json"
  ].filter((name) => artifactNames.size === 0 || artifactNames.has(name));
  const candidatePaths = dedupeStrings(candidateNames.map((name) => path.join(publicDir, name)));
  const texts = await Promise.all(candidatePaths.map((candidatePath) => safeReadText(candidatePath)));
  return texts.filter(Boolean).join("\n");
}

function extractCommandPaths(command: string, cwd: string): string[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const paths = new Set<string>();
  for (const token of tokens) {
    const value = expandShellPathToken(normalizeShellPathToken(token), cwd);
    if (!value) {
      continue;
    }
    if (!looksLikePath(value)) {
      continue;
    }
    paths.add(path.normalize(path.isAbsolute(value) ? value : path.resolve(cwd, value)));
  }
  return [...paths];
}

function expandShellPathToken(value: string | null, cwd: string): string | null {
  if (!value) {
    return null;
  }
  return value
    .replace(/\$\{SCRIPT_DIR\}|\$SCRIPT_DIR/gu, cwd)
    .replace(/\$\{PWD\}|\$PWD/gu, cwd);
}

function normalizeShellPathToken(token: string): string | null {
  const value = token.replace(/^['"]|['"]$/g, "");
  const assignmentMatch = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/u);
  if (!assignmentMatch) {
    return value;
  }
  const rhs = assignmentMatch[2]?.replace(/^['"]|['"]$/g, "") || "";
  if (!rhs) {
    return null;
  }
  if (
    rhs.startsWith("./") ||
    rhs.startsWith("../") ||
    rhs.startsWith(path.sep) ||
    rhs.includes(path.sep) ||
    /\.(py|js|mjs|cjs|sh|json|yaml|yml|toml)$/iu.test(rhs)
  ) {
    return rhs;
  }
  return null;
}

function looksLikePath(value: string): boolean {
  if (!value) {
    return false;
  }
  if (/^[a-z]+:\/\//iu.test(value)) {
    return false;
  }
  return (
    value.startsWith(".") ||
    value.startsWith(path.sep) ||
    value.includes(path.sep) ||
    /\.(py|js|mjs|cjs|sh|json|yaml|yml|toml)$/iu.test(value)
  );
}

function isRunnableScript(filePath: string): boolean {
  return /\.(py|js|mjs|cjs|sh)$/iu.test(filePath);
}

function validatePythonRunnableSurface(
  scriptPath: string,
  scriptText: string
): ExperimentDesignImplementationValidationFinding[] {
  if (!scriptText) {
    return [];
  }
  const nonCommentCodeLines = scriptText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const hasCanonicalSkeletonMarker = /AUTOLABOS\s+CANONICAL\s+SKELETON/iu.test(scriptText);
  if (hasCanonicalSkeletonMarker && nonCommentCodeLines.length === 0) {
    return [
      {
        code: "PYTHON_RUNNER_SKELETON_ONLY",
        severity: "block",
        message:
          "The reported Python runner is only a canonical skeleton and cannot be handed off as a runnable implementation.",
        evidence: [
          `script_path=${scriptPath}`,
          `non_comment_code_lines=${nonCommentCodeLines.length}`,
          "py_compile_sufficient=false"
        ].join("; ")
      }
    ];
  }
  return [];
}

async function findPublicRunCommandWrappers(publicDir: string, publicArtifacts: string[]): Promise<string[]> {
  const candidates = dedupeStrings([
    path.join(publicDir, "run_command.sh"),
    ...publicArtifacts.filter((artifactPath) => path.basename(artifactPath) === "run_command.sh")
  ]);
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

async function findUnsupportedWrapperScriptFlags(wrapperPath: string, scriptText: string): Promise<string[]> {
  if (!scriptText) {
    return [];
  }
  const wrapperText = await safeReadText(wrapperPath);
  if (!wrapperText) {
    return [];
  }
  const wrapperFlags = extractLongOptionFlags(wrapperText);
  if (wrapperFlags.length === 0) {
    return [];
  }
  const acceptedFlags = extractArgparseLongOptionFlags(scriptText);
  if (acceptedFlags.size === 0) {
    return [];
  }
  return wrapperFlags.filter((flag) => !acceptedFlags.has(flag));
}

function extractArgparseLongOptionFlags(scriptText: string): Set<string> {
  const flags = new Set<string>();
  for (const match of scriptText.matchAll(/\badd_argument\s*\(([\s\S]*?)\)/gu)) {
    for (const flagMatch of (match[1] || "").matchAll(/["'](--[A-Za-z0-9][A-Za-z0-9_-]*)["']/gu)) {
      flags.add(flagMatch[1]);
    }
  }
  return flags;
}

function extractLongOptionFlags(text: string): string[] {
  const flags: string[] = [];
  for (const match of text.matchAll(/(?:^|[\s"'`])(--[A-Za-z0-9][A-Za-z0-9_-]*)(?=$|[\s"'`=])/gu)) {
    const flag = match[1];
    if (flag && !flags.includes(flag)) {
      flags.push(flag);
    }
  }
  return flags;
}

async function shellWrapperReferencesScriptPath(wrapperPath: string, scriptPath: string): Promise<boolean> {
  if (!/\.sh$/iu.test(wrapperPath)) {
    return false;
  }
  const wrapperText = await safeReadText(wrapperPath);
  if (!wrapperText) {
    return false;
  }
  const wrapperDir = path.dirname(wrapperPath);
  const referencedPaths = extractCommandPaths(wrapperText, wrapperDir).filter((candidate) => !samePath(candidate, wrapperPath));
  return referencedPaths.some((candidate) => samePath(candidate, scriptPath));
}

function shellWrapperReferencesScriptPathSync(wrapperPath: string, scriptPath: string): boolean {
  if (!/\.sh$/iu.test(wrapperPath)) {
    return false;
  }
  let wrapperText = "";
  try {
    wrapperText = readFileSync(wrapperPath, "utf8");
  } catch {
    return false;
  }
  const wrapperDir = path.dirname(wrapperPath);
  const referencedPaths = extractCommandPaths(wrapperText, wrapperDir).filter((candidate) => !samePath(candidate, wrapperPath));
  return referencedPaths.some((candidate) => samePath(candidate, scriptPath));
}

async function missingSameNamedScriptReference(referencedPath: string, scriptPath: string): Promise<boolean> {
  if (path.basename(referencedPath) !== path.basename(scriptPath)) {
    return false;
  }
  if (samePath(referencedPath, scriptPath)) {
    return true;
  }
  const [referencedExists, scriptExists] = await Promise.all([pathExists(referencedPath), pathExists(scriptPath)]);
  return !referencedExists && scriptExists;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function findMetricsPathReference(paths: string[]): string | undefined {
  return paths.find((candidate) => /metrics[^/]*\.json$/iu.test(candidate) || /metrics\.json$/iu.test(candidate));
}

function isSubpath(targetPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, targetPath);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function samePath(left: string, right: string): boolean {
  return path.normalize(left) === path.normalize(right);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
