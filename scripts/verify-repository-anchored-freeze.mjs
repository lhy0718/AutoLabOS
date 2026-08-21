#!/usr/bin/env node

import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";

export async function auditRepositoryAnchoredFreeze(input) {
  const reasonCodes = [];
  const details = [];
  const repositoryRoot = await directRealPath(input.repositoryRoot, "repository", reasonCodes);
  const freezePath = await directRealPath(input.freezePath, "freeze", reasonCodes);
  if (!repositoryRoot || !freezePath || !isPathInsideOrEqual(freezePath, repositoryRoot)) {
    if (freezePath && repositoryRoot && !isPathInsideOrEqual(freezePath, repositoryRoot)) {
      reasonCodes.push("freeze_outside_repository");
    }
    return result(false, undefined, undefined, 0, 0, reasonCodes, details);
  }

  const topLevel = gitText(repositoryRoot, ["rev-parse", "--show-toplevel"]);
  if (!topLevel || path.resolve(topLevel) !== repositoryRoot) {
    reasonCodes.push("repository_git_root_invalid");
    return result(false, undefined, undefined, 0, 0, reasonCodes, details);
  }
  const commitSha = normalizeCommit(input.commitSha)
    || normalizeCommit(gitText(repositoryRoot, ["rev-parse", "HEAD"]));
  if (!commitSha || !gitSucceeded(repositoryRoot, ["cat-file", "-e", `${commitSha}^{commit}`])) {
    reasonCodes.push("repository_commit_invalid");
    return result(false, commitSha, undefined, 0, 0, reasonCodes, details);
  }

  let freeze;
  let freezeBytes;
  try {
    freezeBytes = await fs.readFile(freezePath);
    freeze = JSON.parse(freezeBytes.toString("utf8"));
  } catch {
    reasonCodes.push("freeze_receipt_invalid");
    return result(false, commitSha, undefined, 0, 0, reasonCodes, details);
  }
  const freezeSha256 = sha256(freezeBytes);
  const files = freeze?.files;
  const anchor = freeze?.repository_anchor;
  if (
    freeze?.schema_version !== "1.0"
    || typeof files !== "object"
    || files === null
    || Array.isArray(files)
    || anchor?.required !== true
    || anchor?.tracked_commit_required !== true
    || !Array.isArray(anchor?.generated_files)
  ) {
    reasonCodes.push("freeze_repository_anchor_contract_invalid");
    return result(false, commitSha, freezeSha256, 0, 0, reasonCodes, details);
  }
  const generatedFiles = new Set(anchor.generated_files);
  if (
    generatedFiles.size !== anchor.generated_files.length
    || [...generatedFiles].some((relative) => typeof relative !== "string" || !(relative in files))
  ) {
    reasonCodes.push("freeze_generated_file_contract_invalid");
  }

  const freezeRepositoryPath = path.relative(repositoryRoot, freezePath).split(path.sep).join("/");
  const committedFreeze = gitBytes(repositoryRoot, ["show", `${commitSha}:${freezeRepositoryPath}`]);
  if (!committedFreeze) {
    reasonCodes.push("freeze_not_tracked_at_commit");
  } else if (!committedFreeze.equals(freezeBytes)) {
    reasonCodes.push("freeze_differs_from_commit");
  }

  let trackedFileCount = 0;
  let generatedFileCount = 0;
  for (const [relative, expected] of Object.entries(files)) {
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/u.test(expected)) {
      reasonCodes.push("freeze_binding_invalid");
      details.push(relative);
      continue;
    }
    const candidate = path.resolve(path.dirname(freezePath), relative);
    if (!isPathInsideOrEqual(candidate, repositoryRoot)) {
      reasonCodes.push("freeze_binding_outside_repository");
      details.push(relative);
      continue;
    }
    const direct = await directRealPath(candidate, "bound_file", reasonCodes);
    if (!direct) {
      details.push(relative);
      continue;
    }
    const currentBytes = await fs.readFile(direct);
    if (sha256(currentBytes) !== expected) {
      reasonCodes.push("freeze_binding_current_hash_mismatch");
      details.push(relative);
      continue;
    }
    if (generatedFiles.has(relative)) {
      generatedFileCount += 1;
      continue;
    }
    trackedFileCount += 1;
    const repositoryPath = path.relative(repositoryRoot, direct).split(path.sep).join("/");
    const committedBytes = gitBytes(repositoryRoot, ["show", `${commitSha}:${repositoryPath}`]);
    if (!committedBytes) {
      reasonCodes.push("freeze_binding_not_tracked_at_commit");
      details.push(relative);
    } else if (sha256(committedBytes) !== expected || !committedBytes.equals(currentBytes)) {
      reasonCodes.push("freeze_binding_differs_from_commit");
      details.push(relative);
    }
  }

  return result(
    reasonCodes.length === 0,
    commitSha,
    freezeSha256,
    trackedFileCount,
    generatedFileCount,
    reasonCodes,
    details
  );
}

function result(valid, commitSha, freezeSha256, trackedFileCount, generatedFileCount, reasonCodes, details) {
  return {
    valid,
    ...(commitSha ? { commit_sha: commitSha } : {}),
    ...(freezeSha256 ? { freeze_sha256: freezeSha256 } : {}),
    tracked_file_count: trackedFileCount,
    generated_file_count: generatedFileCount,
    reason_codes: [...new Set(reasonCodes)],
    affected_bindings: [...new Set(details)].sort()
  };
}

async function directRealPath(candidate, label, reasonCodes) {
  const absolute = path.resolve(candidate);
  try {
    const [realPath, metadata] = await Promise.all([fs.realpath(absolute), fs.lstat(absolute)]);
    if (realPath !== absolute || metadata.isSymbolicLink() || (!metadata.isFile() && !metadata.isDirectory())) {
      reasonCodes.push(`${label}_path_invalid`);
      return undefined;
    }
    return realPath;
  } catch {
    reasonCodes.push(`${label}_path_invalid`);
    return undefined;
  }
}

function normalizeCommit(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[a-f0-9]{40,64}$/u.test(normalized) ? normalized : undefined;
}

function gitText(root, args) {
  const output = gitBytes(root, args);
  return output ? output.toString("utf8").trim() : undefined;
}

function gitBytes(root, args) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024
  });
  return result.status === 0 && Buffer.isBuffer(result.stdout) ? result.stdout : undefined;
}

function gitSucceeded(root, args) {
  return spawnSync("git", args, { cwd: root, stdio: "ignore" }).status === 0;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isPathInsideOrEqual(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!["--repository", "--freeze", "--commit"].includes(flag) || !value) {
      throw new Error(
        "Usage: verify-repository-anchored-freeze.mjs --repository <root> --freeze <receipt> [--commit <sha>]"
      );
    }
    parsed[flag.slice(2)] = value;
  }
  if (!parsed.repository || !parsed.freeze) {
    throw new Error(
      "Usage: verify-repository-anchored-freeze.mjs --repository <root> --freeze <receipt> [--commit <sha>]"
    );
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const audit = await auditRepositoryAnchoredFreeze({
      repositoryRoot: args.repository,
      freezePath: args.freeze,
      commitSha: args.commit
    });
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
    if (!audit.valid) {
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
