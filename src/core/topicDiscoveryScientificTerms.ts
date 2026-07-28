import { extractLiteratureTermSequence } from "./runConstraints.js";

export const TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION = 2 as const;
export const TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION = 5 as const;

export function normalizeTopicDiscoveryScientificTerms(value: string): string[] {
  return extractLiteratureTermSequence(value)
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
}

export function normalizeTopicDiscoveryCandidateTerms(value: string): string[] {
  const terms = extractLiteratureTermSequence(normalizeCandidateRecallPhrases(value))
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
  return terms;
}

function normalizeCandidateRecallPhrases(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\blimited(?:\s*-\s*|\s+)samples?\b/giu, "finite sample")
    .replace(/\bsamples?(?:\s*-\s*|\s+)limited\b/giu, "finite sample");
}

export function buildTopicDiscoveryCandidateFamilySignature(input: {
  sharedAnchorTerms?: string[];
  axisTerms: string[];
}): string {
  const sharedAnchorTerms = uniqueSorted(
    normalizeTopicDiscoveryScientificTerms((input.sharedAnchorTerms ?? []).join(" "))
  );
  const anchorSet = new Set(sharedAnchorTerms);
  const axisTerms = uniqueSorted(
    normalizeTopicDiscoveryCandidateTerms(input.axisTerms.join(" "))
      .filter((term) => !anchorSet.has(term))
  );
  return JSON.stringify({ sharedAnchorTerms, axisTerms });
}

export function normalizeTopicDiscoveryScientificTerm(term: string): string {
  if (["reliable", "reliability"].includes(term)) {
    return "reliability";
  }
  if (["independent", "independently", "independence"].includes(term)) {
    return "independence";
  }
  if (term === "sampl") {
    return "sampling";
  }
  if (["valid", "validity"].includes(term)) {
    return "validity";
  }
  if (["stable", "stability"].includes(term)) {
    return "stability";
  }
  if (["generaliz", "generalization"].includes(term)) {
    return "generalization";
  }
  if (["uncertain", "uncertainty"].includes(term)) {
    return "uncertainty";
  }
  if (["calibrat", "calibration"].includes(term)) {
    return "calibration";
  }
  if (["estimat", "estimation", "estimative"].includes(term)) {
    return "estimation";
  }
  if (term === "censu") {
    return "census";
  }
  return term;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}
