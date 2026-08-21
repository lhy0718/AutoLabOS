import { extractLiteratureTermSequence } from "./runConstraints.js";

export const TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION = 9 as const;
export const TOPIC_DISCOVERY_CANDIDATE_RECALL_SEMANTICS_VERSION = 8 as const;

export const TOPIC_DISCOVERY_MINIMUM_AXIS_MATCHES = 2;
export const TOPIC_DISCOVERY_MINIMUM_AXIS_MATCH_RATIO = 2 / 3;

const TOPIC_DISCOVERY_OBJECT_STOPWORDS: string[] = [
  "paper",
  "papers",
  "review",
  "reviews"
];
const TOPIC_DISCOVERY_OBJECT_INTERIOR_STOPWORDS: string[] = [
  "research"
];

export function normalizeTopicDiscoveryScientificTerms(value: string): string[] {
  return extractLiteratureTermSequence(value)
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
}

export function normalizeTopicDiscoveryScientificObjectTerms(
  value: string
): string[] {
  return extractLiteratureTermSequence(value, {
    preserveStopwords: TOPIC_DISCOVERY_OBJECT_STOPWORDS,
    preserveInteriorStopwords: TOPIC_DISCOVERY_OBJECT_INTERIOR_STOPWORDS
  })
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
}

export function normalizeTopicDiscoveryCandidateTerms(value: string): string[] {
  const terms = extractLiteratureTermSequence(normalizeCandidateRecallPhrases(value))
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
  return terms;
}

export function normalizeTopicDiscoveryCandidateObjectTerms(value: string): string[] {
  return extractLiteratureTermSequence(normalizeCandidateRecallPhrases(value), {
    preserveStopwords: TOPIC_DISCOVERY_OBJECT_STOPWORDS,
    preserveInteriorStopwords: TOPIC_DISCOVERY_OBJECT_INTERIOR_STOPWORDS
  })
    .map(normalizeTopicDiscoveryScientificTerm)
    .filter(Boolean);
}

export function resolveTopicDiscoveryRequiredAxisMatches(
  axisTerms: string[]
): number {
  const normalizedAxisCount = new Set(
    normalizeTopicDiscoveryCandidateTerms(axisTerms.join(" "))
  ).size;
  if (normalizedAxisCount === 0) {
    return 0;
  }
  return Math.min(
    normalizedAxisCount,
    Math.max(
      Math.min(TOPIC_DISCOVERY_MINIMUM_AXIS_MATCHES, normalizedAxisCount),
      Math.ceil(normalizedAxisCount * TOPIC_DISCOVERY_MINIMUM_AXIS_MATCH_RATIO)
    )
  );
}

export function countTopicDiscoveryCandidateTitleSupport(
  axisTerms: string[],
  candidateTitles: string[]
): number {
  const normalizedAxisTerms = [
    ...new Set(normalizeTopicDiscoveryCandidateTerms(axisTerms.join(" ")))
  ];
  const requiredMatches = resolveTopicDiscoveryRequiredAxisMatches(normalizedAxisTerms);
  if (requiredMatches === 0) {
    return 0;
  }
  const uniqueNormalizedTitles = [
    ...new Set(
      candidateTitles
        .map((title) => normalizeTopicDiscoveryCandidateTerms(title).join(" "))
        .filter(Boolean)
    )
  ];
  return uniqueNormalizedTitles.filter((title) => {
    const titleTerms = new Set(title.split(" "));
    const matches = normalizedAxisTerms.filter((term) => titleTerms.has(term)).length;
    return matches >= requiredMatches;
  }).length;
}

function normalizeCandidateRecallPhrases(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\bllms?\b/giu, "language model")
    .replace(/\bagentic\b/giu, "agent")
    .replace(/\blimited(?:\s*-\s*|\s+)samples?\b/giu, "finite sample")
    .replace(/\bsamples?(?:\s*-\s*|\s+)limited\b/giu, "finite sample");
}

export function buildTopicDiscoveryCandidateFamilySignature(input: {
  sharedAnchorTerms?: string[];
  axisTerms: string[];
}): string {
  const sharedAnchorTerms = uniqueSorted(
    normalizeTopicDiscoveryScientificObjectTerms((input.sharedAnchorTerms ?? []).join(" "))
  );
  const anchorSet = new Set(sharedAnchorTerms);
  const axisTerms = uniqueSorted(
    normalizeTopicDiscoveryCandidateTerms(input.axisTerms.join(" "))
      .filter((term) => !anchorSet.has(term))
  );
  return JSON.stringify({ sharedAnchorTerms, axisTerms });
}

export function normalizeTopicDiscoveryScientificTerm(term: string): string {
  if (["automatic", "automation", "automat"].includes(term)) {
    return "automat";
  }
  if (["generate", "generat", "generative", "generation"].includes(term)) {
    return "generation";
  }
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
