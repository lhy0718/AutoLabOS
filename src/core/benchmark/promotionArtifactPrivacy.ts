import path from "node:path";

const MAX_SCANNABLE_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_JSON_NODES = 1_000_000;
const MAX_JSON_DEPTH = 512;

const SENSITIVE_PATH_PATTERN = /(?:^|\/)(?:\.env(?:\..*)?|.*api[-_]?keys?.*|.*credentials?.*|.*private[-_]?keys?.*|.*secrets?.*|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|p12|pfx|key))$/iu;
const SENSITIVE_FIELD_PATTERN = /^(?:api[-_]?keys?|access[-_]?tokens?|refresh[-_]?tokens?|auth[-_]?tokens?|client[-_]?secrets?|passwords?|private[-_]?keys?|credentials?|secrets?)$/iu;
const PRIVATE_PATH_ROOTS = [
  String.fromCharCode(47, 104, 111, 109, 101, 47),
  String.fromCharCode(47, 85, 115, 101, 114, 115, 47),
  String.fromCharCode(47, 109, 110, 116, 47),
  String.fromCharCode(47, 116, 109, 112, 47),
  "[A-Za-z]:\\\\"
].join("|");
const PRIVATE_PATH_PATTERN = new RegExp(
  `(?:^|[\\s\"'=:])(?:${PRIVATE_PATH_ROOTS})`,
  "u"
);
const PRIVATE_PATH_VALUE_PATTERN = new RegExp(
  `(^|[\\s\"'=:])(?:${PRIVATE_PATH_ROOTS})[^\\s\"'<>\\]}),;]*`,
  "gu"
);
const SECRET_TEXT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bsk-[A-Za-z0-9_-]{16,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/iu,
  /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|client[-_]?secret|password|private[-_]?key|credential|secret)\s*[:=]\s*["']?[A-Za-z0-9_+\/=.-]{8,}/iu
] as const;

export function assertPromotionArtifactPrivacySafe(relativePath: string, bytes: Uint8Array): void {
  const text = inspectCredentialSafety(relativePath, bytes);
  if (text !== null && containsPrivateMachinePath(relativePath, text)) {
    throw new Error(`Selected source file contains a private machine path and cannot be included: ${relativePath}`);
  }
}

export function projectPromotionReviewerArtifact(
  relativePath: string,
  bytes: Uint8Array
): { bytes: Uint8Array; privacy_redaction_count: number } {
  const text = inspectCredentialSafety(relativePath, bytes);
  if (text === null) throw new Error(`Reviewer artifact must be UTF-8 text: ${relativePath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Reviewer artifact must be valid JSON: ${relativePath}`);
  }
  const state = { nodes: 0, redactions: 0 };
  const projected = redactPrivatePathsInJson(parsed, state, 0);
  if (state.redactions === 0) return { bytes, privacy_redaction_count: 0 };
  return {
    bytes: Buffer.from(`${JSON.stringify(projected, null, 2)}\n`, "utf8"),
    privacy_redaction_count: state.redactions
  };
}

function inspectCredentialSafety(relativePath: string, bytes: Uint8Array): string | null {
  const portablePath = relativePath.replace(/\\/gu, "/");
  if (!relativePath || path.isAbsolute(relativePath) || SENSITIVE_PATH_PATTERN.test(portablePath)) {
    throw new Error(`Selected source path is sensitive and cannot be included: ${relativePath}`);
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192));
  if (sample.includes(0)) return null;
  if (bytes.length > MAX_SCANNABLE_TEXT_BYTES) {
    throw new Error(`Selected text file is too large for a complete privacy scan: ${relativePath}`);
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error(`Selected source file contains a credential-like value and cannot be included: ${relativePath}`);
  }
  if (relativePath.toLowerCase().endsWith(".json")) {
    try {
      const sensitiveField = findSensitiveJsonField(JSON.parse(text) as unknown);
      if (sensitiveField) {
        throw new Error(`Selected source file contains a credential-like JSON field and cannot be included: ${relativePath} (${sensitiveField})`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Selected source file contains")) throw error;
    }
  }
  return text;
}

function redactPrivatePathsInJson(
  value: unknown,
  state: { nodes: number; redactions: number },
  depth: number
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new Error("Selected source file is too deeply nested for a complete privacy projection.");
  }
  if (typeof value === "string") {
    return redactPrivatePathsInString(value, state);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactPrivatePathsInJson(entry, state, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  const projected: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const baseKey = redactPrivatePathsInString(key, state);
    let projectedKey = baseKey;
    let collision = 2;
    while (Object.prototype.hasOwnProperty.call(projected, projectedKey)) {
      projectedKey = `${baseKey}#${collision}`;
      collision += 1;
    }
    projected[projectedKey] = redactPrivatePathsInJson(entry, state, depth + 1);
  }
  return projected;
}

function redactPrivatePathsInString(value: string, state: { redactions: number }): string {
  return value.replace(PRIVATE_PATH_VALUE_PATTERN, (_match, prefix: string) => {
    state.redactions += 1;
    return `${prefix}<private-path>`;
  });
}

function containsPrivateMachinePath(relativePath: string, text: string): boolean {
  if (!relativePath.toLowerCase().endsWith(".json")) return PRIVATE_PATH_PATTERN.test(text);
  try {
    const pending: unknown[] = [JSON.parse(text) as unknown];
    let visited = 0;
    while (pending.length > 0) {
      visited += 1;
      if (visited > MAX_JSON_NODES) {
        throw new Error("Selected source file contains too many JSON nodes for a complete privacy scan.");
      }
      const value = pending.pop();
      if (typeof value === "string") {
        if (PRIVATE_PATH_PATTERN.test(value)) return true;
      } else if (Array.isArray(value)) {
        pending.push(...value);
      } else if (value && typeof value === "object") {
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
          if (PRIVATE_PATH_PATTERN.test(key)) return true;
          pending.push(entry);
        }
      }
    }
    return false;
  } catch (error) {
    if (error instanceof SyntaxError) return PRIVATE_PATH_PATTERN.test(text);
    throw error;
  }
}

function findSensitiveJsonField(root: unknown): string | null {
  const pending: Array<{ value: unknown; ref: string }> = [{ value: root, ref: "$" }];
  let visited = 0;
  while (pending.length > 0) {
    visited += 1;
    if (visited > MAX_JSON_NODES) {
      throw new Error("Selected source file contains too many JSON nodes for a complete privacy scan.");
    }
    const current = pending.pop()!;
    if (Array.isArray(current.value)) {
      for (let index = 0; index < current.value.length; index += 1) {
        pending.push({ value: current.value[index], ref: `${current.ref}[${index}]` });
      }
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    for (const [key, value] of Object.entries(current.value as Record<string, unknown>)) {
      const ref = `${current.ref}.${key}`;
      if (SENSITIVE_FIELD_PATTERN.test(key) && hasSensitiveValue(value)) return ref;
      pending.push({ value, ref });
    }
  }
  return null;
}

function hasSensitiveValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "bigint") return true;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value as Record<string, unknown>).length > 0);
}
