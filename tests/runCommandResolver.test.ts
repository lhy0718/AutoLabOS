import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureScaffold, resolveAppPaths } from "../src/config.js";
import { RunContextMemory } from "../src/core/memory/runContextMemory.js";
import { buildPublicExperimentDir } from "../src/core/publicArtifacts.js";
import { RunStore } from "../src/core/runs/runStore.js";
import { resolveRunCommand } from "../src/core/nodes/runCommandResolver.js";

const ORIGINAL_CWD = process.cwd();
const tempDirs: string[] = [];

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("resolveRunCommand", () => {
  it("prefers explicit run command stored in run context", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-command-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Run",
      topic: "runner",
      constraints: [],
      objectiveMetric: "loss"
    });

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("implement_experiments.run_command", "python3 demo.py --epochs 1");
    await memory.put("implement_experiments.cwd", ".");
    await memory.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);
    await memory.put("implement_experiments.test_command", "python3 -m py_compile demo.py");

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toBe("python3 demo.py --epochs 1");
    expect(resolved.cwd).toBe(workspace);
    expect(resolved.testCommand).toBe("python3 -m py_compile demo.py");
    expect(resolved.metricsPath).toContain(`${run.id}/metrics.json`);
  });

  it("falls back to run-local experiment script when no explicit command exists", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-script-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Script Run",
      topic: "runner",
      constraints: [],
      objectiveMetric: "loss"
    });

    const runDir = path.join(workspace, ".autolabos", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    const scriptPath = path.join(runDir, "experiment.py");
    writeFileSync(scriptPath, "print('hi')\n", "utf8");

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain(scriptPath);
    expect(resolved.source).toBe("run_dir.experiment.py");
    expect(resolved.metricsPath).toBe(path.join(runDir, "metrics.json"));
  });

  it("prefers public experiment artifacts when available", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-public-script-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Public Script Run",
      topic: "runner",
      constraints: [],
      objectiveMetric: "loss"
    });

    const publicDir = buildPublicExperimentDir(workspace, run);
    mkdirSync(publicDir, { recursive: true });
    const publicScriptPath = path.join(publicDir, "experiment.py");
    writeFileSync(publicScriptPath, "print('hi')\n", "utf8");

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("implement_experiments.public_dir", publicDir);
    await memory.put("implement_experiments.cwd", publicDir);

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain(publicScriptPath);
    expect(resolved.cwd).toBe(publicDir);
    expect(resolved.source).toBe("public_dir.experiment.py");
  });

  it("falls back to a materialized script when the explicit command points to a missing artifact", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-missing-explicit-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Missing Explicit Artifact",
      topic: "runner",
      constraints: [],
      objectiveMetric: "loss"
    });

    const runDir = path.join(workspace, ".autolabos", "runs", run.id);
    mkdirSync(runDir, { recursive: true });
    const actualScriptPath = path.join(runDir, "run_experiment.py");
    writeFileSync(actualScriptPath, "print('hi')\n", "utf8");

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("implement_experiments.run_command", "python3 outputs/demo/experiment.py");
    await memory.put("implement_experiments.script", actualScriptPath);
    await memory.put("implement_experiments.cwd", ".");
    await memory.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain(actualScriptPath);
    expect(resolved.source).toBe("run_context.script");
  });

  it("preserves explicit commands when the interpreter path is missing but the script artifact exists", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-missing-interpreter-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Missing Interpreter Artifact",
      topic: "runner",
      constraints: [],
      objectiveMetric: "loss"
    });

    const publicDir = path.join(workspace, "public-runner");
    mkdirSync(publicDir, { recursive: true });
    const scriptPath = path.join(publicDir, "run_experiment.py");
    writeFileSync(scriptPath, "print('hi')\n", "utf8");

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put(
      "implement_experiments.run_command",
      `./.venv/bin/python ${JSON.stringify(scriptPath)} --metrics-path ${JSON.stringify(
        path.join(workspace, ".autolabos", "runs", run.id, "metrics.json")
      )}`
    );
    await memory.put("implement_experiments.script", scriptPath);
    await memory.put("implement_experiments.cwd", workspace);
    await memory.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain("./.venv/bin/python");
    expect(resolved.command).toContain("--metrics-path");
    expect(resolved.source).toBe("run_context.run_command");
  });

  it("reroutes an argument-free per-condition command to a sibling full-study runner", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-study-reroute-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Study Reroute",
      topic: "runner",
      constraints: [],
      objectiveMetric: "accuracy_delta_vs_baseline"
    });

    const publicDir = path.join(workspace, "public-runner");
    mkdirSync(publicDir, { recursive: true });
    const conditionRunner = path.join(publicDir, "run_condition.py");
    const studyRunner = path.join(publicDir, "run_instruction_study.py");
    writeFileSync(
      conditionRunner,
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--condition-marker', '--condition', required=True)",
        "parser.add_argument('--seed', required=True)",
        "parser.add_argument('--metrics-path')",
        "args = parser.parse_args()"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      studyRunner,
      [
        "import argparse",
        "def main():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--condition-markers', nargs='*')",
        "    parser.add_argument('--metrics-path')",
        "    parser.parse_args()",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    const metricsPath = path.join(workspace, ".autolabos", "runs", run.id, "metrics.json");
    await memory.put(
      "implement_experiments.run_command",
      `python3 ${JSON.stringify(conditionRunner)} --metrics-path ${JSON.stringify(metricsPath)}`
    );
    await memory.put("implement_experiments.public_dir", publicDir);
    await memory.put("implement_experiments.cwd", publicDir);
    await memory.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain(studyRunner);
    expect(resolved.command).toContain("--metrics-path");
    expect(resolved.command).not.toContain(conditionRunner);
    expect(resolved.source).toBe("run_context.run_command.full_study_alternative");
  });

  it("reroutes an argument-free shell wrapper around a per-condition runner", async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "autolabos-run-shell-study-reroute-"));
    tempDirs.push(workspace);
    process.chdir(workspace);
    const paths = resolveAppPaths(workspace);
    await ensureScaffold(paths);

    const runStore = new RunStore(paths);
    const run = await runStore.createRun({
      title: "Runner Shell Study Reroute",
      topic: "runner",
      constraints: [],
      objectiveMetric: "accuracy_delta_vs_baseline"
    });

    const publicDir = path.join(workspace, "public-runner");
    mkdirSync(publicDir, { recursive: true });
    const conditionRunner = path.join(publicDir, "run_condition.py");
    const studyRunner = path.join(publicDir, "run_instruction_study.py");
    const runCommand = path.join(publicDir, "run_command.sh");
    writeFileSync(
      conditionRunner,
      [
        "import argparse",
        "parser = argparse.ArgumentParser()",
        "parser.add_argument('--condition-marker', '--condition', required=True)",
        "parser.add_argument('--seed', required=True)",
        "parser.add_argument('--metrics-path')",
        "args = parser.parse_args()"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      studyRunner,
      [
        "import argparse",
        "def main():",
        "    parser = argparse.ArgumentParser()",
        "    parser.add_argument('--condition-markers', nargs='*')",
        "    parser.add_argument('--metrics-path')",
        "    parser.parse_args()",
        "if __name__ == '__main__':",
        "    main()"
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      runCommand,
      [
        "#!/usr/bin/env bash",
        "SCRIPT_DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"",
        "RUNNER=\"${SCRIPT_DIR}/run_condition.py\"",
        "exec python3 \"$RUNNER\" --metrics-path \"$1\""
      ].join("\n"),
      "utf8"
    );

    const memory = new RunContextMemory(run.memoryRefs.runContextPath);
    await memory.put("implement_experiments.run_command", `bash ${JSON.stringify(runCommand)}`);
    await memory.put("implement_experiments.public_dir", publicDir);
    await memory.put("implement_experiments.cwd", publicDir);
    await memory.put("implement_experiments.metrics_path", `.autolabos/runs/${run.id}/metrics.json`);

    const resolved = await resolveRunCommand(run, workspace);
    expect(resolved.command).toContain(studyRunner);
    expect(resolved.command).toContain("--metrics-path");
    expect(resolved.command).not.toContain(conditionRunner);
    expect(resolved.source).toBe("run_context.run_command.full_study_alternative");
  });
});
