import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";

const MANIFEST_NAME = "public-source-snapshot.json";
const TEXT_SCAN_LIMIT_BYTES = 16 * 1024 * 1024;
const PLACEHOLDER_HOME_SEGMENTS = new Set(["demo", "example", "sample", "test", "user"]);
const PLACEHOLDER_SECRET_PREFIXES = ["${", "<", "changeme", "placeholder", "replace", "your"];
const PLACEHOLDER_SECRET_MARKERS = new Set([
  "dummy",
  "env",
  "example",
  "existing",
  "fake",
  "file",
  "fixture",
  "process",
  "sample",
  "test",
  "wizard"
]);

export async function exportPublicSourceSnapshot({ cwd = process.cwd(), outDir, ref = "HEAD" } = {}) {
  if (typeof outDir !== "string" || outDir.trim().length === 0) {
    throw new Error("--out-dir is required");
  }
  if (typeof ref !== "string" || ref.trim().length === 0 || ref.length > 200) {
    throw new Error("ref must be a non-empty Git revision no longer than 200 characters");
  }

  const repoRoot = await resolveRepositoryRoot(cwd);
  assertCleanWorkingTree(repoRoot);
  const revision = runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  const resolvedOutDir = await resolveFreshOutputDirectory(repoRoot, cwd, outDir);
  const stagingRoot = await mkdtemp(path.join(tmpdir(), "autolabos-public-source-"));
  const archivePath = path.join(stagingRoot, "source.tar");
  let outputCreated = false;

  try {
    runGit(repoRoot, ["archive", "--format=tar", `--output=${archivePath}`, revision]);
    await mkdir(resolvedOutDir);
    outputCreated = true;
    runCommand("tar", ["-xf", archivePath, "-C", resolvedOutDir], repoRoot);

    const entries = await collectEntries(resolvedOutDir);
    const findings = await scanEntries(entries, {
      repoRoot,
      homeDir: homedir()
    });
    if (findings.length > 0) {
      const summary = findings.map((finding) => `${finding.path} (${finding.rule})`).join(", ");
      throw new Error(`public source scan rejected ${findings.length} finding(s): ${summary}`);
    }

    const files = entries.map(({ absolutePath: _absolutePath, ...entry }) => entry);
    const manifest = {
      schema_version: 1,
      kind: "autolabos_public_source_snapshot",
      generator: "scripts/export-public-snapshot.mjs",
      source: {
        requested_ref: ref,
        revision,
        working_tree_clean: true
      },
      history_included: false,
      file_count: files.length,
      tree_sha256: hashTree(files),
      scan: {
        portable: true,
        findings: 0,
        rules: [
          "git_metadata_excluded",
          "personal_home_path_excluded",
          "credential_material_excluded",
          "unsafe_symlink_excluded"
        ]
      },
      files
    };
    await writeFile(path.join(resolvedOutDir, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { ...manifest, output_dir: resolvedOutDir };
  } catch (error) {
    if (outputCreated) {
      await rm(resolvedOutDir, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function resolveRepositoryRoot(cwd) {
  const root = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
  return realpath(root);
}

function assertCleanWorkingTree(repoRoot) {
  const status = runGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim().length > 0) {
    throw new Error("working tree must be clean before exporting a public source snapshot");
  }
}

async function resolveFreshOutputDirectory(repoRoot, cwd, outDir) {
  const requested = path.resolve(cwd, outDir);
  if (isWithin(repoRoot, requested)) {
    throw new Error("--out-dir must be outside the source repository");
  }
  await assertPathMissing(requested);
  await mkdir(path.dirname(requested), { recursive: true });
  const parent = await realpath(path.dirname(requested));
  const resolved = path.join(parent, path.basename(requested));
  if (isWithin(repoRoot, resolved)) {
    throw new Error("--out-dir must be outside the source repository");
  }
  await assertPathMissing(resolved);
  return resolved;
}

async function assertPathMissing(target) {
  try {
    await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("--out-dir must name a new directory");
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function collectEntries(root) {
  const entries = [];
  await walk(root, "", entries);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root, relativeDir, entries) {
  const absoluteDir = path.join(root, relativeDir);
  const children = await readdir(absoluteDir, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const relativePath = path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), child.name);
    if (relativePath === ".git" || relativePath.startsWith(".git/")) {
      throw new Error("Git metadata must not be present in a public source snapshot");
    }
    const absolutePath = path.join(root, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isDirectory()) {
      await walk(root, relativePath, entries);
      continue;
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      const resolvedTarget = path.resolve(path.dirname(absolutePath), target);
      if (path.isAbsolute(target) || !isWithin(root, resolvedTarget)) {
        entries.push({
          path: relativePath,
          kind: "unsafe_symlink",
          mode: metadata.mode & 0o777,
          size: Buffer.byteLength(target),
          sha256: hashBytes(Buffer.from(`symlink\0${target}`)),
          absolutePath
        });
        continue;
      }
      entries.push({
        path: relativePath,
        kind: "symlink",
        mode: metadata.mode & 0o777,
        size: Buffer.byteLength(target),
        sha256: hashBytes(Buffer.from(`symlink\0${target}`)),
        absolutePath
      });
      continue;
    }
    if (!metadata.isFile()) {
      throw new Error(`unsupported source entry type: ${relativePath}`);
    }
    const bytes = await readFile(absolutePath);
    entries.push({
      path: relativePath,
      kind: "file",
      mode: metadata.mode & 0o777,
      size: bytes.length,
      sha256: hashBytes(bytes),
      absolutePath
    });
  }
}

async function scanEntries(entries, { repoRoot, homeDir }) {
  const findings = [];
  for (const entry of entries) {
    if (entry.kind === "unsafe_symlink") {
      findings.push({ path: entry.path, rule: "unsafe_symlink" });
      continue;
    }
    if (entry.kind !== "file" || entry.size > TEXT_SCAN_LIMIT_BYTES) {
      continue;
    }
    const bytes = await readFile(entry.absolutePath);
    if (bytes.includes(0)) {
      continue;
    }
    const text = bytes.toString("utf8");
    const rules = scanText(text, { repoRoot, homeDir });
    findings.push(...rules.map((rule) => ({ path: entry.path, rule })));
  }
  return findings;
}

function scanText(text, { repoRoot, homeDir }) {
  const rules = new Set();
  if (text.includes(repoRoot) || (homeDir.length > 1 && text.includes(`${homeDir}${path.sep}`))) {
    rules.add("personal_home_path");
  }

  for (const match of text.matchAll(/\/(?:Users|home)\/([A-Za-z0-9._-]+)\//gu)) {
    if (!PLACEHOLDER_HOME_SEGMENTS.has(match[1].toLowerCase())) {
      rules.add("personal_home_path");
    }
  }
  for (const match of text.matchAll(/[A-Za-z]:\\Users\\([A-Za-z0-9._-]+)\\/gu)) {
    if (!PLACEHOLDER_HOME_SEGMENTS.has(match[1].toLowerCase())) {
      rules.add("personal_home_path");
    }
  }

  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(text)) {
    rules.add("private_key_material");
  }
  const tokenPatterns = [
    /\bAKIA[0-9A-Z]{16}\b/gu,
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/gu,
    /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu
  ];
  if (tokenPatterns.some((pattern) => pattern.test(text))) {
    rules.add("credential_token");
  }

  const assignmentPatterns = [
    /\b[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*["']([^"'\r\n]+)["']/gu,
    /^(?:export\s+)?[A-Z][A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|PRIVATE_KEY)\s*=\s*([^\s#"'`]+)\s*$/gmu
  ];
  for (const assignmentPattern of assignmentPatterns) {
    for (const match of text.matchAll(assignmentPattern)) {
      const value = match[1].replace(/[;,}]$/u, "").toLowerCase();
      if (value.length >= 8 && !isPlaceholderSecret(value)) {
        rules.add("credential_assignment");
      }
    }
  }
  return [...rules];
}

function isPlaceholderSecret(value) {
  if (PLACEHOLDER_SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  return value.split(/[-_.]/u).some((part) => PLACEHOLDER_SECRET_MARKERS.has(part));
}

function hashTree(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.kind}\0${file.mode.toString(8)}\0${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return hash.digest("hex");
}

function hashBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function runGit(cwd, args) {
  return runCommand("git", args, cwd);
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    throw new Error(`${command} failed: ${detail}`);
  }
  return result.stdout;
}
