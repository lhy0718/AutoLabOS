import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditMetricPolarityCorpus,
  parseDirection,
  parseNumericScalar,
} from "../lib/corpus.mjs";

describe("metric-polarity corpus preflight", () => {
  it("parses only unambiguous scalar cells and direction marks", () => {
    expect(parseNumericScalar("[BOLD] 1,234.5%")).toBe(1234.5);
    expect(parseNumericScalar("−0.25")).toBe(-0.25);
    expect(parseNumericScalar("1.2 ± 0.3")).toBeNull();
    expect(parseNumericScalar("1-2")).toBeNull();
    expect(parseNumericScalar("-")).toBeNull();
    expect(parseDirection("Accuracy ↑")).toBe("higher");
    expect(parseDirection("Error ↓")).toBe("lower");
    expect(parseDirection("Mixed ↑ / ↓")).toBeNull();
  });

  it("counts columns as families but keeps paper-level scale visible", () => {
    const root = mkdtempSync(join(tmpdir(), "metric-polarity-corpus-"));
    const tables = join(root, "tables");
    mkdirSync(tables);
    const metadata = [
      {
        paper_id: "paper-a",
        claim_id: "claim-a",
        claim_id_pair: "pair-a",
        evi_type: "table",
        label: "Supported",
        license_name: "CC BY 4.0",
      },
      {
        paper_id: "paper-a",
        claim_id: "claim-a-copy",
        claim_id_pair: "pair-a-copy",
        evi_type: "table",
        label: "Supported",
        license_name: "CC BY 4.0",
      },
    ];
    const table = {
      table_caption: "Results",
      table_column_names: ["Method", "Accuracy ↑", "Error ↓", "Ambiguous ↑↓"],
      table_content_values: [
        ["A", "80", "20", "1"],
        ["B", "70", "30", "2"],
      ],
    };
    writeFileSync(join(tables, "claim-a.json"), JSON.stringify(table));
    writeFileSync(join(tables, "claim-a-copy.json"), JSON.stringify(table));

    try {
      const report = auditMetricPolarityCorpus({
        metadataRaw: JSON.stringify(metadata),
        tablesDirectory: tables,
        source: { dataset: "fixture" },
        thresholds: {
          minimum_family_count: 2,
          minimum_paper_count: 1,
          minimum_lower_direction_count: 1,
        },
      });
      expect(report).toMatchObject({
        supported_table_row_count: 2,
        unique_loaded_table_count: 1,
        eligible_family_count: 2,
        eligible_paper_count: 1,
        direction_counts: { higher: 1, lower: 1 },
        corpus_eligible: true,
        decision: "protocol_freeze_may_proceed",
      });
      expect(report.exclusion_counts).toEqual({
        duplicate_table_content: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed when independent corpus thresholds are missed", () => {
    const report = auditMetricPolarityCorpus({
      metadataRaw: "[]",
      tablesDirectory: ".",
      source: { dataset: "fixture" },
    });
    expect(report.corpus_eligible).toBe(false);
    expect(report.decision).toBe(
      "kill_candidate_for_insufficient_independent_corpus",
    );
    expect(report.gates.minimum_family_count.pass).toBe(false);
  });
});
