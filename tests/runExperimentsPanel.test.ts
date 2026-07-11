import { describe, expect, it } from "vitest";

import {
  classifyRunExperimentsFailure,
  decideRunExperimentsRerun
} from "../src/core/runExperimentsPanel.js";

describe("run experiments panel triage", () => {
  it("classifies model dependency blockers as non-retryable", () => {
    const triage = classifyRunExperimentsFailure({
      attempt: 1,
      stage: "metrics",
      summary:
        "Experiment dependency blocker: model asset required model/tokenizer asset could not be loaded. No condition metrics were accepted as evidence.",
      exitCode: 0
    });

    expect(triage.category).toBe("dependency_blocker");
    expect(triage.retryable).toBe(false);
    expect(decideRunExperimentsRerun({ triage, automaticRerunsUsed: 0 })).toMatchObject({
      decision: "fail_fast"
    });
  });

  it("classifies data dependency blockers as non-retryable", () => {
    const triage = classifyRunExperimentsFailure({
      attempt: 1,
      stage: "metrics",
      summary:
        "Experiment dependency blocked (data_dependency_unavailable): task-specific data materialization failed.",
      exitCode: 1
    });

    expect(triage.category).toBe("dependency_blocker");
    expect(triage.retryable).toBe(false);
    expect(decideRunExperimentsRerun({ triage, automaticRerunsUsed: 0 })).toMatchObject({
      decision: "fail_fast"
    });
  });

  it("does not treat reusable-output argparse failures as transient", () => {
    const triage = classifyRunExperimentsFailure({
      attempt: 1,
      stage: "command",
      summary: "error: output directory appears to contain prior study results; rerun with --overwrite-output to reuse it",
      exitCode: 2
    });

    expect(triage.category).toBe("command_failure");
    expect(triage.retryable).toBe(false);
    expect(decideRunExperimentsRerun({ triage, automaticRerunsUsed: 0 })).toMatchObject({
      decision: "fail_fast"
    });
  });
});
