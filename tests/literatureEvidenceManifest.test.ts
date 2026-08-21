import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  auditLiteratureEvidenceManifest,
  validateLiteratureEvidenceManifest
} from "../scripts/validate-literature-evidence.mjs";

function validManifest() {
  return {
    schema_version: "1.0",
    artifact_type: "primary_source_full_text_manifest",
    verification_policy: {
      primary_sources_only: true,
      search_results_count_as_verification: false,
      abstract_only_sources_can_close_residual_claim_gate: false,
      minimum_full_text_sources: 1,
      required_roles: ["direct_prior"]
    },
    source_ledger: [
      {
        source_id: "source_a",
        title: "A Full-Text Study",
        first_page_title: "A Full-Text Study",
        authors: "First Author and Second Author",
        publication_status: "peer-reviewed paper",
        primary_url: "https://example.invalid/paper",
        pdf_url: "https://example.invalid/paper.pdf",
        cache_file: "paper.pdf",
        pdf_sha256: "a".repeat(64),
        pdf_bytes: 1024,
        pdf_pages: 8,
        media_type: "application/pdf",
        verification_depth: "Full methods, experiments, results, limitations, and first page inspected",
        evidence_locations: ["PDF pp. 2-4: method and experiment"],
        verified_facts: ["The study evaluates a controlled comparison."],
        absorbed_claims: ["The task has an established baseline."],
        unresolved_scope: ["The target intervention remains untested."],
        role: "direct_prior"
      }
    ],
    code_source_ledger: [
      {
        source_id: "source_code",
        repository_url: "https://example.invalid/repository.git",
        commit: "b".repeat(40),
        path: "src/module.ts",
        sha256: "c".repeat(64),
        evidence_locations: ["lines 10-20: ordering policy"],
        verified_facts: ["Inputs are processed in a stable order."]
      }
    ],
    residual_claim: {
      text: "The intervention may improve the frozen outcome.",
      support_condition: "Only a held-out comparison can support the claim.",
      evidence_ceiling: "Development evidence can only nominate the method."
    }
  };
}

describe("literature evidence manifest", () => {
  it("accepts full-text primary-source evidence with explicit residual scope", () => {
    const report = validateLiteratureEvidenceManifest(validManifest());
    expect(report.valid).toBe(true);
    expect(report.source_count).toBe(1);
    expect(report.observed_roles).toEqual(["direct_prior"]);
  });

  it("rejects abstract-only evidence, title mismatches, and missing roles", () => {
    const manifest = validManifest();
    manifest.source_ledger[0].first_page_title = "A Different Paper";
    manifest.source_ledger[0].verification_depth = "Abstract and metadata inspected";
    manifest.verification_policy.required_roles = ["closest_prior"];

    const report = validateLiteratureEvidenceManifest(manifest);
    expect(report.valid).toBe(false);
    expect(report.reason_codes).toContain("source_title_gate_failed");
    expect(report.reason_codes).toContain("verification_depth_not_full_text");
    expect(report.reason_codes).toContain("required_source_role_missing");
  });

  it("rejects developer-machine absolute paths", () => {
    const manifest = validManifest();
    manifest.source_ledger[0].evidence_locations = [
      `Reviewed at ${["", "home", "operator", "private", "paper.pdf"].join("/")}`
    ];

    const report = validateLiteratureEvidenceManifest(manifest);
    expect(report.valid).toBe(false);
    expect(report.reason_codes).toContain("nonportable_absolute_path_present");
  });

  it("recomputes cached PDF size and hash when a source directory is supplied", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "literature-evidence-"));
    try {
      const bytes = Buffer.from("%PDF-1.7\nfixture\n", "utf8");
      await fs.writeFile(path.join(root, "paper.pdf"), bytes);
      const manifest = validManifest();
      manifest.source_ledger[0].pdf_bytes = bytes.length;
      manifest.source_ledger[0].pdf_sha256 = createHash("sha256")
        .update(bytes)
        .digest("hex");

      const valid = await auditLiteratureEvidenceManifest({ manifest, sourceDir: root });
      expect(valid.valid).toBe(true);
      expect(valid.source_cache_verified).toBe(true);

      await fs.writeFile(
        path.join(root, "paper.pdf"),
        Buffer.from("%PDF-1.7\nchanged and longer\n")
      );
      const changed = await auditLiteratureEvidenceManifest({ manifest, sourceDir: root });
      expect(changed.valid).toBe(false);
      expect(changed.reason_codes).toContain("pdf_cache_size_mismatch");
      expect(changed.reason_codes).toContain("pdf_cache_hash_mismatch");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a downstream review requires an unavailable PDF cache", async () => {
    const report = await auditLiteratureEvidenceManifest({
      manifest: validManifest(),
      requireSourceCache: true
    });
    expect(report.valid).toBe(false);
    expect(report.source_cache_verified).toBe(false);
    expect(report.reason_codes).toContain("source_cache_required");
  });
});
