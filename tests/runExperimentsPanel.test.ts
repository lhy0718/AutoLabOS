import { describe, expect, it } from "vitest";

import {
  classifyRunExperimentsFailure,
  decideRunExperimentsRerun
} from "../src/core/runExperimentsPanel.js";

describe("run experiments panel triage", () => {
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
