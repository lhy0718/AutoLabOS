#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/u;
const ABSOLUTE_PATH_PATTERN = /(?:^|\s)(?:\/[\w.-]+\/|[A-Za-z]:\\)/u;

export function validateLiteratureEvidenceManifest(manifest) {
  const reasonCodes = [];
  const affected = [];
  const sources = Array.isArray(manifest?.source_ledger) ? manifest.source_ledger : [];
  const policy = manifest?.verification_policy;

  if (manifest?.schema_version !== "1.0") {
    add(reasonCodes, affected, "manifest_schema_invalid", "schema_version");
  }
  if (manifest?.artifact_type !== "primary_source_full_text_manifest") {
    add(reasonCodes, affected, "manifest_artifact_type_invalid", "artifact_type");
  }
  if (
    policy?.primary_sources_only !== true
    || policy?.search_results_count_as_verification !== false
    || policy?.abstract_only_sources_can_close_residual_claim_gate !== false
    || !Number.isInteger(policy?.minimum_full_text_sources)
    || policy.minimum_full_text_sources < 1
    || !Array.isArray(policy?.required_roles)
    || policy.required_roles.length === 0
  ) {
    add(reasonCodes, affected, "verification_policy_invalid", "verification_policy");
  }
  if (sources.length < (policy?.minimum_full_text_sources ?? Number.POSITIVE_INFINITY)) {
    add(reasonCodes, affected, "full_text_source_floor_not_met", "source_ledger");
  }

  const sourceIds = new Set();
  const sourceUrls = new Set();
  const pdfHashes = new Set();
  const observedRoles = new Set();
  for (const [index, source] of sources.entries()) {
    const label = `source_ledger[${index}]`;
    if (!nonempty(source?.source_id) || sourceIds.has(source.source_id)) {
      add(reasonCodes, affected, "source_id_invalid_or_duplicate", `${label}.source_id`);
    } else {
      sourceIds.add(source.source_id);
    }
    if (!nonempty(source?.title) || !nonempty(source?.first_page_title) || source.title !== source.first_page_title) {
      add(reasonCodes, affected, "source_title_gate_failed", `${label}.title`);
    }
    if (!nonempty(source?.authors) || !nonempty(source?.publication_status)) {
      add(reasonCodes, affected, "source_metadata_incomplete", label);
    }
    if (!validHttpsUrl(source?.primary_url) || sourceUrls.has(source.primary_url)) {
      add(reasonCodes, affected, "primary_url_invalid_or_duplicate", `${label}.primary_url`);
    } else {
      sourceUrls.add(source.primary_url);
    }
    if (!validHttpsUrl(source?.pdf_url)) {
      add(reasonCodes, affected, "pdf_url_invalid", `${label}.pdf_url`);
    }
    if (!safeCacheName(source?.cache_file)) {
      add(reasonCodes, affected, "pdf_cache_name_invalid", `${label}.cache_file`);
    }
    if (!SHA256_PATTERN.test(source?.pdf_sha256 ?? "") || pdfHashes.has(source.pdf_sha256)) {
      add(reasonCodes, affected, "pdf_hash_invalid_or_duplicate", `${label}.pdf_sha256`);
    } else {
      pdfHashes.add(source.pdf_sha256);
    }
    if (!Number.isInteger(source?.pdf_bytes) || source.pdf_bytes < 1) {
      add(reasonCodes, affected, "pdf_size_invalid", `${label}.pdf_bytes`);
    }
    if (!Number.isInteger(source?.pdf_pages) || source.pdf_pages < 1 || source?.media_type !== "application/pdf") {
      add(reasonCodes, affected, "pdf_shape_invalid", label);
    }
    if (!nonempty(source?.verification_depth) || /abstract|metadata|search result/iu.test(source.verification_depth)) {
      add(reasonCodes, affected, "verification_depth_not_full_text", `${label}.verification_depth`);
    }
    for (const field of ["evidence_locations", "verified_facts", "absorbed_claims", "unresolved_scope"]) {
      if (!nonemptyStringArray(source?.[field])) {
        add(reasonCodes, affected, "source_evidence_incomplete", `${label}.${field}`);
      }
    }
    if (!nonempty(source?.role)) {
      add(reasonCodes, affected, "source_role_missing", `${label}.role`);
    } else {
      observedRoles.add(source.role);
    }
  }

  for (const role of policy?.required_roles ?? []) {
    if (!nonempty(role) || !observedRoles.has(role)) {
      add(reasonCodes, affected, "required_source_role_missing", String(role));
    }
  }

  const codeSources = Array.isArray(manifest?.code_source_ledger)
    ? manifest.code_source_ledger
    : [];
  for (const [index, source] of codeSources.entries()) {
    const label = `code_source_ledger[${index}]`;
    if (
      !nonempty(source?.source_id)
      || !validHttpsUrl(source?.repository_url)
      || !COMMIT_PATTERN.test(source?.commit ?? "")
      || !nonempty(source?.path)
      || !SHA256_PATTERN.test(source?.sha256 ?? "")
      || !nonemptyStringArray(source?.evidence_locations)
      || !nonemptyStringArray(source?.verified_facts)
    ) {
      add(reasonCodes, affected, "code_source_evidence_invalid", label);
    }
  }

  const residual = manifest?.residual_claim;
  if (
    !nonempty(residual?.text)
    || !nonempty(residual?.support_condition)
    || !nonempty(residual?.evidence_ceiling)
  ) {
    add(reasonCodes, affected, "residual_claim_contract_invalid", "residual_claim");
  }

  const serialized = JSON.stringify(manifest);
  if (ABSOLUTE_PATH_PATTERN.test(serialized)) {
    add(reasonCodes, affected, "nonportable_absolute_path_present", "manifest");
  }

  return {
    valid: reasonCodes.length === 0,
    source_count: sources.length,
    code_source_count: codeSources.length,
    observed_roles: [...observedRoles].sort(),
    reason_codes: [...new Set(reasonCodes)],
    affected_fields: [...new Set(affected)].sort()
  };
}

export async function auditLiteratureEvidenceManifest({
  manifest,
  sourceDir,
  requireSourceCache = false
}) {
  const report = validateLiteratureEvidenceManifest(manifest);
  if (!sourceDir) {
    const reasonCodes = requireSourceCache
      ? [...report.reason_codes, "source_cache_required"]
      : report.reason_codes;
    const affected = requireSourceCache
      ? [...report.affected_fields, "source_ledger"]
      : report.affected_fields;
    return {
      ...report,
      valid: report.valid && !requireSourceCache,
      source_cache_verified: false,
      verified_cache_files: 0,
      reason_codes: [...new Set(reasonCodes)],
      affected_fields: [...new Set(affected)].sort()
    };
  }

  const reasonCodes = [...report.reason_codes];
  const affected = [...report.affected_fields];
  let verifiedCacheFiles = 0;
  const root = path.resolve(sourceDir);
  for (const [index, source] of (manifest?.source_ledger ?? []).entries()) {
    const label = `source_ledger[${index}].cache_file`;
    if (!safeCacheName(source?.cache_file)) {
      continue;
    }
    const candidate = path.resolve(root, source.cache_file);
    if (path.dirname(candidate) !== root) {
      add(reasonCodes, affected, "pdf_cache_path_escape", label);
      continue;
    }
    let bytes;
    try {
      const metadata = await fs.lstat(candidate);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("not a direct regular file");
      }
      bytes = await fs.readFile(candidate);
    } catch {
      add(reasonCodes, affected, "pdf_cache_file_missing_or_invalid", label);
      continue;
    }
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      add(reasonCodes, affected, "pdf_cache_magic_invalid", label);
    }
    if (bytes.length !== source.pdf_bytes) {
      add(reasonCodes, affected, "pdf_cache_size_mismatch", label);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== source.pdf_sha256) {
      add(reasonCodes, affected, "pdf_cache_hash_mismatch", label);
    }
    if (!affected.includes(label)) {
      verifiedCacheFiles += 1;
    }
  }

  return {
    ...report,
    valid: reasonCodes.length === 0,
    source_cache_verified:
      reasonCodes.length === 0 && verifiedCacheFiles === report.source_count,
    verified_cache_files: verifiedCacheFiles,
    reason_codes: [...new Set(reasonCodes)],
    affected_fields: [...new Set(affected)].sort()
  };
}

function add(reasonCodes, affected, code, field) {
  reasonCodes.push(code);
  affected.push(field);
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function nonemptyStringArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonempty);
}

function validHttpsUrl(value) {
  if (!nonempty(value)) {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function safeCacheName(value) {
  return nonempty(value)
    && path.basename(value) === value
    && /^[A-Za-z0-9][A-Za-z0-9._-]*\.pdf$/u.test(value);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length;) {
    const flag = args[index];
    if (flag === "--require-source-cache") {
      parsed["require-source-cache"] = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (!["--manifest", "--source-dir"].includes(flag) || !value) {
      throw new Error(
        "Usage: validate-literature-evidence.mjs --manifest <path> [--source-dir <pdf-cache>] [--require-source-cache]"
      );
    }
    parsed[flag.slice(2)] = path.resolve(value);
    index += 2;
  }
  if (!parsed.manifest) {
    throw new Error(
      "Usage: validate-literature-evidence.mjs --manifest <path> [--source-dir <pdf-cache>] [--require-source-cache]"
    );
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const manifest = JSON.parse(await fs.readFile(args.manifest, "utf8"));
    const report = await auditLiteratureEvidenceManifest({
      manifest,
      sourceDir: args["source-dir"],
      requireSourceCache: args["require-source-cache"] === true
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.valid) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
