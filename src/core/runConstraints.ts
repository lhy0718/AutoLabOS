export interface CollectConstraintDefaults {
  dateRange?: string;
  year?: string;
  lastYears?: number;
  fieldsOfStudy?: string[];
  venues?: string[];
  publicationTypes?: string[];
  minCitationCount?: number;
  openAccessPdf?: boolean;
}

export interface PaperConstraintProfile {
  raw: string[];
  targetVenue?: string;
  toneHint?: string;
  lengthHint?: string;
}

export interface ExperimentConstraintProfile {
  designNotes: string[];
  implementationNotes: string[];
  evaluationNotes: string[];
}

export interface ConstraintProfile {
  source: "llm" | "heuristic_fallback";
  raw: string[];
  collect: CollectConstraintDefaults;
  writing: PaperConstraintProfile;
  experiment: ExperimentConstraintProfile;
  assumptions: string[];
}

export interface LiteratureQueryCandidate {
  query: string;
  reason:
    | "requested_query"
    | "llm_generated"
    | "brief_topic"
    | "run_topic"
    | "keyword_anchor";
}

export interface TopicDiscoveryLiteratureQueryStructure {
  query: string;
  sharedAnchorTerms: string[];
  axisTerms: string[];
}

const YEAR_SPEC_RE = /^(\d{4}|(\d{4}-\d{4})|(\d{4}-)|(-\d{4}))$/u;
const DATE_PART_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/u;
const LITERATURE_QUERY_FAMILY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "approach",
  "approaches",
  "article",
  "articles",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "literature",
  "method",
  "methods",
  "of",
  "on",
  "or",
  "paper",
  "papers",
  "research",
  "review",
  "reviews",
  "studies",
  "study",
  "survey",
  "surveys",
  "the",
  "to",
  "using",
  "with",
  "without"
]);
const LITERATURE_QUERY_FAMILY_JACCARD_THRESHOLD = 0.72;
const TOPIC_DISCOVERY_MIN_ANCHOR_TERMS = 2;
const TOPIC_DISCOVERY_MAX_ANCHOR_TERMS = 3;
const TOPIC_DISCOVERY_MIN_ANCHOR_MATCH_RATIO = 2 / 3;
const TOPIC_DISCOVERY_MIN_AXIS_TERMS = 2;
const TOPIC_DISCOVERY_MAX_AXIS_TERMS = 3;
const TOPIC_DISCOVERY_MAX_TOTAL_TERMS = 6;
const TOPIC_DISCOVERY_ANCHOR_STOPWORD_EXCEPTIONS = new Set([
  "paper",
  "papers",
  "review",
  "reviews"
]);
const TOPIC_DISCOVERY_NON_SUBSTANTIVE_AXIS_TOKEN_KEYS = new Set(
  [
    "bounded",
    "benchmark",
    "benchmarks",
    "budget",
    "budgets",
    "cheap",
    "compute",
    "comparison",
    "comparisons",
    "comparative",
    "claim",
    "claims",
    "contribution",
    "contributions",
    "cpu",
    "empirical",
    "evaluation",
    "evaluations",
    "execution",
    "fast",
    "gpu",
    "hardware",
    "lightweight",
    "limited",
    "local",
    "memory",
    "open",
    "paper",
    "pipeline",
    "portable",
    "performance",
    "metric",
    "metrics",
    "protocol",
    "protocols",
    "public",
    "publicly",
    "reproducibility",
    "reproducible",
    "resource",
    "resources",
    "runtime",
    "small",
    "study",
    "studies",
    "submission",
    "workshop"
  ].map(normalizeLiteratureQueryFamilyToken)
);

export function buildHeuristicConstraintProfile(constraints: string[]): ConstraintProfile {
  const raw = constraints.map((constraint) => constraint.trim()).filter(Boolean);
  return {
    source: "heuristic_fallback",
    raw,
    collect: deriveCollectConstraintDefaults(raw),
    writing: derivePaperConstraintProfile(raw),
    experiment: {
      designNotes: [],
      implementationNotes: [],
      evaluationNotes: []
    },
    assumptions: []
  };
}

export function mergeCollectConstraintDefaults(
  filters: CollectConstraintDefaults | undefined,
  defaults: CollectConstraintDefaults | undefined
): CollectConstraintDefaults | undefined {
  if (!defaults) {
    return hasAnyCollectConstraintDefaults(filters || {}) ? { ...(filters || {}) } : undefined;
  }

  const merged: CollectConstraintDefaults = {
    ...filters
  };

  if (!merged.dateRange && !merged.year && merged.lastYears === undefined && defaults.lastYears !== undefined) {
    merged.lastYears = defaults.lastYears;
  }
  if (!merged.dateRange && !merged.year && defaults.dateRange) {
    merged.dateRange = defaults.dateRange;
  }
  if (!merged.dateRange && !merged.year && !merged.lastYears && defaults.year) {
    merged.year = defaults.year;
  }
  if ((!merged.fieldsOfStudy || merged.fieldsOfStudy.length === 0) && defaults.fieldsOfStudy?.length) {
    merged.fieldsOfStudy = [...defaults.fieldsOfStudy];
  }
  if ((!merged.venues || merged.venues.length === 0) && defaults.venues?.length) {
    merged.venues = [...defaults.venues];
  }
  if ((!merged.publicationTypes || merged.publicationTypes.length === 0) && defaults.publicationTypes?.length) {
    merged.publicationTypes = [...defaults.publicationTypes];
  }
  if (merged.minCitationCount === undefined && defaults.minCitationCount !== undefined) {
    merged.minCitationCount = defaults.minCitationCount;
  }
  if (merged.openAccessPdf === undefined && defaults.openAccessPdf !== undefined) {
    merged.openAccessPdf = defaults.openAccessPdf;
  }

  return hasAnyCollectConstraintDefaults(merged) ? merged : undefined;
}

export function deriveCollectConstraintDefaults(constraints: string[]): CollectConstraintDefaults {
  const normalized = constraints.map((constraint) => constraint.trim()).filter(Boolean);
  const combined = normalized.join(" | ");
  const result: CollectConstraintDefaults = {};

  const lastYearsMatch =
    combined.match(/최근\s*(\d+)\s*년/u) ||
    combined.match(/\blast\s+(\d+)\s+years?\b/iu);
  if (lastYearsMatch) {
    result.lastYears = Number(lastYearsMatch[1]);
  } else if (
    /\brecent papers?\b/iu.test(combined) ||
    /\blatest papers?\b/iu.test(combined) ||
    /최신\s*논문/u.test(combined)
  ) {
    result.lastYears = 3;
  }

  if (
    /\bopen[\s-]?access\b/iu.test(combined) ||
    /\bpdf\b.*\b(link|available|only|required)\b/iu.test(combined) ||
    /오픈\s*액세스/u.test(combined) ||
    /pdf\s*(링크|있는|가능)/u.test(combined)
  ) {
    result.openAccessPdf = true;
  }

  if (
    /\breview papers?\b/iu.test(combined) ||
    /\bsurvey papers?\b/iu.test(combined) ||
    /리뷰\s*논문/u.test(combined) ||
    /서베이\s*논문/u.test(combined)
  ) {
    result.publicationTypes = ["Review"];
  }

  const minCitationMatch =
    combined.match(/(?:min(?:imum)?\s+citations?|citations?\s+at\s+least)\s*(\d+)/iu) ||
    combined.match(/최소\s*인용\s*(\d+)/u) ||
    combined.match(/인용\s*(\d+)\s*이상/u);
  if (minCitationMatch) {
    result.minCitationCount = Number(minCitationMatch[1]);
  }

  return result;
}

export function derivePaperConstraintProfile(constraints: string[]): PaperConstraintProfile {
  const raw = constraints.map((constraint) => constraint.trim()).filter(Boolean);
  const combined = raw.join(" | ");

  return {
    raw,
    targetVenue: detectTargetVenue(combined),
    toneHint: detectToneHint(combined),
    lengthHint: detectLengthHint(combined)
  };
}

export function normalizeConstraintProfile(input: Partial<ConstraintProfile> | undefined, rawConstraints: string[]): ConstraintProfile {
  const raw = rawConstraints.map((constraint) => constraint.trim()).filter(Boolean);
  const collect: Partial<CollectConstraintDefaults> = input?.collect || {};
  const writing: Partial<PaperConstraintProfile> = input?.writing || {};
  const experiment: Partial<ExperimentConstraintProfile> = input?.experiment || {};

  return {
    source: input?.source === "llm" ? "llm" : "heuristic_fallback",
    raw,
    collect: {
      dateRange: normalizeCollectDateRange(collect.dateRange),
      year: normalizeCollectYear(collect.year),
      lastYears: normalizePositiveInteger(collect.lastYears),
      fieldsOfStudy: normalizeExplicitFieldsOfStudy(collect.fieldsOfStudy, raw),
      venues: normalizeStringArray(collect.venues),
      publicationTypes: normalizePublicationTypes(collect.publicationTypes),
      minCitationCount: normalizePositiveInteger(collect.minCitationCount),
      openAccessPdf: normalizeBoolean(collect.openAccessPdf)
    },
    writing: {
      raw,
      targetVenue: cleanString(writing.targetVenue),
      toneHint: cleanString(writing.toneHint),
      lengthHint: cleanString(writing.lengthHint)
    },
    experiment: {
      designNotes: normalizeStringArray(experiment.designNotes),
      implementationNotes: normalizeStringArray(experiment.implementationNotes),
      evaluationNotes: normalizeStringArray(experiment.evaluationNotes)
    },
    assumptions: normalizeStringArray(input?.assumptions)
  };
}

export function extractResearchBriefTopic(rawBrief: string | undefined): string | undefined {
  const text = cleanString(rawBrief);
  if (!text) {
    return undefined;
  }

  const lines = text.split(/\r?\n/u);
  const headingIndex = lines.findIndex((line) => /^\s{0,3}#{1,6}\s*topic\s*$/iu.test(line.trim()));
  if (headingIndex >= 0) {
    const collected: string[] = [];
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^\s{0,3}#{1,6}\s+\S/iu.test(lines[index])) {
        break;
      }
      collected.push(lines[index]);
    }
    const topic = cleanBriefTopic(collected.join("\n"));
    if (topic) {
      return topic;
    }
  }

  const labeledMatch = text.match(/^\s*(?:topic|research topic|study topic|주제)\s*:\s*(.+)$/imu);
  if (labeledMatch?.[1]) {
    return cleanBriefTopic(labeledMatch[1]);
  }

  return undefined;
}

export function buildLiteratureQueryCandidates(input: {
  requestedQuery?: string;
  runTopic: string;
  llmGeneratedQueries?: string[];
  extractedBriefTopic?: string;
  briefTopic?: string;
}): LiteratureQueryCandidate[] {
  const candidates: LiteratureQueryCandidate[] = [];
  const pushCandidate = (query: string | undefined, reason: LiteratureQueryCandidate["reason"]) => {
    const normalized = normalizeLiteratureQuery(query);
    if (!normalized) {
      return;
    }
    if (candidates.some((candidate) => candidate.query.toLowerCase() === normalized.toLowerCase())) {
      return;
    }
    candidates.push({ query: normalized, reason });
  };

  const requested = normalizeLiteratureQuery(input.requestedQuery);
  const llmGeneratedQueries = sanitizeSemanticScholarQueryList(input.llmGeneratedQueries || []);
  const topicSeed = normalizeLiteratureQuery(input.briefTopic || input.extractedBriefTopic || input.runTopic);
  const topicReason: LiteratureQueryCandidate["reason"] = input.briefTopic
    ? "brief_topic"
    : input.extractedBriefTopic
      ? "brief_topic"
      : "run_topic";

  pushCandidate(requested, "requested_query");
  if (requested) {
    return candidates;
  }
  for (const query of llmGeneratedQueries) {
    pushCandidate(query, "llm_generated");
  }

  for (const query of buildDeterministicPhraseBundleQueries(topicSeed)) {
    pushCandidate(query, topicReason);
  }

  const keywordAnchor = buildKeywordAnchorQuery(topicSeed);
  if (isSpecificKeywordAnchorQuery(keywordAnchor)) {
    pushCandidate(keywordAnchor, "keyword_anchor");
  }

  if (candidates.length === 0) {
    pushCandidate(topicSeed, topicReason);
  }

  return candidates;
}

function detectTargetVenue(text: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bacl\b/iu, "ACL"],
    [/\bemnlp\b/iu, "EMNLP"],
    [/\bnaacl\b/iu, "NAACL"],
    [/\bneurips\b/iu, "NeurIPS"],
    [/\biclr\b/iu, "ICLR"],
    [/\bicml\b/iu, "ICML"],
    [/\bcvpr\b/iu, "CVPR"],
    [/\beccv\b/iu, "ECCV"],
    [/\biccv\b/iu, "ICCV"]
  ];
  for (const [pattern, venue] of patterns) {
    if (pattern.test(text)) {
      return venue;
    }
  }
  return undefined;
}

function cleanBriefTopic(value: string | undefined): string | undefined {
  const normalized = normalizeLiteratureQuery(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/\s+/g, " ").trim();
}

function normalizeLiteratureQuery(value: string | undefined): string | undefined {
  const cleaned = cleanString(value)
    ?.replace(/^[*_\-#>\s]+/u, "")
    .replace(/\s+/g, " ")
    .replace(/[.?!,:;]+$/u, "")
    .trim();
  return cleaned || undefined;
}

export function sanitizeSemanticScholarQueryList(values: Array<string | undefined>): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = sanitizeSemanticScholarFreeTextQuery(value);
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(normalized);
  }
  return results;
}

export function sanitizeSemanticScholarFreeTextQuery(value: string | undefined): string | undefined {
  const normalized = normalizeLiteratureQuery(value);
  if (!normalized) {
    return undefined;
  }

  const cleaned = normalized
    .replace(/```/gu, " ")
    .replace(
      /\b(?:title|abstract|author|authors|venue|journal|year|paperid|doi|fieldsofstudy|fields[\s_-]*of[\s_-]*study)\s*:/giu,
      " "
    )
    .replace(/\bAND\b/gu, " + ")
    .replace(/\bOR\b/gu, " | ")
    .replace(/\bNOT\b/gu, " - ")
    .replace(/'/gu, '"')
    .replace(/[`[\]{}<>]/gu, " ")
    .replace(/[,:;=]/gu, " ")
    .replace(/\s*\|\s*/gu, " | ")
    .replace(/(^|[\s(])\+\s*/gu, "$1+")
    .replace(/(^|[\s(])-+\s*/gu, "$1-")
    .replace(/\s+/gu, " ")
    .trim();

  return normalizeLiteratureQuery(cleaned);
}

export function hasSemanticScholarSpecialSyntax(query: string | undefined): boolean {
  if (!query?.trim()) {
    return false;
  }
  return /[|+()"]/u.test(query) || /\b(?:AND|OR|NOT)\b/u.test(query);
}

export function extractLiteratureQueryPositiveTerms(query: string | undefined): string[] {
  const sanitized = sanitizeSemanticScholarFreeTextQuery(query);
  if (!sanitized) {
    return [];
  }

  const positiveOnly = sanitized.replace(
    /(^|\s)-(?:(?:"[^"]+")|(?:'[^']+')|(?:\([^)]*\))|(?:[^\s]+))/gu,
    "$1"
  );
  return [...new Set(extractLiteratureTermSequence(positiveOnly))].sort();
}

export function extractLiteratureTermSequence(
  value: string | undefined,
  options: { preserveStopwords?: string[] } = {}
): string[] {
  if (!value?.trim()) {
    return [];
  }
  const preservedStopwords = new Set(
    (options.preserveStopwords ?? []).map((term) => term.trim().toLowerCase())
  );
  const tokens = value
    .replace(/[+|()"]+/gu, " ")
    .replace(/-/gu, " ")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

  return tokens
    .filter((token) =>
      token.length > 1
      && (
        !LITERATURE_QUERY_FAMILY_STOPWORDS.has(token)
        || preservedStopwords.has(token)
      )
    )
    .map(normalizeLiteratureQueryFamilyToken)
    .filter(Boolean);
}

export function buildLiteratureQueryFamilySignature(query: string | undefined): string | undefined {
  const terms = extractLiteratureQueryPositiveTerms(query);
  return terms.length > 0 ? terms.join("::") : undefined;
}

export function buildTopicDiscoveryLiteratureQuery(
  sharedAnchor: string | undefined,
  axis: string | undefined
): string | undefined {
  const anchorTerms = extractTopicDiscoveryQueryTokens(
    sharedAnchor,
    TOPIC_DISCOVERY_ANCHOR_STOPWORD_EXCEPTIONS
  );
  const anchorKeys = new Set(anchorTerms.map((term) => normalizeLiteratureQueryFamilyToken(term)));
  const axisTerms = extractTopicDiscoveryQueryTokens(axis).filter(
    (term) => !anchorKeys.has(normalizeLiteratureQueryFamilyToken(term))
  );

  if (
    anchorTerms.length < TOPIC_DISCOVERY_MIN_ANCHOR_TERMS ||
    anchorTerms.length > TOPIC_DISCOVERY_MAX_ANCHOR_TERMS ||
    axisTerms.length < TOPIC_DISCOVERY_MIN_AXIS_TERMS ||
    axisTerms.length > TOPIC_DISCOVERY_MAX_AXIS_TERMS ||
    anchorTerms.length + axisTerms.length > TOPIC_DISCOVERY_MAX_TOTAL_TERMS ||
    !hasSubstantiveTopicDiscoveryAxis(axisTerms)
  ) {
    return undefined;
  }

  return `"${anchorTerms.join(" ")}" ${axisTerms.join(" ")}`;
}

export function normalizeTopicDiscoveryLiteratureQuery(
  query: string | undefined
): string | undefined {
  const sanitized = sanitizeSemanticScholarFreeTextQuery(query);
  if (!sanitized) {
    return undefined;
  }
  const positiveOnly = stripNegativeLiteratureQueryClauses(sanitized);
  const anchorMatch = positiveOnly.match(/"([^"]+)"/u);
  if (!anchorMatch?.[1]) {
    return undefined;
  }
  const axis = positiveOnly
    .replace(anchorMatch[0], " ")
    .replace(/\b(?:AND|OR|NOT)\b/giu, " ")
    .replace(/[+|()"']/gu, " ");
  return buildTopicDiscoveryLiteratureQuery(anchorMatch[1], axis);
}

export function parseTopicDiscoveryLiteratureQuery(
  query: string | undefined
): TopicDiscoveryLiteratureQueryStructure | undefined {
  const normalized = normalizeTopicDiscoveryLiteratureQuery(query);
  if (!normalized) {
    return undefined;
  }
  const anchorMatch = normalized.match(/^"([^"]+)"\s+(.+)$/u);
  if (!anchorMatch?.[1] || !anchorMatch[2]) {
    return undefined;
  }
  const sharedAnchorTerms = extractTopicDiscoveryQueryTokens(
    anchorMatch[1],
    TOPIC_DISCOVERY_ANCHOR_STOPWORD_EXCEPTIONS
  );
  const anchorKeys = new Set(sharedAnchorTerms.map(normalizeLiteratureQueryFamilyToken));
  const axisTerms = extractTopicDiscoveryQueryTokens(anchorMatch[2]).filter(
    (term) => !anchorKeys.has(normalizeLiteratureQueryFamilyToken(term))
  );
  if (
    sharedAnchorTerms.length < TOPIC_DISCOVERY_MIN_ANCHOR_TERMS ||
    axisTerms.length < TOPIC_DISCOVERY_MIN_AXIS_TERMS
  ) {
    return undefined;
  }
  return {
    query: normalized,
    sharedAnchorTerms,
    axisTerms
  };
}

export function resolveTopicDiscoveryRetrievalAnchorMatches(
  sharedAnchorTerms: readonly string[]
): number {
  if (sharedAnchorTerms.length === 0) {
    return 0;
  }
  return Math.min(
    sharedAnchorTerms.length,
    Math.max(
      TOPIC_DISCOVERY_MIN_ANCHOR_TERMS,
      Math.ceil(sharedAnchorTerms.length * TOPIC_DISCOVERY_MIN_ANCHOR_MATCH_RATIO)
    )
  );
}

export function selectIndependentLiteratureQueries(
  queries: string[],
  maximum = 4
): string[] {
  return selectIndependentLiteratureQueryCandidates(
    queries.map((query) => ({ query })),
    maximum
  ).map((candidate) => candidate.query);
}

export function selectIndependentLiteratureQueryCandidates<T extends { query: string }>(
  candidates: T[],
  maximum = 4
): T[] {
  const selected: T[] = [];
  for (const candidate of candidates) {
    if (!candidate.query.trim()) {
      continue;
    }
    if (selected.some((existing) => areLiteratureQueriesInSameFamily(existing.query, candidate.query))) {
      continue;
    }
    selected.push(candidate);
    if (selected.length >= Math.max(1, maximum)) {
      break;
    }
  }
  return selected;
}

function areLiteratureQueriesInSameFamily(leftQuery: string, rightQuery: string): boolean {
  const left = new Set(extractLiteratureQueryPositiveTerms(leftQuery));
  const right = new Set(extractLiteratureQueryPositiveTerms(rightQuery));
  if (left.size === 0 || right.size === 0) {
    return leftQuery.trim().toLowerCase() === rightQuery.trim().toLowerCase();
  }

  const intersectionSize = [...left].filter((term) => right.has(term)).length;
  const unionSize = new Set([...left, ...right]).size;
  const smallerFamilySize = Math.min(left.size, right.size);
  const jaccardSimilarity = unionSize > 0 ? intersectionSize / unionSize : 0;
  const containmentSimilarity = smallerFamilySize > 0 ? intersectionSize / smallerFamilySize : 0;
  return jaccardSimilarity >= LITERATURE_QUERY_FAMILY_JACCARD_THRESHOLD || containmentSimilarity >= 0.85;
}

function normalizeLiteratureQueryFamilyToken(token: string): string {
  let normalized = token.normalize("NFKC").toLowerCase();
  if (/^[a-z]+$/u.test(normalized) && normalized.length > 7 && normalized.endsWith("ies")) {
    normalized = `${normalized.slice(0, -3)}y`;
  } else if (/^[a-z]+$/u.test(normalized) && normalized.length > 7 && normalized.endsWith("ing")) {
    normalized = normalized.slice(0, -3);
  } else if (/^[a-z]+$/u.test(normalized) && normalized.length > 6 && normalized.endsWith("ed")) {
    normalized = normalized.slice(0, -2);
  } else if (
    /^[a-z]+$/u.test(normalized) &&
    normalized.length > 5 &&
    normalized.endsWith("s") &&
    !normalized.endsWith("ss")
  ) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function stripNegativeLiteratureQueryClauses(value: string): string {
  return value.replace(
    /(^|\s)-(?:(?:"[^"]+")|(?:'[^']+')|(?:\([^)]*\))|(?:[^\s]+))/gu,
    "$1"
  );
}

function extractTopicDiscoveryQueryTokens(
  value: string | undefined,
  preservedStopwords: ReadonlySet<string> = new Set()
): string[] {
  const sanitized = sanitizeSemanticScholarFreeTextQuery(value);
  if (!sanitized) {
    return [];
  }
  const tokens = stripNegativeLiteratureQueryClauses(sanitized)
    .replace(/\b(?:AND|OR|NOT)\b/giu, " ")
    .replace(/[+|()"']/gu, " ")
    .replace(/(?<=\p{L})-(?=\p{L})/gu, " ")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const token of tokens) {
    if (
      token.length <= 1
      || (
        LITERATURE_QUERY_FAMILY_STOPWORDS.has(token)
        && !preservedStopwords.has(token)
      )
    ) {
      continue;
    }
    const key = normalizeLiteratureQueryFamilyToken(token);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    selected.push(token);
  }
  return selected;
}

function hasSubstantiveTopicDiscoveryAxis(axisTerms: string[]): boolean {
  return axisTerms.some(isSubstantiveTopicDiscoveryAxisTerm);
}

export function isSubstantiveTopicDiscoveryAxisTerm(term: string): boolean {
  return !TOPIC_DISCOVERY_NON_SUBSTANTIVE_AXIS_TOKEN_KEYS.has(
    normalizeLiteratureQueryFamilyToken(term)
  );
}

function buildKeywordAnchorQuery(value: string | undefined): string | undefined {
  const phrases = collectDeterministicResearchPhrases(value);
  if (phrases.length === 0) {
    return undefined;
  }

  const stopwords = new Set([
    "a",
    "an",
    "and",
    "for",
    "from",
    "in",
    "of",
    "on",
    "the",
    "to",
    "using",
    "with"
  ]);
  const keywords = phrases
    .join(" ")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu)
    ?.map((token) => token.trim())
    .filter(Boolean)
    .filter((token) => !stopwords.has(token))
    .filter((token) => token.length > 2) || [];
  const uniqueKeywords = keywords.filter(
    (token, index) => keywords.indexOf(token) === index
  );

  if (uniqueKeywords.length === 0) {
    return undefined;
  }

  const limited = uniqueKeywords.slice(0, 6);
  if (limited.length < 2) {
    return undefined;
  }
  return normalizeLiteratureQuery(limited.join(" "));
}

function buildDeterministicPhraseBundleQueries(value: string | undefined): string[] {
  const phrases = collectDeterministicResearchPhrases(value);
  if (phrases.length === 0) {
    return [];
  }

  const queries: string[] = [];
  const seen = new Set<string>();
  const quoted = (phrase: string): string => '"' + phrase + '"';
  const pushQuery = (query: string) => {
    const normalized = normalizeLiteratureQuery(query);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      queries.push(normalized);
    }
  };

  if (phrases.length > 1) {
    for (const phrase of phrases.slice(1, 5)) {
      pushQuery("+" + quoted(phrases[0]) + " +" + quoted(phrase));
    }
  }

  if (queries.length < 2) {
    for (const phrase of phrases) {
      pushQuery("+" + quoted(phrase));
      if (queries.length >= 2) {
        break;
      }
    }
  }

  if (queries.length < 2 && phrases.length === 1) {
    pushQuery(phrases[0]);
  }
  return queries.slice(0, 4);
}

function collectDeterministicResearchPhrases(value: string | undefined): string[] {
  const text = extractDeterministicTopicScope(value)?.toLowerCase();
  if (!text) {
    return [];
  }

  const stopwords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "how", "in", "into",
    "of", "on", "or", "the", "through", "to", "under", "using", "with"
  ]);
  const phrases: string[] = [];
  const pushPhrase = (phrase: string) => {
    const normalized = normalizeDeterministicConceptPhrase(phrase, stopwords);
    if (normalized && !phrases.includes(normalized)) {
      phrases.push(normalized);
    }
  };

  const quotedPhrases = Array.from(text.matchAll(/["']([^"']{2,80})["']/gu));
  for (const match of quotedPhrases) {
    if (!isExecutionQualifierClause(match[1])) {
      pushPhrase(match[1]);
    }
  }

  const clauses = text.split(/\s*[,;]\s*/u);
  for (const rawClause of clauses) {
    const clause = rawClause
      .replace(/^(?:and|or|plus)\s+/iu, "")
      .replace(/\b(?:behave|behaves|perform|performs)\s*$/iu, "")
      .trim();
    if (!clause || isExecutionQualifierClause(clause)) {
      continue;
    }
    const conceptParts = clause.split(/\s+(?:for|under|using|via|with|within)\s+/iu);
    for (const conceptPart of conceptParts) {
      const tokens = (conceptPart.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [])
        .map((token) => token.trim())
        .filter(Boolean)
        .filter((token) => !stopwords.has(token))
        .filter((token) => token.length > 1);
      if (tokens.length === 0) {
        continue;
      }
      if (tokens.length <= 4) {
        pushPhrase(tokens.join(" "));
        continue;
      }
      for (let index = 0; index < tokens.length && phrases.length < 6; index += 3) {
        const chunk = tokens.slice(index, index + 3);
        if (chunk.length === 1 && index > 0) {
          break;
        }
        pushPhrase(chunk.join(" "));
      }
    }
  }

  if (phrases.length === 0) {
    pushPhrase(text);
  }
  return phrases.slice(0, 6);
}

function extractDeterministicTopicScope(value: string | undefined): string | undefined {
  let text = normalizeLiteratureQuery(value);
  if (!text) {
    return undefined;
  }

  text = text
    .replace(
      /(?:[.!?;]\s+|\s+-\s+)(?:exclude|avoid|omit|do not include|without including)\b[\s\S]*$/iu,
      " "
    )
    .trim();

  const leadingDirectivePatterns = [
    /^(?:please\s+)?(?:search|look)\s+for\s+/iu,
    /^(?:please\s+)?(?:find|identify|discover|explore)\s+/iu,
    /^(?:investigate|measure|assess|analyze|evaluate|compare)\s+(?:how|whether)\s+/iu,
    /^(?:investigate|assess|analyze|evaluate|compare)\s+/iu,
    /^(?:an?|the)\s+(?:(?:workshop|paper|pilot|study)[-\s]?scale\s+)?(?:(?:empirical|research)\s+)?(?:questions?|topics?|directions?|ideas?)\s+(?:at|in|on)\s+(?:the\s+)?(?:intersection|interface|crossroads)\s+of\s+/iu,
    /^(?:an?|the)\s+(?:(?:workshop|paper|pilot|study)[-\s]?scale\s+)?(?:(?:empirical|research)\s+)?(?:questions?|topics?|directions?|ideas?)\s+(?:about|for|on)\s+/iu,
    /^(?:at|in)\s+(?:the\s+)?(?:intersection|interface|crossroads)\s+of\s+/iu,
    /^(?:the\s+)?(?:question|topic|problem)\s+of\s+/iu
  ];

  for (let pass = 0; pass < 3; pass += 1) {
    const previous: string = text;
    for (const pattern of leadingDirectivePatterns) {
      text = text.replace(pattern, "").trim();
    }
    if (text === previous) {
      break;
    }
  }

  return normalizeLiteratureQuery(text);
}

function normalizeDeterministicConceptPhrase(phrase: string, stopwords: Set<string>): string | undefined {
  const tokens = (phrase.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [])
    .map((token) => token.toLowerCase().trim())
    .filter(Boolean)
    .filter((token) => !stopwords.has(token))
    .filter((token) => token.length > 1);
  const normalized = normalizeLiteratureQuery(tokens.join(" "));
  if (!normalized || isExecutionQualifierClause(normalized)) {
    return undefined;
  }
  if (/^(?:(?:empirical|research)\s+)?(?:questions?|topics?|directions?|ideas?)$/iu.test(normalized)) {
    return undefined;
  }
  return normalized.toLowerCase();
}

function isExecutionQualifierClause(value: string): boolean {
  const normalized = normalizeLiteratureQuery(value)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /^(?:(?:fully|readily)\s+)?(?:reproducible|repeatable)(?:\s+(?:local|offline|on-device))?\s+(?:execution|implementation|experiments?|workflow|setup)$/iu.test(normalized) ||
    /^(?:local|offline|on-device)\s+(?:execution|implementation|experiments?|workflow|setup)$/iu.test(normalized) ||
    /^(?:workshop|paper|pilot|small)[-\s]?scale(?:\s+(?:study|experiment|execution))?$/iu.test(normalized) ||
    /^(?:bounded|lightweight|resource[-\s]?aware)\s+(?:compute|execution|hardware|implementation)$/iu.test(normalized)
  );
}

function isSpecificKeywordAnchorQuery(value: string | undefined): boolean {
  const text = normalizeLiteratureQuery(value)?.toLowerCase();
  if (!text) {
    return false;
  }

  const tokens = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) || [];
  const uniqueTokens = new Set(tokens);
  return uniqueTokens.size >= 3;
}

function detectToneHint(text: string): string | undefined {
  if (/\bformal\b/iu.test(text) || /\bacademic\b/iu.test(text) || /격식|학술/u.test(text)) {
    return "formal academic";
  }
  if (/\bsurvey\b/iu.test(text) || /\breview\b/iu.test(text) || /서베이|리뷰/u.test(text)) {
    return "survey";
  }
  if (/\btutorial\b/iu.test(text) || /튜토리얼/u.test(text)) {
    return "tutorial";
  }
  if (/\bempirical\b/iu.test(text) || /실증/u.test(text)) {
    return "empirical";
  }
  return undefined;
}

function detectLengthHint(text: string): string | undefined {
  const rangeMatch = text.match(/(\d+)\s*[-~]\s*(\d+)\s*(?:pages?|페이지)/iu);
  if (rangeMatch) {
    return `${rangeMatch[1]}-${rangeMatch[2]} pages`;
  }

  const exactMatch = text.match(/(\d+)\s*(?:pages?|페이지)/iu);
  if (exactMatch) {
    return `${exactMatch[1]} pages`;
  }

  if (/\bshort paper\b/iu.test(text) || /짧은\s*논문/u.test(text)) {
    return "short paper";
  }
  if (/\blong paper\b/iu.test(text) || /\bfull paper\b/iu.test(text) || /장문/u.test(text)) {
    return "long paper";
  }
  if (/\bextended abstract\b/iu.test(text) || /확장\s*초록/u.test(text)) {
    return "extended abstract";
  }
  return undefined;
}

function hasAnyCollectConstraintDefaults(filters: CollectConstraintDefaults): boolean {
  return Boolean(
    filters.dateRange ||
      filters.year ||
      filters.lastYears !== undefined ||
      (filters.fieldsOfStudy && filters.fieldsOfStudy.length > 0) ||
      (filters.venues && filters.venues.length > 0) ||
      (filters.publicationTypes && filters.publicationTypes.length > 0) ||
      filters.minCitationCount !== undefined ||
      filters.openAccessPdf !== undefined
  );
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanString(item))
    .filter((item): item is string => Boolean(item));
}

function normalizeExplicitFieldsOfStudy(value: unknown, rawConstraints: string[]): string[] {
  const normalizedRaw = ` ${normalizeConstraintEvidence(rawConstraints.join(" "))} `;
  if (!normalizedRaw.trim()) {
    return [];
  }
  return normalizeStringArray(value).filter((item) => {
    const normalizedItem = normalizeConstraintEvidence(item);
    return normalizedItem.length > 0 && normalizedRaw.includes(` ${normalizedItem} `);
  });
}

function normalizeConstraintEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePublicationTypes(value: unknown): string[] {
  return normalizeStringArray(value).filter((item) => {
    const normalized = item.trim().toLowerCase();
    return !["paper", "papers", "article", "articles"].includes(normalized);
  });
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return Math.floor(raw);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeCollectYear(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned || !YEAR_SPEC_RE.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function normalizeCollectDateRange(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) {
    return undefined;
  }
  const parts = cleaned.split(":");
  if (parts.length !== 2) {
    return undefined;
  }
  const [start, end] = parts;
  const startValid = start === "" || DATE_PART_RE.test(start);
  const endValid = end === "" || DATE_PART_RE.test(end);
  if (!startValid || !endValid || (start === "" && end === "")) {
    return undefined;
  }
  return cleaned;
}
