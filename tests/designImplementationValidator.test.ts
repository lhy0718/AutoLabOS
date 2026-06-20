import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildExperimentComparisonContract } from "../src/core/experimentGovernance.js";
import { buildHeuristicObjectiveMetricProfile } from "../src/core/objectiveMetric.js";
import {
  validateDesignImplementationAlignment,
  validateVerificationCommandSurface
} from "../src/core/experiments/designImplementationValidator.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("validateDesignImplementationAlignment", () => {
  it("blocks when run_command points at a different script than script_path", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const otherScriptPath = path.join(publicDir, "other_experiment.py");
    writeFileSync(scriptPath, "print('baseline run')\n", "utf8");

    const contract = buildExperimentComparisonContract({
      run: { id: "run-1", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-1",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `python3 ${JSON.stringify(otherScriptPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath: path.join(workspace, ".autolabos", "runs", "run-1", "metrics.json"),
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RUN_COMMAND_SCRIPT_MISMATCH",
          severity: "block"
        })
      ])
    );
  });

  it("allows aligned script and metrics bindings", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-pass-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-2", "metrics.json");
    writeFileSync(
      scriptPath,
      "def run_baseline():\n    return 1\n\nprint('baseline and adaptive evaluation')\n",
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-2", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-2",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("allow");
    expect(report.findings.filter((finding) => finding.severity === "block")).toEqual([]);
  });

  it("blocks a canonical Python skeleton even when py_compile would pass", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-skeleton-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-skeleton", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "# AUTOLABOS CANONICAL SKELETON",
        "# BEGIN AUTOLABOS SECTION: runner_contract",
        "# END AUTOLABOS SECTION: runner_contract",
        "# BEGIN AUTOLABOS SECTION: runner_data_access",
        "# END AUTOLABOS SECTION: runner_data_access",
        "# BEGIN AUTOLABOS SECTION: runner_model_execution",
        "# END AUTOLABOS SECTION: runner_model_execution",
        "# BEGIN AUTOLABOS SECTION: runner_evaluation",
        "# END AUTOLABOS SECTION: runner_evaluation",
        "# BEGIN AUTOLABOS SECTION: runner_metrics",
        "# END AUTOLABOS SECTION: runner_metrics",
        "# BEGIN AUTOLABOS SECTION: runner_entrypoint",
        "# END AUTOLABOS SECTION: runner_entrypoint"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 2,
        required_run_count: 4,
        seed_schedule: [42, 43],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: ["baseline_condition", "candidate_condition_a"],
        primary_metric_key: "quality_delta_vs_baseline"
      },
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, wrapperPath],
        publicArtifacts: [scriptPath, wrapperPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.checked_items).toContain("python_runnable_surface");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PYTHON_RUNNER_SKELETON_ONLY",
          severity: "block",
          evidence: expect.stringContaining("py_compile_sufficient=false")
        })
      ])
    );
  });

  it("blocks a per-run helper that calls undefined train and evaluation hooks", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-helper-deps-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-helper-deps", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = ('condition_alpha', 'condition_beta')",
        "PLANNED_SEEDS = (1, 2)",
        "PLANNED_CONDITION_SEED_RUNS = [",
        "    {'condition_marker': marker, 'seed': seed}",
        "    for marker in PLANNED_CONDITION_MARKERS",
        "    for seed in PLANNED_SEEDS",
        "]",
        "def run_single_condition_seed(runtime, condition, seed, data_bundle=None):",
        "    trained = execute_condition_model(runtime=runtime, condition=condition, seed=seed)",
        "    return evaluate_condition_state(state=trained, runtime=runtime)",
        "def main(argv=None):",
        "    return 0",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 2,
        required_run_count: 4,
        seed_schedule: [1, 2],
        baseline_condition_marker: "condition_alpha",
        required_condition_markers: ["condition_alpha", "condition_beta"],
        primary_metric_key: "quality_delta_vs_baseline"
      },
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, wrapperPath],
        publicArtifacts: [scriptPath, wrapperPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_PER_RUN_HELPER_UNDEFINED_DEPENDENCY",
          severity: "block",
          evidence: expect.stringContaining("missing_dependency=execute_condition_model")
        })
      ])
    );
  });

  it("blocks entrypoint data loaders that run before runtime path aliases are defaulted", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-loader-path-order-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-loader-path-order", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = ('condition_alpha', 'condition_beta')",
        "PLANNED_SEEDS = (1, 2)",
        "PRIMARY_METRIC_KEY = 'quality_delta_vs_baseline'",
        "def load_task_bundle(args):",
        "    return args.artifact_paths",
        "def _autolabos_entrypoint_loaded_data(config):",
        "    return load_task_bundle(config)",
        "def _autolabos_entrypoint_paths(config, args, output_dir=None, metrics_path=None):",
        "    return {'output_dir': output_dir, 'metrics_path': metrics_path}",
        "def _autolabos_entrypoint_set_default(obj, key, value):",
        "    setattr(obj, key, value)",
        "def _autolabos_entrypoint_run(argv=None):",
        "    args = type('Args', (), {})()",
        "    config = args",
        "    output_dir = 'out'",
        "    metrics_path = 'metrics.json'",
        "    single_runner = lambda **kwargs: {'status': 'completed'}",
        "    if callable(single_runner):",
        "        runtime_paths = _autolabos_entrypoint_paths(config, args, output_dir=output_dir, metrics_path=metrics_path)",
        "        loaded_data = _autolabos_entrypoint_loaded_data(config)",
        "        for _autolabos_paths_alias in ('paths', 'output_paths', 'artifact_paths', 'experiment_paths', 'runtime_paths'):",
        "            _autolabos_entrypoint_set_default(config, _autolabos_paths_alias, runtime_paths)",
        "            _autolabos_entrypoint_set_default(args, _autolabos_paths_alias, runtime_paths)",
        "        return loaded_data",
        "def main(argv=None):",
        "    return _autolabos_entrypoint_run(argv)",
        "if __name__ == '__main__':",
        "    raise SystemExit(0 if main() else 1)"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 2,
        required_run_count: 4,
        seed_schedule: [1, 2],
        baseline_condition_marker: "condition_alpha",
        required_condition_markers: ["condition_alpha", "condition_beta"],
        primary_metric_key: "quality_delta_vs_baseline"
      },
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, wrapperPath],
        publicArtifacts: [scriptPath, wrapperPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_ENTRYPOINT_LOADER_PATH_DEFAULTS_AFTER_DATA_LOADER",
          severity: "block",
          evidence: expect.stringContaining("missing_alias=artifact_paths")
        })
      ])
    );
  });

  it("allows a shell run_command wrapper that launches script_path", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-wrapper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-wrapper", "metrics.json");
    writeFileSync(scriptPath, "print('baseline and adaptive evaluation')\n", "utf8");
    writeFileSync(
      wrapperPath,
      `#!/usr/bin/env bash\npython3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}\n`,
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-wrapper", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-wrapper",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, wrapperPath],
        publicArtifacts: [scriptPath, wrapperPath]
      }
    });

    expect(report.verdict).toBe("allow");
    expect(report.findings.filter((finding) => finding.severity === "block")).toEqual([]);
  });

  it("allows a published run_command.sh wrapper that launches script_path through SCRIPT_DIR", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-public-wrapper-pass-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-public-wrapper-pass", "metrics.json");
    writeFileSync(scriptPath, "print('baseline and adaptive evaluation')\n", "utf8");
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'python "${SCRIPT_DIR}/current_study_runner.py" --metrics-path "${PWD}/metrics.json"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-public-wrapper-pass", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-public-wrapper-pass",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("allow");
    expect(report.findings.filter((finding) => finding.severity === "block")).toEqual([]);
    expect(report.checked_items).toContain("public_run_command_wrapper_binding");
  });

  it("uses a shell wrapper target runner as the planned-condition implementation surface", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-wrapper-surface-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-wrapper-surface", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "BASELINE_CONDITION_MARKER = 'baseline_condition'",
        "REQUIRED_SEEDS = (42, 43, 44)",
        "REQUIRED_CONDITION_MARKERS = (",
        "  'baseline_condition', 'candidate_condition_a', 'candidate_condition_a5',",
        "  'baseline_condition5', 'candidate_condition_d', 'candidate_condition_d5',",
        "  'candidate_condition_f', 'candidate_condition_f5',",
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 24",
        "print('baseline and adaptive evaluation')"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'exec python "${SCRIPT_DIR}/current_study_runner.py" --metrics-path "${PWD}/metrics.json"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-wrapper-surface", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-wrapper-surface",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 24,
        seed_schedule: [42, 43, 44],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "baseline_condition",
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        scriptPath: wrapperPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [wrapperPath, scriptPath],
        publicArtifacts: [wrapperPath, scriptPath]
      }
    });

    expect(report.verdict).toBe("allow");
    expect(report.findings.filter((finding) => finding.severity === "block")).toEqual([]);
  });

  it("blocks when a published run_command.sh still launches a stale runner", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-public-wrapper-stale-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const staleScriptPath = path.join(publicDir, "stale_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-public-wrapper-stale", "metrics.json");
    writeFileSync(scriptPath, "REQUIRED_CONDITION_COUNT = 8\nprint('baseline and adaptive evaluation')\n", "utf8");
    writeFileSync(staleScriptPath, "REQUIRED_CONDITION_COUNT = 4\nprint('stale runner')\n", "utf8");
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'python "${SCRIPT_DIR}/stale_study_runner.py" --metrics-path "${PWD}/metrics.json"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-public-wrapper-stale", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-public-wrapper-stale",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PUBLIC_RUN_COMMAND_WRAPPER_SCRIPT_MISMATCH",
          severity: "block"
        })
      ])
    );
  });

  it("blocks when a published run_command.sh passes flags unsupported by script_path", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-public-wrapper-flags-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-public-wrapper-flags", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--metrics-path')",
        "parser.add_argument('--public-dir')",
        "print('baseline and adaptive evaluation')"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'python "${SCRIPT_DIR}/current_study_runner.py" --experiment-dir "${SCRIPT_DIR}" --metrics-path "${PWD}/metrics.json"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-public-wrapper-flags", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-public-wrapper-flags",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      attempt: {
        runCommand: `bash ${JSON.stringify(wrapperPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, wrapperPath],
        publicArtifacts: [scriptPath, wrapperPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PUBLIC_RUN_COMMAND_WRAPPER_UNSUPPORTED_ARGS",
          severity: "block",
          evidence: expect.stringContaining("--experiment-dir")
        })
      ])
    );
  });

  it("blocks when a runner compresses the planned full-grid condition and seed contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-planned-contract-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-planned", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "REQUIRED_CONDITION_COUNT = 5",
        "DEFAULT_SEED = 17",
        "PLANNED_CONDITIONS = ['baseline_condition', 'candidate_condition_h', 'candidate_condition_d', 'candidate_condition_i', 'candidate_condition_f']",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-planned", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-planned",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 24,
        minimum_seeds_per_condition: 3,
        seed_schedule: [42, 43, 44],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_CONDITION_MARKERS_MISSING",
          severity: "block"
        }),
        expect.objectContaining({
          code: "PLANNED_CONDITION_COUNT_CONTRACTED",
          severity: "block"
        }),
        expect.objectContaining({
          code: "PLANNED_SEED_SCHEDULE_MISSING",
          severity: "block"
        })
      ])
    );
  });

  it("blocks when a runner expands the planned condition contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-expanded-contract-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-expanded", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "BASELINE_CONDITION_MARKER = 'baseline_condition'",
        "REQUIRED_CONDITION_MARKERS = (",
        "  'baseline_condition', 'candidate_condition_a', 'candidate_condition_b', 'candidate_condition_c',",
        ")",
        "REQUIRED_CONDITION_COUNT = 4",
        "REQUIRED_RUN_COUNT = 4",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-expanded", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-expanded",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 3,
        required_run_count: 3,
        seed_schedule: [42],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: ["baseline_condition", "candidate_condition_a", "candidate_condition_b"]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_CONDITION_COUNT_EXPANDED",
          severity: "block",
          evidence: expect.stringContaining("declared=4; required=3")
        })
      ])
    );
  });

  it("blocks when the baseline marker is not materialized by the condition catalog", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-baseline-materialized-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-baseline-materialized", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "BASELINE_CONDITION_MARKER = 'baseline_condition'",
        "REQUIRED_CONDITION_MARKERS = ('candidate_condition_a', 'candidate_condition_b')",
        "REQUIRED_CONDITION_COUNT = 2",
        "CONDITION_BY_MARKER = {marker: marker for marker in REQUIRED_CONDITION_MARKERS}",
        "BASELINE_CONDITION = CONDITION_BY_MARKER[BASELINE_CONDITION_MARKER]",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-baseline-materialized", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-baseline-materialized",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 2,
        required_run_count: 2,
        seed_schedule: [42],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: ["baseline_condition", "candidate_condition_a"]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_BASELINE_MARKER_NOT_MATERIALIZED",
          severity: "block",
          evidence: expect.stringContaining("baseline_condition")
        })
      ])
    );
  });

  it("blocks stale public docs that contradict the approved full-grid run contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-public-doc-contract-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const readmePath = path.join(publicDir, "README.md");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-public-doc", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        "  'baseline_condition', 'candidate_condition_a', 'candidate_condition_a5', 'baseline_condition5',",
        "  'candidate_condition_d', 'candidate_condition_d5', 'candidate_condition_f', 'candidate_condition_f5',",
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      readmePath,
      [
        "Planned tuned conditions:",
        "- baseline_condition",
        "- candidate_condition_a",
        "- candidate_condition_d",
        "- candidate_condition_f",
        "",
        "Planned run count:",
        "- 22 total runs"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-public-doc", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-public-doc",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "baseline_condition",
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath, readmePath],
        publicArtifacts: [scriptPath, readmePath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PUBLIC_CONDITION_MARKERS_CONTRACTED",
          severity: "block"
        }),
        expect.objectContaining({
          code: "PUBLIC_RUN_COUNT_CONTRACTED",
          severity: "block"
        })
      ])
    );
  });

  it("ignores stale public docs outside the current handoff artifact list", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-stale-public-doc-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const readmePath = path.join(publicDir, "README.md");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-stale-public-doc", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g",
      "candidate_condition_h"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 9",
        "REQUIRED_RUN_COUNT = 45",
        "SEED_SCHEDULE = [11, 22, 33, 44, 55]",
        "def run_condition_seed(condition, seed):",
        "    return {'condition': condition, 'seed': seed, 'status': 'completed'}",
        "def main():",
        "    return {'completed_run_count': 45, 'accuracy_delta_vs_baseline': 0.0}"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      readmePath,
      ["Stale previous attempt summary.", "Published condition count: 6", "Published run count: 32"].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 9,
        required_run_count: 45,
        seed_schedule: [11, 22, 33, 44, 55],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PUBLIC_CONDITION_MARKERS_CONTRACTED" }),
        expect.objectContaining({ code: "PUBLIC_RUN_COUNT_CONTRACTED" })
      ])
    );
  });

  it("blocks planned runners that declare a full schedule but resolve only missing per-run helpers", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-missing-per-run-helper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-missing-per-run-helper", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        "  'baseline_condition', 'candidate_condition_a', 'candidate_condition_a5', 'baseline_condition5',",
        "  'candidate_condition_d', 'candidate_condition_d5', 'candidate_condition_f', 'candidate_condition_f5',",
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def _resolve_global_callable(names):",
        "    return None",
        "def _resolve_run_callable():",
        "    run_callable = _resolve_global_callable([",
        "        'run_condition_seed',",
        "        'run_condition_seed_experiment',",
        "        'execute_condition_seed_run',",
        "        'train_and_evaluate_condition',",
        "    ])",
        "    if run_callable is None:",
        "        raise RuntimeError('No callable per-run execution helper was found in the current script.')",
        "    return run_callable",
        "def main():",
        "    return {'completed_run_count': 0, 'accuracy_delta_vs_baseline': None}"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-missing-per-run-helper", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-missing-per-run-helper",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "baseline_condition",
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_PER_RUN_EXECUTION_HELPER_MISSING",
          severity: "block",
          evidence: expect.stringContaining("required_runs=32")
        })
      ])
    );
  });

  it("blocks planned runners whose execution loop resolver raises the runnable-helper variant", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-runnable-helper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-runnable-helper", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        "  'baseline_condition', 'candidate_condition_a', 'candidate_condition_a5', 'baseline_condition5',",
        "  'candidate_condition_d', 'candidate_condition_d5', 'candidate_condition_f', 'candidate_condition_f5',",
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def _find_callable(names):",
        "    return None",
        "def _execute_study_runs():",
        "    single_run_function = _find_callable((",
        "        'run_single_condition_seed',",
        "        '_run_single_condition_seed',",
        "        'execute_single_run',",
        "        '_execute_single_run',",
        "        'run_condition_seed',",
        "        '_run_condition_seed',",
        "        'train_and_evaluate_single_run',",
        "    ))",
        "    if single_run_function is None:",
        "        raise RuntimeError('Unable to locate a runnable execution helper in the current module. Expected a study runner, execution loop, or single-run callable.')",
        "    return single_run_function",
        "def main():",
        "    return {'completed_run_count': 0, 'accuracy_delta_vs_baseline': None}"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "baseline_condition",
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_PER_RUN_EXECUTION_HELPER_MISSING",
          severity: "block",
          evidence: expect.stringContaining("run_single_condition_seed")
        })
      ])
    );
  });

  it("blocks entrypoint stage dispatchers whose required helper candidates are undefined", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-stage-helper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-stage-helper", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def _entrypoint_call_stage(stage_name, candidates, call_variants):",
        "    raise RuntimeError(f\"Missing required {stage_name} helper; tried: {', '.join(candidates)}\")",
        "def main():",
        "    config = {}",
        "    args = {}",
        "    context = _entrypoint_call_stage(",
        "        'execution context preflight',",
        "        ('setup_execution_context', 'prepare_execution_context', 'preflight_execution_context', 'initialize_execution_context'),",
        "        ((config, args), (config,), (args,), ()),",
        "    )",
        "    return {'completed_run_count': 32, 'context': context}",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_ENTRYPOINT_STAGE_HELPER_MISSING",
          severity: "block",
          evidence: expect.stringContaining("setup_execution_context")
        })
      ])
    );
  });

  it("blocks generic entrypoint callable resolvers whose advertised candidates are undefined", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-callable-resolver-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-callable-resolver", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def _lookup_callable(candidate_names, purpose):",
        "    available = ', '.join(sorted(name for name, value in globals().items() if callable(value))) or 'none'",
        "    raise RuntimeError(f\"No callable found for {purpose}; checked {candidate_names!r}, available={available}\")",
        "def main():",
        "    resolver = _lookup_callable(",
        "        ('resolve_execution_context', 'build_execution_context', 'create_execution_context'),",
        "        'runtime context resolution',",
        "    )",
        "    return {'completed_run_count': 32, 'resolver': resolver}",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_CALLABLE_RESOLVER_TARGET_MISSING",
          severity: "block",
          evidence: expect.stringContaining("resolve_execution_context")
        })
      ])
    );
  });

  it("blocks orchestration resolvers whose advertised dispatch helpers are undefined", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-orchestration-helper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-orchestration-helper", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def initialize_runtime_context(argv=None):",
        "    return {'metrics_path': 'metrics.json'}",
        "def build_baseline_first_run_plan(context):",
        "    return [('baseline_condition', 42)]",
        "def _resolve_orchestration_helper(label, candidates, token_sets):",
        "    raise RuntimeError(f'No orchestration helper found for {label}; tried {list(candidates)}')",
        "def main():",
        "    dispatch_fn = _resolve_orchestration_helper(",
        "        'condition-seed dispatch',",
        "        ('dispatch_condition_seed_plan', 'execute_condition_seed_plan', 'run_condition_seed_jobs'),",
        "        (('condition', 'seed', 'jobs'),),",
        "    )",
        "    return dispatch_fn",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_CALLABLE_RESOLVER_TARGET_MISSING",
          severity: "block",
          evidence: expect.stringContaining("dispatch_condition_seed_plan")
        })
      ])
    );
  });

  it("blocks entry-call orchestration stages whose advertised helpers are undefined", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-entry-call-helper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-entry-call-helper", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def prepare_runtime_context(argv=None):",
        "    return {'metrics_path': 'metrics.json'}",
        "def _entry_call(candidates, arg_options):",
        "    available = []",
        "    for name in candidates:",
        "        fn = globals().get(name)",
        "        if callable(fn):",
        "            available.append(name)",
        "            return fn()",
        "    raise RuntimeError(f'No compatible orchestration helper found. candidates={list(candidates)} available={available}')",
        "def main(argv=None):",
        "    ctx = _entry_call(('prepare_runtime_context',), ((argv,), ()))",
        "    resources = _entry_call(",
        "        ('setup_shared_resources', '_setup_shared_resources', 'prepare_shared_resources', '_prepare_shared_resources'),",
        "        ((ctx,), (ctx, argv), ()),",
        "    )",
        "    return resources",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_CALLABLE_RESOLVER_TARGET_MISSING",
          severity: "block",
          evidence: expect.stringContaining("setup_shared_resources")
        })
      ])
    );
  });

  it("blocks numeric argparse defaults that can resolve to an empty environment string", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-empty-numeric-default-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-empty-numeric-default", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "import argparse",
        "import os",
        "ENV_OPTIONAL_LIMIT = 'OPTIONAL_LIMIT'",
        "DEFAULT_OPTIONAL_LIMIT = os.environ.get(ENV_OPTIONAL_LIMIT, '').strip()",
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def _env_optional_int(name, default):",
        "    raw = os.environ.get(name)",
        "    if raw is None or raw == '':",
        "        return default",
        "    return int(raw)",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path', default=None)",
        "    parser.add_argument('--optional-limit', type=int, default=_env_optional_int(ENV_OPTIONAL_LIMIT, DEFAULT_OPTIONAL_LIMIT))",
        "    return parser",
        "def run_single_condition_seed():",
        "    return {'status': 'completed'}",
        "def main():",
        "    args = build_arg_parser().parse_args()",
        "    return {'completed_run_count': 32, 'limit': args.optional_limit}",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_ARGPARSE_EMPTY_NUMERIC_DEFAULT",
          severity: "block",
          evidence: expect.stringContaining("DEFAULT_OPTIONAL_LIMIT")
        })
      ])
    );
  });

  it("blocks public study entrypoints that cannot accept run_experiments args keyword", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-entrypoint-args-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-entrypoint-args", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'accuracy_delta_vs_baseline': 0.0}",
        "def run_public_study(config):",
        "    return {'completed_run_count': 32, 'accuracy_delta_vs_baseline': 0.0}",
        "def main():",
        "    return run_public_study(config={})"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_ENTRYPOINT_ARGS_INCOMPATIBLE",
          severity: "block",
          evidence: expect.stringContaining("run_public_study(config)")
        })
      ])
    );
  });

  it("blocks Python study runners that define but never invoke the CLI entrypoint", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-cli-entrypoint-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-cli-entrypoint", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "import argparse",
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'quality_delta_vs_baseline'",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'quality_delta_vs_baseline': 0.0}",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path')",
        "    return parser",
        "def parse_args(argv=None):",
        "    return build_arg_parser().parse_args(argv)",
        "def run_public_study(args=None):",
        "    return {'completed_run_count': 32, 'quality_delta_vs_baseline': 0.0}",
        "def main(argv=None):",
        "    args = parse_args(argv)",
        "    return run_public_study(args=args)"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_CLI_ENTRYPOINT_NOT_INVOKED",
          severity: "block",
          evidence: expect.stringContaining("main_guard=missing")
        })
      ])
    );
  });

  it("blocks Python study runners whose main guard appears before the governed schedule contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-early-main-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-early-main", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "import argparse",
        "def build_arg_parser():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--metrics-path')",
        "    return parser",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'quality_delta_vs_baseline': 0.0}",
        "def run_public_study(args=None):",
        "    return {'completed_run_count': 32, 'quality_delta_vs_baseline': 0.0}",
        "def main(argv=None):",
        "    args = build_arg_parser().parse_args(argv)",
        "    return run_public_study(args=args)",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())",
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'quality_delta_vs_baseline'"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_EARLY_MAIN_GUARD",
          severity: "block",
          evidence: expect.stringContaining("late_schedule_signal=PLANNED_CONDITION_MARKERS")
        })
      ])
    );
  });

  it("blocks Python study runners whose dataclass default_factory is defined too late", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-default-factory-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-default-factory", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c"
    ];
    writeFileSync(
      scriptPath,
      [
        "from dataclasses import dataclass, field",
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 4",
        "REQUIRED_RUN_COUNT = 8",
        "SEED_SCHEDULE = [42, 43]",
        "PRIMARY_METRIC_KEY = 'quality_delta_vs_baseline'",
        "@dataclass",
        "class StudyRunPlan:",
        "    condition_markers: tuple[str, ...] = PLANNED_CONDITION_MARKERS",
        "    generated_at: str = field(default_factory=timestamp_factory)",
        "def timestamp_factory():",
        "    return '2026-01-01T00:00:00Z'",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'quality_delta_vs_baseline': 0.0}",
        "def run_public_study(args=None):",
        "    return {'completed_run_count': 8, 'quality_delta_vs_baseline': 0.0}",
        "def main(argv=None):",
        "    return run_public_study()",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 4,
        required_run_count: 8,
        seed_schedule: [42, 43],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_DEFAULT_FACTORY_UNRESOLVED",
          severity: "block",
          evidence: expect.stringContaining("default_factory=timestamp_factory")
        })
      ])
    );
  });

  it("allows dotted callable dataclass default factories", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-dotted-default-factory-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-dotted-default-factory", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c"
    ];
    writeFileSync(
      scriptPath,
      [
        "import time",
        "from dataclasses import dataclass, field",
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 4",
        "REQUIRED_RUN_COUNT = 8",
        "SEED_SCHEDULE = [42, 43]",
        "PRIMARY_METRIC_KEY = 'quality_delta_vs_baseline'",
        "@dataclass",
        "class StudyRunPlan:",
        "    condition_markers: tuple[str, ...] = PLANNED_CONDITION_MARKERS",
        "    generated_at: float = field(default_factory=time.time)",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'quality_delta_vs_baseline': 0.0}",
        "def run_public_study(args=None):",
        "    return {'completed_run_count': 8, 'quality_delta_vs_baseline': 0.0}",
        "def main(argv=None):",
        "    return run_public_study()",
        "if __name__ == '__main__':",
        "    raise SystemExit(main())"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 4,
        required_run_count: 8,
        seed_schedule: [42, 43],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_DEFAULT_FACTORY_UNRESOLVED"
        })
      ])
    );
  });

  it("does not require args keyword on per-run condition-seed helpers", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-per-run-entrypoint-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-per-run-entrypoint", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "PRIMARY_METRIC_KEY = 'accuracy_delta_vs_baseline'",
        "def run_single_condition_seed_experiment(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed, 'accuracy_delta_vs_baseline': 0.0}",
        "def run_public_study(args):",
        "    return {'completed_run_count': 32, 'accuracy_delta_vs_baseline': 0.0}",
        "def main():",
        "    return run_public_study(args={})"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_ENTRYPOINT_ARGS_INCOMPATIBLE",
          evidence: expect.stringContaining("run_single_condition_seed_experiment")
        })
      ])
    );
  });

  it("blocks locked condition resolvers that cannot discover the declared condition catalog", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-locked-resolver-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-locked-resolver", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "LOCKED_CONDITION_SPECS = (",
        ...markers.map((marker, index) => `  {'marker': '${marker}', 'order': ${index}},`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition['marker'], 'seed': seed}",
        "def _first_present_global(names, default):",
        "    return default",
        "def _get_locked_condition_specs():",
        "    raw = _first_present_global(('LOCKED_CONDITIONS', 'PLANNED_CONDITIONS', 'CONDITION_SCHEDULE', 'CONDITIONS'), [])",
        "    if not raw:",
        "        raise ValueError('No locked conditions are available to select from.')",
        "    return list(raw)",
        "def run_public_study(args=None):",
        "    return {'completed_run_count': 32}"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_LOCKED_CONDITION_RESOLVER_MISMATCH",
          severity: "block",
          evidence: expect.stringContaining("LOCKED_CONDITION_SPECS")
        })
      ])
    );
  });

  it("blocks unresolved runtime guards where the study execution loop should be", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-runtime-guard-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "study_runner.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-runtime-guard", "metrics.json");
    const markers = [
      "baseline_condition",
      "candidate_condition_a",
      "candidate_condition_b",
      "candidate_condition_c",
      "candidate_condition_d",
      "candidate_condition_e",
      "candidate_condition_f",
      "candidate_condition_g"
    ];
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        ...markers.map((marker) => `  '${marker}',`),
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 32",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "def run_single_condition_seed(condition, seed, output_dir):",
        "    return {'condition_marker': condition, 'seed': seed}",
        "def run_public_study(args=None):",
        "    raise RuntimeError('No locked study execution helper is available; expected chunk_2c2 execution loop definitions.')"
      ].join("\n"),
      "utf8"
    );

    const report = await validateDesignImplementationAlignment({
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 32,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: markers[0],
        required_condition_markers: markers
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_RUNTIME_EXECUTION_GUARD_UNRESOLVED",
          severity: "block",
          evidence: expect.stringContaining("missing_locked_study_execution_helper")
        })
      ])
    );
  });

  it("blocks hard evaluation caps below a full-validation contract", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-full-eval-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-full-eval", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "LOCKED_BUDGET = dict(max_eval_examples_per_task=96)",
        "PLANNED_CONDITION_MARKERS = ('baseline_condition', 'candidate_condition_a')",
        "REQUIRED_RUN_COUNT = 8",
        "SEED_SCHEDULE = [42, 43, 44, 45]",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-full-eval", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-full-eval",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 2,
        required_run_count: 8,
        seed_schedule: [42, 43, 44, 45],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: ["baseline_condition", "candidate_condition_a"],
        full_evaluation_required: true,
        minimum_eval_examples_per_task: {
          benchmark_task_a: 299,
          benchmark_task_b: 10042
        }
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_FULL_EVAL_CONTRACTED",
          severity: "block",
          evidence: expect.stringContaining("declared_cap=96")
        })
      ])
    );
  });

  it("blocks when the full condition grid is present but the locked baseline is not first", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-baseline-order-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const metricsPath = path.join(workspace, ".autolabos", "runs", "run-baseline-order", "metrics.json");
    writeFileSync(
      scriptPath,
      [
        "PLANNED_CONDITION_MARKERS = (",
        "  'candidate_condition_a',",
        "  'candidate_condition_a5',",
        "  'baseline_condition',",
        "  'baseline_condition5',",
        "  'candidate_condition_d',",
        "  'candidate_condition_d5',",
        "  'candidate_condition_f',",
        "  'candidate_condition_f5',",
        ")",
        "REQUIRED_CONDITION_COUNT = 8",
        "REQUIRED_RUN_COUNT = 24",
        "SEED_SCHEDULE = [42, 43, 44]",
        "print('baseline and comparator runner')"
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-baseline-order", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-baseline-order",
        hypothesis_ids: ["h1"],
        baselines: ["baseline_condition"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = await validateDesignImplementationAlignment({
      comparisonContract: contract,
      plannedConditionContract: {
        required_condition_count: 8,
        required_run_count: 24,
        seed_schedule: [42, 43, 44],
        baseline_condition_marker: "baseline_condition",
        required_condition_markers: [
          "baseline_condition",
          "candidate_condition_a",
          "candidate_condition_a5",
          "baseline_condition5",
          "candidate_condition_d",
          "candidate_condition_d5",
          "candidate_condition_f",
          "candidate_condition_f5"
        ]
      },
      attempt: {
        runCommand: `python3 ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(metricsPath)}`,
        testCommand: `python3 -m py_compile ${JSON.stringify(scriptPath)}`,
        scriptPath,
        metricsPath,
        workingDir: publicDir,
        publicDir,
        changedFiles: [scriptPath],
        publicArtifacts: [scriptPath]
      }
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "PLANNED_BASELINE_ORDER_MISMATCH",
          severity: "block"
        })
      ])
    );
  });

  it("blocks when verification command points at a different script than script_path", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-verify-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    const otherScriptPath = path.join(publicDir, "other_experiment.py");

    const contract = buildExperimentComparisonContract({
      run: { id: "run-3", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-3",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = validateVerificationCommandSurface({
      comparisonContract: contract,
      verificationCommand: `python3 -m py_compile ${JSON.stringify(otherScriptPath)}`,
      workingDir: publicDir,
      scriptPath,
      metricsPath: path.join(workspace, ".autolabos", "runs", "run-3", "metrics.json"),
      runCommand: `python3 ${JSON.stringify(scriptPath)}`
    });

    expect(report.verdict).toBe("block");
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VERIFY_COMMAND_SCRIPT_MISMATCH",
          severity: "block"
        })
      ])
    );
  });

  it("allows verification through the same published run wrapper as run_command", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-wrapper-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    writeFileSync(scriptPath, "print('baseline evaluation ready')\n", "utf8");
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'exec "${PYTHON_BIN:-python3}" "${SCRIPT_DIR}/current_study_runner.py" "$@"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-wrapper", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-wrapper",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = validateVerificationCommandSurface({
      comparisonContract: contract,
      verificationCommand: `bash ${JSON.stringify(wrapperPath)}`,
      workingDir: publicDir,
      scriptPath,
      metricsPath: path.join(workspace, ".autolabos", "runs", "run-wrapper", "metrics.json"),
      runCommand: `bash ${JSON.stringify(wrapperPath)}`
    });

    expect(report.verdict).toBe("allow");
    expect(report.checked_items).toContain("verification_command_run_wrapper_binding");
    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VERIFY_COMMAND_SCRIPT_MISMATCH"
        })
      ])
    );
  });

  it("allows verification of the runner launched by the reported shell script_path", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-wrapper-target-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const runnerPath = path.join(publicDir, "current_study_runner.py");
    const wrapperPath = path.join(publicDir, "run_command.sh");
    writeFileSync(runnerPath, "print('baseline evaluation ready')\n", "utf8");
    writeFileSync(
      wrapperPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
        'exec "${PYTHON_BIN:-python3}" "${SCRIPT_DIR}/current_study_runner.py" "$@"'
      ].join("\n"),
      "utf8"
    );

    const contract = buildExperimentComparisonContract({
      run: { id: "run-wrapper-target", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-wrapper-target",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = validateVerificationCommandSurface({
      comparisonContract: contract,
      verificationCommand: `python3 -m py_compile ${JSON.stringify(runnerPath)}`,
      workingDir: publicDir,
      scriptPath: wrapperPath,
      metricsPath: path.join(workspace, ".autolabos", "runs", "run-wrapper-target", "metrics.json"),
      runCommand: `bash ${JSON.stringify(wrapperPath)}`
    });

    expect(report.verdict).toBe("allow");
    expect(report.checked_items).toContain("verification_command_wrapper_target_binding");
    expect(report.findings).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "VERIFY_COMMAND_SCRIPT_MISMATCH"
        })
      ])
    );
  });

  it("ignores shell assignment prefixes when a heredoc verification command references the script path", () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-design-validator-heredoc-"));
    tempDirs.push(workspace);
    const publicDir = path.join(workspace, "outputs", "experiment");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "experiment.py");
    writeFileSync(scriptPath, "print('ok')\n", "utf8");

    const contract = buildExperimentComparisonContract({
      run: { id: "run-4", objectiveMetric: "accuracy_delta_vs_baseline" },
      selectedDesign: {
        id: "design-4",
        hypothesis_ids: ["h1"],
        baselines: ["greedy_direct"]
      },
      objectiveProfile: buildHeuristicObjectiveMetricProfile("accuracy_delta_vs_baseline"),
      managedBundleSupported: false
    });

    const report = validateVerificationCommandSurface({
      comparisonContract: contract,
      verificationCommand: [
        "python - << 'PY'",
        `p='${scriptPath}'`,
        "print(p)",
        "PY"
      ].join("\n"),
      workingDir: publicDir,
      scriptPath,
      metricsPath: path.join(workspace, ".autolabos", "runs", "run-4", "metrics.json"),
      runCommand: `python3 ${JSON.stringify(scriptPath)}`
    });

    expect(report.verdict).toBe("allow");
    expect(report.findings.filter((finding) => finding.severity === "block")).toEqual([]);
  });
});
