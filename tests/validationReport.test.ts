import { describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// @ts-expect-error JavaScript validation utility has no declaration file.
import { parseOptionalReportArg, writeValidationReport } from "../scripts/lib/validation-report.mjs";

describe("validation report retention", () => {
  it("parses the optional report contract", () => {
    expect(parseOptionalReportArg([])).toEqual({ help: false, reportPath: undefined });
    expect(parseOptionalReportArg(["--report", "reports/result.json"])).toEqual({
      help: false,
      reportPath: "reports/result.json"
    });
    expect(() => parseOptionalReportArg(["--report"])).toThrow(/--report/u);
    expect(() => parseOptionalReportArg(["--unknown", "value"])).toThrow(/--report/u);
  });

  it("writes an atomic portable report and rejects private paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "autolabos-validation-report-"));
    try {
      const output = path.join(root, "reports", "result.json");
      const persisted = writeValidationReport({ verdict: "pass", checks: [] }, output, root);
      const parsed = JSON.parse(fs.readFileSync(output, "utf8"));

      expect(persisted.reportOutput).toBe("reports/result.json");
      expect(parsed).toEqual(persisted);
      expect(fs.readdirSync(path.dirname(output))).toEqual(["result.json"]);
      const privateFixturePath = path.join(path.sep, "home", "example", "private.json");
      expect(() => writeValidationReport({ verdict: "fail", message: privateFixturePath }, output, root))
        .toThrow(/machine-specific/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
