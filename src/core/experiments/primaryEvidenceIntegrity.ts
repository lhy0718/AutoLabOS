export interface PrimaryEvidenceIntegrityInput {
  experimentMode?: string;
  runnerSource?: string;
  metricsText?: string;
}

const NON_EVIDENCE_TERM = /(?:^|[_ -])(?:synthetic|simulat(?:ed|ion)|smoke|mock|fallback)(?:$|[_ -])/iu;
const COMPLETED_STATUS = /^(?:completed|success|succeeded|ok)$/iu;

export function detectPrimaryEvidenceIntegrityViolation(
  input: PrimaryEvidenceIntegrityInput
): string | undefined {
  if (input.experimentMode !== "real_execution") {
    return undefined;
  }

  if (runnerCanPromoteNonEvidence(input.runnerSource || "")) {
    return buildViolation("runner source");
  }

  if (metricsPromoteNonEvidence(input.metricsText)) {
    return buildViolation("generated metrics");
  }

  return undefined;
}

function runnerCanPromoteNonEvidence(source: string): boolean {
  if (!source.trim()) {
    return false;
  }

  const lower = source.toLowerCase();
  const exposesNonEvidenceControls =
    /--(?:simulate|simulation-only|force-synthetic|smoke|smoke-test|mock|fallback-only)/u.test(lower);
  const hasNonEvidenceBackend =
    /(?:deterministic[_ -])?(?:fallback|simulation|synthetic|smoke|mock)[_ -](?:backend|metrics|output|data|dataset|examples|records|samples)/u.test(lower) ||
    /(?:backend|metrics|output|data|dataset|examples|records|samples)[_ -](?:fallback|simulation|synthetic|smoke|mock)/u.test(lower);
  const defaultsToNonEvidence =
    /(?:selected|default|recommended)?_?backend\s*=\s*["'][^"']*(?:fallback|simulation|synthetic|smoke|mock)[^"']*["']/u.test(lower) ||
    /return\s+(?:run|load|build|make|generate|simulate)_[a-z0-9_]*(?:fallback|simulation|synthetic|smoke|mock)[a-z0-9_]*\s*\(/u.test(lower) ||
    /["']fallback_used["']\s*:\s*true/u.test(lower);
  const canReportCompletion =
    /["']success["']\s*:\s*true/u.test(lower) ||
    /["']status["']\s*:\s*["'](?:completed|success|succeeded|ok)["']/u.test(lower) ||
    /return\s+0\b/u.test(lower);
  const explicitlyNonPromoting =
    /(?:diagnostic|validation)[_ -]only/u.test(lower) &&
    (/["']success["']\s*:\s*false/u.test(lower) ||
      /["']status["']\s*:\s*["'](?:failed|blocked|non_promoting)["']/u.test(lower));

  if (explicitlyNonPromoting || !canReportCompletion) {
    return false;
  }

  return (exposesNonEvidenceControls && hasNonEvidenceBackend && defaultsToNonEvidence) ||
    (hasNonEvidenceBackend && defaultsToNonEvidence);
}

function metricsPromoteNonEvidence(metricsText: string | undefined): boolean {
  if (!metricsText?.trim()) {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(metricsText);
  } catch {
    return false;
  }

  const facts = collectMetricFacts(parsed);
  return facts.completed && facts.nonEvidence;
}

function collectMetricFacts(value: unknown): { completed: boolean; nonEvidence: boolean } {
  if (Array.isArray(value)) {
    return value.reduce(
      (facts, item) => mergeFacts(facts, collectMetricFacts(item)),
      { completed: false, nonEvidence: false }
    );
  }

  if (!value || typeof value !== "object") {
    return { completed: false, nonEvidence: false };
  }

  let facts = { completed: false, nonEvidence: false };
  for (const [rawKey, item] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.toLowerCase();
    if (key === "success" && item === true) {
      facts.completed = true;
    }
    if (key === "status" && typeof item === "string" && COMPLETED_STATUS.test(item.trim())) {
      facts.completed = true;
    }

    const provenanceKey = /(?:^|_)(?:evidence|execution|validation|run|provider|provenance|backend|source|fallback|synthetic|simulated|simulation|smoke|mock)(?:_|$)/u.test(key);
    if (provenanceKey) {
      if (typeof item === "string" && NON_EVIDENCE_TERM.test(item.trim())) {
        facts.nonEvidence = true;
      }
      if (
        item === true &&
        /(?:fallback|synthetic|simulated|simulation|smoke|mock)/u.test(key)
      ) {
        facts.nonEvidence = true;
      }
    }

    facts = mergeFacts(facts, collectMetricFacts(item));
  }
  return facts;
}

function mergeFacts(
  left: { completed: boolean; nonEvidence: boolean },
  right: { completed: boolean; nonEvidence: boolean }
): { completed: boolean; nonEvidence: boolean } {
  return {
    completed: left.completed || right.completed,
    nonEvidence: left.nonEvidence || right.nonEvidence
  };
}

function buildViolation(surface: string): string {
  return [
    `Real-execution ${surface} can promote synthetic, simulated, smoke, mock, or fallback output/data as primary evidence.`,
    "Non-evidence runs must remain diagnostic-only and cannot satisfy governed experiment completion.",
    "Execute the real path, mark the bundle as non-promoting validation, or emit a blocked/failed result."
  ].join(" ");
}
