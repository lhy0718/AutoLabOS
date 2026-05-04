import path from "node:path";
import { promises as fs } from "node:fs";

import { GraphNodeId, GRAPH_NODE_ORDER } from "../../types.js";

export type RuntimeContractKind = "node_prompt" | "codex_skill";

export interface RuntimeContractMetadata {
  filePath: string;
  contract_version?: string;
  contract_kind?: string;
  runtime_contract?: string;
  node_id?: string;
  name?: string;
  gate?: string;
  validation?: string;
}

export interface RuntimeContractMetadataIssue {
  code: string;
  message: string;
  filePath: string;
}

export interface RuntimeContractMetadataReport {
  contracts: RuntimeContractMetadata[];
  issues: RuntimeContractMetadataIssue[];
}

export async function validateRuntimeContractMetadata(workspaceRoot: string): Promise<RuntimeContractMetadataReport> {
  const files = await collectRuntimeContractFiles(workspaceRoot);
  const contracts: RuntimeContractMetadata[] = [];
  const issues: RuntimeContractMetadataIssue[] = [];

  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf8");
    const metadata = parseFrontmatter(raw, filePath);
    contracts.push(metadata);
    issues.push(...validateContractMetadata(workspaceRoot, filePath, metadata));
  }

  return { contracts, issues };
}

async function collectRuntimeContractFiles(workspaceRoot: string): Promise<string[]> {
  const nodePromptDir = path.join(workspaceRoot, "node-prompts");
  const skillDir = path.join(workspaceRoot, ".codex", "skills");
  const files: string[] = [];

  for (const filePath of await listMarkdownFiles(nodePromptDir)) {
    files.push(filePath);
  }
  for (const filePath of await listSkillFiles(skillDir)) {
    files.push(filePath);
  }

  return files.sort();
}

async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dirPath);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .map((entry) => path.join(dirPath, entry));
}

async function listSkillFiles(dirPath: string): Promise<string[]> {
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dirPath, entry.name, "SKILL.md"));
}

function parseFrontmatter(raw: string, filePath: string): RuntimeContractMetadata {
  const metadata: RuntimeContractMetadata = { filePath };
  if (!raw.startsWith("---\n")) {
    return metadata;
  }

  const endIndex = raw.indexOf("\n---", 4);
  if (endIndex < 0) {
    return metadata;
  }
  const block = raw.slice(4, endIndex).split(/\r?\n/u);
  for (const line of block) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/u);
    if (!match) {
      continue;
    }
    const key = match[1] as keyof RuntimeContractMetadata;
    const value = stripQuotes(match[2] || "");
    metadata[key] = value as never;
  }
  return metadata;
}

function validateContractMetadata(
  workspaceRoot: string,
  filePath: string,
  metadata: RuntimeContractMetadata
): RuntimeContractMetadataIssue[] {
  const issues: RuntimeContractMetadataIssue[] = [];
  const expectedKind = expectedContractKind(workspaceRoot, filePath);
  if (!expectedKind) {
    return issues;
  }

  for (const field of ["contract_version", "contract_kind", "runtime_contract", "gate", "validation"] as const) {
    if (!metadata[field]) {
      issues.push({
        code: `runtime_contract_${field}_missing`,
        message: `${relative(workspaceRoot, filePath)} is missing runtime contract metadata field ${field}.`,
        filePath
      });
    }
  }

  if (metadata.contract_version && metadata.contract_version !== "1") {
    issues.push({
      code: "runtime_contract_version_unsupported",
      message: `${relative(workspaceRoot, filePath)} uses unsupported contract_version ${metadata.contract_version}.`,
      filePath
    });
  }
  if (metadata.contract_kind && metadata.contract_kind !== expectedKind) {
    issues.push({
      code: "runtime_contract_kind_mismatch",
      message: `${relative(workspaceRoot, filePath)} must declare contract_kind ${expectedKind}.`,
      filePath
    });
  }
  if (metadata.runtime_contract && metadata.runtime_contract !== "true") {
    issues.push({
      code: "runtime_contract_flag_invalid",
      message: `${relative(workspaceRoot, filePath)} must declare runtime_contract: true.`,
      filePath
    });
  }

  if (expectedKind === "node_prompt") {
    const expectedNode = path.basename(filePath, ".md") as GraphNodeId;
    if (!GRAPH_NODE_ORDER.includes(expectedNode) || metadata.node_id !== expectedNode) {
      issues.push({
        code: "runtime_contract_node_id_mismatch",
        message: `${relative(workspaceRoot, filePath)} must declare node_id ${expectedNode}.`,
        filePath
      });
    }
  } else if (!metadata.name) {
    issues.push({
      code: "runtime_contract_skill_name_missing",
      message: `${relative(workspaceRoot, filePath)} is missing skill name metadata.`,
      filePath
    });
  }

  return issues;
}

function expectedContractKind(workspaceRoot: string, filePath: string): RuntimeContractKind | undefined {
  const relativePath = relative(workspaceRoot, filePath);
  if (relativePath.startsWith("node-prompts/")) {
    return "node_prompt";
  }
  if (relativePath.startsWith(".codex/skills/") && path.basename(filePath) === "SKILL.md") {
    return "codex_skill";
  }
  return undefined;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function relative(workspaceRoot: string, filePath: string): string {
  return path.relative(workspaceRoot, filePath).replace(/\\/g, "/");
}
