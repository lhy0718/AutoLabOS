import { createHash } from "node:crypto";

import {
  countTopicDiscoveryCandidateTitleSupport,
  normalizeTopicDiscoveryScientificObjectTerms,
  normalizeTopicDiscoveryScientificTerms,
  TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION
} from "./topicDiscoveryScientificTerms.js";
import {
  extractTopicDiscoveryAnchorSurfaceTerms,
  TOPIC_DISCOVERY_MAX_ANCHOR_TERMS,
  TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
} from "./runConstraints.js";
import { parseMarkdownRunBriefSections } from "./runs/runBriefParser.js";

export { normalizeTopicDiscoveryScientificTerms } from "./topicDiscoveryScientificTerms.js";

export type TopicDiscoveryScientificBriefSection =
  | "scientific_scope"
  | "topic"
  | "research_question"
  | "dataset_task_bench"
  | "questions_risks";

export type TopicDiscoveryScientificScopeUnitRole =
  | "scientific_object"
  | "empirical_problem"
  | "scientific_relation"
  | "prior_work_probe"
  | "admissibility_constraint"
  | "process_rule"
  | "publication_goal"
  | "exclusion";

export type TopicDiscoveryScopeUnitDisposition =
  | "anchor_authority"
  | "axis_authority"
  | "prior_work_probe_only"
  | "excluded_from_scientific_scope";

export type TopicDiscoveryScopeRelation =
  | "lexical_refinement"
  | "technical_expansion"
  | "unbound";

export interface TopicDiscoveryScopeUnit {
  id: string;
  sourceSection: TopicDiscoveryScientificBriefSection;
  sourceText: string;
  sourceTextSha256: string;
  role: TopicDiscoveryScientificScopeUnitRole;
  disposition: TopicDiscoveryScopeUnitDisposition;
  sourceTerms: string[];
  reason: string;
}

export interface TopicDiscoveryScopeAxis {
  id: string;
  sourceSection: TopicDiscoveryScientificBriefSection;
  sourceTextSha256: string;
  role: "empirical_problem" | "scientific_relation";
  sourceTerms: string[];
}

export interface TopicDiscoveryPriorWorkProbe {
  id: string;
  sourceSection: TopicDiscoveryScientificBriefSection;
  sourceTextSha256: string;
  sourceTerms: string[];
}

export interface TopicDiscoveryScopeContract {
  version: 3;
  termNormalizationVersion: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  contractSource: "explicit_scientific_scope" | "inferred_role_classifier";
  briefFingerprint: string;
  scopeFingerprint: string;
  contractFingerprint: string;
  enforced: boolean;
  sourceSections: TopicDiscoveryScientificBriefSection[];
  declaredAnchorTerms: string[];
  queryAnchorTerms: string[];
  sharedAnchorTerms: string[];
  axes: TopicDiscoveryScopeAxis[];
  priorWorkProbes: TopicDiscoveryPriorWorkProbe[];
  units: TopicDiscoveryScopeUnit[];
}

export interface TopicDiscoveryScopeFamilyInput {
  id: string;
  axisTerms: string[];
}

export interface TopicDiscoveryScopeFamilyDiagnostic {
  id: string;
  axisTerms: string[];
  scopeAxisId?: string;
  sourceSection?: TopicDiscoveryScientificBriefSection;
  relation: TopicDiscoveryScopeRelation;
  retainedSourceTerms: string[];
  novelTerms: string[];
  candidateTitleSupport: number;
  candidateTitleEvidenceClass: "queryability_only";
  passed: boolean;
  failureReason?:
    | "scope_contract_unavailable"
    | "no_brief_axis_lineage"
    | "unsupported_technical_expansion";
}

export interface TopicDiscoveryScopeAnchorDiagnostic {
  expectedTerms: string[];
  actualTerms: string[];
  authority: "brief_declared" | "unavailable";
  passed: boolean;
  failureReason?: "scope_anchor_unavailable" | "scope_anchor_not_declared";
}

export interface TopicDiscoveryScientificScopeDiagnostic {
  version: 3;
  termNormalizationVersion: typeof TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION;
  contractSource: TopicDiscoveryScopeContract["contractSource"];
  enforced: boolean;
  status: "passed" | "failed" | "insufficient_brief_source_material";
  briefFingerprint: string;
  scopeFingerprint: string;
  contractFingerprint: string;
  sourceSections: TopicDiscoveryScientificBriefSection[];
  declaredAnchorTerms: string[];
  queryAnchorTerms: string[];
  lockedAnchorTerms: string[];
  priorWorkProbes: TopicDiscoveryPriorWorkProbe[];
  anchor: TopicDiscoveryScopeAnchorDiagnostic;
  recovery: boolean;
  families: TopicDiscoveryScopeFamilyDiagnostic[];
}

const MINIMUM_SCOPE_AXES = 2;
const MINIMUM_SCOPE_TERMS = 4;
const MINIMUM_TECHNICAL_EXPANSION_TITLE_SUPPORT = 2;

const GENERIC_SCOPE_TERMS = new Set(normalizeTopicDiscoveryScientificTerms([
  "about", "accessible", "actual", "affect", "against", "allow", "already",
  "analysis", "api", "apis", "apply", "artifact", "available", "are", "baseline",
  "before", "be", "best", "benchmark", "benchmarks", "can", "cannot", "candidate",
  "ceiling", "central", "change", "claim", "compare", "comparator", "condition",
  "conclusion", "conclusions", "constraint", "controlled", "contribution", "current",
  "data", "dataset", "declare", "declared", "defend", "decision", "define", "design",
  "development", "direct", "distinguish", "do", "does", "each", "effect", "empirical",
  "evidence", "evaluation", "enough", "exclude", "exclusion", "execute", "executable",
  "experiment", "factor", "factors", "failure", "finding", "fixed", "foundation",
  "frame", "full", "gap", "grading", "include", "intersection", "intervention", "its",
  "language", "license", "likely", "level", "locally", "method", "model", "must",
  "named", "new", "novelty", "object", "only", "outcome", "paper", "path", "paid",
  "primary", "principled", "procedure", "processable", "proposed", "proprietary",
  "public", "publicly", "question", "report", "require", "research", "recent", "result",
  "rule", "scale", "score", "search", "scientific", "short", "storage", "strongest",
  "study", "support", "subsume", "system", "systems", "task", "test", "that", "time",
  "topic", "train", "under", "unit", "use", "used", "version", "when", "which", "will",
  "whose", "within", "workshop", "work", "yield"
].join(" ")));

const GENERIC_ANCHOR_TERMS = new Set(normalizeTopicDiscoveryScientificTerms([
  "about", "broad", "candidate", "contribution", "empirical", "gap",
  "problem", "research", "scope", "search", "study", "topic", "workshop"
].join(" ")));

const EXCLUSION_PATTERN =
  /\b(?:avoid|do not|exclude|excluded|forbid|forbidden|must not|prohibit|prohibited)\b/iu;
const PROCESS_RULE_PATTERN =
  /^(?:a candidate|all candidates|before|each candidate|every candidate|keep|prefer|record|report|require|use|when)\b|\b(?:must|required|should)\b/iu;
const PUBLICATION_GOAL_PATTERN =
  /\b(?:acceptance|contribution|findings|novelty|paper|publication|reviewer|submission|venue|workshop)\b/iu;
const PRIOR_WORK_PROBE_PATTERN =
  /\b(?:already|closest prior|literature|prior work|recent work|state of the art|subsume|subsumed)\b/iu;

export function buildTopicDiscoveryScopeContract(
  rawBrief: string | undefined,
  sharedAnchorTerms: string[] = []
): TopicDiscoveryScopeContract {
  const normalizedBrief = (rawBrief ?? "").replace(/\r/gu, "").trim();
  const sections = normalizedBrief
    ? parseMarkdownRunBriefSections(normalizedBrief)
    : undefined;
  const explicitScope = sections?.scientificScope?.trim();
  const contractSource = explicitScope
    ? "explicit_scientific_scope" as const
    : "inferred_role_classifier" as const;
  const units = explicitScope
    ? parseExplicitScientificScope(explicitScope)
    : buildInferredScientificScopeUnits(sections);
  const declaredAnchorTerms = uniqueTerms(
    units
      .filter((unit) => unit.disposition === "anchor_authority")
      .flatMap((unit) => unit.sourceTerms)
  );
  const axes = units.flatMap((unit) =>
    unit.disposition === "axis_authority"
      && (unit.role === "empirical_problem" || unit.role === "scientific_relation")
      ? [{
          id: unit.id,
          sourceSection: unit.sourceSection,
          sourceTextSha256: unit.sourceTextSha256,
          role: unit.role,
          sourceTerms: [...unit.sourceTerms]
        } satisfies TopicDiscoveryScopeAxis]
      : []
  );
  const priorWorkProbes = units.flatMap((unit) =>
    unit.disposition === "prior_work_probe_only"
      ? [{
          id: unit.id,
          sourceSection: unit.sourceSection,
          sourceTextSha256: unit.sourceTextSha256,
          sourceTerms: [...unit.sourceTerms]
        } satisfies TopicDiscoveryPriorWorkProbe]
      : []
  );
  const sourceSections = [...new Set(
    units
      .filter((unit) => unit.disposition !== "excluded_from_scientific_scope")
      .map((unit) => unit.sourceSection)
  )];
  const distinctScopeTerms = new Set(axes.flatMap((axis) => axis.sourceTerms));
  const requestedAnchorTerms = canonicalizeAnchorTerms(sharedAnchorTerms);
  const queryAnchorTerms = resolveQueryAnchorTerms(units, declaredAnchorTerms);
  const sharedAnchor = declaredAnchorTerms.length >= TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
    ? [...declaredAnchorTerms]
    : requestedAnchorTerms.slice(0, TOPIC_DISCOVERY_MAX_ANCHOR_TERMS);
  const briefFingerprint = sha256(normalizedBrief);
  const scopeFingerprint = buildScientificScopeFingerprint({
    contractSource,
    declaredAnchorTerms,
    axes,
    priorWorkProbes
  });
  const enforced =
    declaredAnchorTerms.length >= TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
    && declaredAnchorTerms.length <= TOPIC_DISCOVERY_MAX_ANCHOR_TERMS
    && axes.length >= MINIMUM_SCOPE_AXES
    && distinctScopeTerms.size >= MINIMUM_SCOPE_TERMS;
  return {
    version: 3,
    termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    contractSource,
    briefFingerprint,
    scopeFingerprint,
    contractFingerprint: buildScopeContractFingerprint(
      scopeFingerprint,
      sharedAnchor,
      queryAnchorTerms
    ),
    enforced,
    sourceSections,
    declaredAnchorTerms,
    queryAnchorTerms,
    sharedAnchorTerms: sharedAnchor,
    axes,
    priorWorkProbes,
    units
  };
}

export function bindTopicDiscoveryScopeAnchor(
  contract: TopicDiscoveryScopeContract,
  sharedAnchorTerms: string[]
): TopicDiscoveryScopeContract {
  const normalizedAnchorTerms = canonicalizeAnchorTerms(sharedAnchorTerms);
  if (normalizedAnchorTerms.length < TOPIC_DISCOVERY_MIN_ANCHOR_TERMS) {
    throw new Error("topic_discovery_scope_anchor_missing");
  }
  if (
    contract.declaredAnchorTerms.length < TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
    || !haveSameTerms(contract.declaredAnchorTerms, normalizedAnchorTerms)
  ) {
    throw new Error(
      `topic_discovery_scope_anchor_not_declared:expected=${contract.declaredAnchorTerms.join("_") || "none"}`
      + `;actual=${normalizedAnchorTerms.join("_")}`
    );
  }
  if (
    contract.sharedAnchorTerms.length > 0
    && !haveSameTerms(contract.sharedAnchorTerms, normalizedAnchorTerms)
  ) {
    throw new Error(
      `topic_discovery_scope_anchor_conflict:expected=${contract.sharedAnchorTerms.join("_")}`
      + `;actual=${normalizedAnchorTerms.join("_")}`
    );
  }
  const boundAnchorTerms = [...contract.declaredAnchorTerms];
  return {
    ...contract,
    sharedAnchorTerms: boundAnchorTerms,
    contractFingerprint: buildScopeContractFingerprint(
      contract.scopeFingerprint,
      boundAnchorTerms,
      contract.queryAnchorTerms
    )
  };
}

export function assessTopicDiscoveryScientificScope(input: {
  contract: TopicDiscoveryScopeContract;
  sharedAnchorTerms: string[];
  families: TopicDiscoveryScopeFamilyInput[];
  rejectedQueries: string[];
  candidateTitles: string[];
}): TopicDiscoveryScientificScopeDiagnostic {
  const recovery = input.rejectedQueries.length > 0;
  const anchorTerms = canonicalizeAnchorTerms(input.sharedAnchorTerms);
  const expectedAnchorTerms = input.contract.declaredAnchorTerms.length
    ? [...input.contract.declaredAnchorTerms]
    : [...input.contract.sharedAnchorTerms];
  const authority = expectedAnchorTerms.length >= TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
    ? "brief_declared" as const
    : "unavailable" as const;
  const anchorPassed = authority === "brief_declared"
    && haveSameTerms(expectedAnchorTerms, anchorTerms);
  const anchor: TopicDiscoveryScopeAnchorDiagnostic = {
    expectedTerms: expectedAnchorTerms,
    actualTerms: anchorTerms,
    authority,
    passed: anchorPassed,
    ...(!anchorPassed
      ? {
          failureReason: authority === "unavailable"
            ? "scope_anchor_unavailable" as const
            : "scope_anchor_not_declared" as const
        }
      : {})
  };
  const anchorTermSet = new Set(anchorTerms);
  const families = input.families.map((family) => {
    const axisTerms = uniqueTerms(
      normalizeTopicDiscoveryScientificTerms(family.axisTerms.join(" "))
        .filter((term) => !anchorTermSet.has(term))
    );
    const candidateTitleSupport = countTopicDiscoveryCandidateTitleSupport(
      axisTerms,
      input.candidateTitles
    );
    if (!input.contract.enforced) {
      return {
        id: family.id,
        axisTerms,
        relation: "unbound",
        retainedSourceTerms: [],
        novelTerms: [...axisTerms],
        candidateTitleSupport,
        candidateTitleEvidenceClass: "queryability_only",
        passed: false,
        failureReason: "scope_contract_unavailable"
      } satisfies TopicDiscoveryScopeFamilyDiagnostic;
    }

    const matches = input.contract.axes.map((scopeAxis) => {
      const sourceTermSet = new Set(scopeAxis.sourceTerms);
      const retainedSourceTerms = axisTerms.filter((term) => sourceTermSet.has(term));
      return { scopeAxis, retainedSourceTerms };
    });
    matches.sort((left, right) =>
      right.retainedSourceTerms.length - left.retainedSourceTerms.length
      || left.scopeAxis.id.localeCompare(right.scopeAxis.id)
    );
    const best = matches[0];
    const retainedSourceTerms = best?.retainedSourceTerms ?? [];
    const retainedSet = new Set(retainedSourceTerms);
    const novelTerms = axisTerms.filter((term) => !retainedSet.has(term));
    if (!best || retainedSourceTerms.length === 0) {
      return {
        id: family.id,
        axisTerms,
        relation: "unbound",
        retainedSourceTerms: [],
        novelTerms,
        candidateTitleSupport,
        candidateTitleEvidenceClass: "queryability_only",
        passed: false,
        failureReason: "no_brief_axis_lineage"
      } satisfies TopicDiscoveryScopeFamilyDiagnostic;
    }

    const relation: TopicDiscoveryScopeRelation = novelTerms.length > 0
      ? "technical_expansion"
      : "lexical_refinement";
    const supported =
      retainedSourceTerms.length >= 2
      || candidateTitleSupport >= MINIMUM_TECHNICAL_EXPANSION_TITLE_SUPPORT;
    return {
      id: family.id,
      axisTerms,
      scopeAxisId: best.scopeAxis.id,
      sourceSection: best.scopeAxis.sourceSection,
      relation,
      retainedSourceTerms,
      novelTerms,
      candidateTitleSupport,
      candidateTitleEvidenceClass: "queryability_only",
      passed: supported,
      ...(!supported
        ? { failureReason: "unsupported_technical_expansion" as const }
        : {})
    } satisfies TopicDiscoveryScopeFamilyDiagnostic;
  });
  const allFamiliesPassed = families.length > 0 && families.every((family) => family.passed);
  const status = !input.contract.enforced
    ? "insufficient_brief_source_material" as const
    : anchorPassed && allFamiliesPassed
      ? "passed" as const
      : "failed" as const;
  return {
    version: 3,
    termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    contractSource: input.contract.contractSource,
    enforced: input.contract.enforced,
    status,
    briefFingerprint: input.contract.briefFingerprint,
    scopeFingerprint: input.contract.scopeFingerprint,
    contractFingerprint: input.contract.contractFingerprint,
    sourceSections: [...input.contract.sourceSections],
    declaredAnchorTerms: [...input.contract.declaredAnchorTerms],
    queryAnchorTerms: [...input.contract.queryAnchorTerms],
    lockedAnchorTerms: [...input.contract.sharedAnchorTerms],
    priorWorkProbes: input.contract.priorWorkProbes.map((probe) => ({
      ...probe,
      sourceTerms: [...probe.sourceTerms]
    })),
    anchor,
    recovery,
    families
  };
}

export function haveSameTopicDiscoveryScopeTerms(left: string[], right: string[]): boolean {
  return haveSameTerms(canonicalizeAnchorTerms(left), canonicalizeAnchorTerms(right));
}

function parseExplicitScientificScope(value: string): TopicDiscoveryScopeUnit[] {
  const units: TopicDiscoveryScopeUnit[] = [];
  let activeRole: TopicDiscoveryScientificScopeUnitRole | undefined;
  for (const line of value.replace(/\r/gu, "").split("\n")) {
    const heading = line.match(/^###\s+(.+?)\s*$/u);
    if (heading) {
      activeRole = mapExplicitScientificScopeRole(heading[1]);
      continue;
    }
    if (!activeRole) {
      continue;
    }
    for (const unit of splitScopeUnits(line)) {
      units.push(buildScopeUnit("scientific_scope", activeRole, unit));
    }
  }
  return units;
}

function buildInferredScientificScopeUnits(
  sections: ReturnType<typeof parseMarkdownRunBriefSections>
): TopicDiscoveryScopeUnit[] {
  const sources: Array<[TopicDiscoveryScientificBriefSection, string | undefined]> = [
    ["topic", sections?.topic],
    ["research_question", sections?.researchQuestion],
    ["dataset_task_bench", sections?.datasetTaskBench],
    ["questions_risks", sections?.questionsRisks]
  ];
  return sources.flatMap(([sourceSection, value]) =>
    splitScopeUnits(value).map((unit) =>
      buildScopeUnit(sourceSection, classifyInferredScientificScopeRole(sourceSection, unit), unit)
    )
  );
}

function buildScopeUnit(
  sourceSection: TopicDiscoveryScientificBriefSection,
  role: TopicDiscoveryScientificScopeUnitRole,
  sourceText: string
): TopicDiscoveryScopeUnit {
  const sourceTextSha256 = sha256(sourceText);
  const disposition = dispositionForRole(role);
  const sourceTerms = role === "scientific_object"
    ? extractScientificObjectTerms(sourceText)
    : extractDistinctiveScopeTerms(sourceText);
  return {
    id: `${role}_${sourceTextSha256.slice(0, 12)}`,
    sourceSection,
    sourceText,
    sourceTextSha256,
    role,
    disposition,
    sourceTerms: sourceTerms.slice(0, 12),
    reason: reasonForRole(role)
  };
}

function mapExplicitScientificScopeRole(
  value: string
): TopicDiscoveryScientificScopeUnitRole | undefined {
  switch (value.trim().toLowerCase().replace(/\s*\/\s*/gu, " / ")) {
    case "scientific object":
    case "scientific objects":
    case "research object":
    case "research objects":
      return "scientific_object";
    case "empirical problem":
    case "empirical problems":
      return "empirical_problem";
    case "scientific relation":
    case "scientific relations":
    case "testable relation":
    case "testable relations":
      return "scientific_relation";
    case "prior-work probe":
    case "prior-work probes":
    case "prior work probe":
    case "prior work probes":
      return "prior_work_probe";
    case "admissibility constraint":
    case "admissibility constraints":
      return "admissibility_constraint";
    case "process rule":
    case "process rules":
      return "process_rule";
    case "publication goal":
    case "publication goals":
      return "publication_goal";
    case "exclusion":
    case "exclusions":
      return "exclusion";
    default:
      return undefined;
  }
}

function classifyInferredScientificScopeRole(
  sourceSection: TopicDiscoveryScientificBriefSection,
  value: string
): TopicDiscoveryScientificScopeUnitRole {
  if (EXCLUSION_PATTERN.test(value)) {
    return "exclusion";
  }
  if (sourceSection === "topic") {
    return "scientific_object";
  }
  if (PRIOR_WORK_PROBE_PATTERN.test(value)) {
    return "prior_work_probe";
  }
  if (PUBLICATION_GOAL_PATTERN.test(value)) {
    return "publication_goal";
  }
  if (PROCESS_RULE_PATTERN.test(value)) {
    return sourceSection === "dataset_task_bench"
      ? "admissibility_constraint"
      : "process_rule";
  }
  if (sourceSection === "research_question") {
    return "empirical_problem";
  }
  if (sourceSection === "questions_risks" && /[?]\s*$/u.test(value)) {
    return "scientific_relation";
  }
  return sourceSection === "dataset_task_bench"
    ? "admissibility_constraint"
    : "process_rule";
}

function dispositionForRole(
  role: TopicDiscoveryScientificScopeUnitRole
): TopicDiscoveryScopeUnitDisposition {
  if (role === "scientific_object") {
    return "anchor_authority";
  }
  if (role === "empirical_problem" || role === "scientific_relation") {
    return "axis_authority";
  }
  if (role === "prior_work_probe") {
    return "prior_work_probe_only";
  }
  return "excluded_from_scientific_scope";
}

function reasonForRole(role: TopicDiscoveryScientificScopeUnitRole): string {
  switch (role) {
    case "scientific_object":
      return "authorizes the immutable literature-search anchor";
    case "empirical_problem":
    case "scientific_relation":
      return "authorizes scientific query-family lineage";
    case "prior_work_probe":
      return "routes only to closest-prior discovery and cannot authorize a scientific axis";
    case "admissibility_constraint":
      return "constrains candidate eligibility but cannot authorize a scientific axis";
    case "process_rule":
      return "governs execution but cannot authorize a scientific axis";
    case "publication_goal":
      return "states publication positioning but cannot authorize a scientific axis";
    case "exclusion":
      return "forbids a direction and cannot authorize a scientific axis";
  }
}

function splitScopeUnits(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .replace(/\r/gu, "")
    .split(/\n+|(?<=[.!?])\s+(?=(?:[-*]\s*)?[A-Z0-9])/gu)
    .map((unit) => unit.replace(/^[-*]\s*/u, "").trim())
    .filter(Boolean);
}

function extractScientificObjectTerms(value: string): string[] {
  const terms = uniqueTerms(normalizeTopicDiscoveryScientificObjectTerms(value))
    .filter((term) => /\p{L}/u.test(term));
  return terms.filter((term, index) =>
    !GENERIC_ANCHOR_TERMS.has(term)
    || isInteriorScientificObjectTerm(terms, index)
  );
}

function isInteriorScientificObjectTerm(terms: string[], index: number): boolean {
  if (index === 0 || index === terms.length - 1) {
    return false;
  }
  const left = terms[index - 1];
  const right = terms[index + 1];
  return Boolean(
    left
    && right
    && !GENERIC_ANCHOR_TERMS.has(left)
    && !GENERIC_ANCHOR_TERMS.has(right)
  );
}

function extractDistinctiveScopeTerms(value: string): string[] {
  return uniqueTerms(normalizeTopicDiscoveryScientificTerms(value))
    .filter((term) => /\p{L}/u.test(term))
    .filter((term) => !GENERIC_SCOPE_TERMS.has(term));
}

function buildScientificScopeFingerprint(input: {
  contractSource: TopicDiscoveryScopeContract["contractSource"];
  declaredAnchorTerms: string[];
  axes: TopicDiscoveryScopeAxis[];
  priorWorkProbes: TopicDiscoveryPriorWorkProbe[];
}): string {
  const canonicalAxes = input.axes
    .map((axis) => ({ role: axis.role, sourceTerms: [...axis.sourceTerms].sort() }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonicalPriorWorkProbes = input.priorWorkProbes
    .map((probe) => [...probe.sourceTerms].sort())
    .sort((left, right) => left.join("\u0000").localeCompare(right.join("\u0000")));
  return sha256(JSON.stringify({
    termNormalizationVersion: TOPIC_DISCOVERY_TERM_NORMALIZATION_VERSION,
    contractSource: input.contractSource,
    declaredAnchorTerms: [...input.declaredAnchorTerms].sort(),
    axes: canonicalAxes,
    priorWorkProbes: canonicalPriorWorkProbes
  }));
}

function buildScopeContractFingerprint(
  scopeFingerprint: string,
  sharedAnchorTerms: string[],
  queryAnchorTerms: string[]
): string {
  return sha256(JSON.stringify({
    scopeFingerprint,
    sharedAnchorTerms: [...sharedAnchorTerms].sort(),
    queryAnchorTerms
  }));
}

function resolveQueryAnchorTerms(
  units: TopicDiscoveryScopeUnit[],
  declaredAnchorTerms: string[]
): string[] {
  for (const unit of units) {
    if (unit.disposition !== "anchor_authority") {
      continue;
    }
    const surfaceTerms = extractTopicDiscoveryAnchorSurfaceTerms(unit.sourceText);
    if (
      surfaceTerms.length >= TOPIC_DISCOVERY_MIN_ANCHOR_TERMS
      && surfaceTerms.length <= TOPIC_DISCOVERY_MAX_ANCHOR_TERMS
      && haveSameTerms(canonicalizeAnchorTerms(surfaceTerms), declaredAnchorTerms)
    ) {
      return surfaceTerms;
    }
  }
  return [...declaredAnchorTerms];
}

function canonicalizeAnchorTerms(value: string[]): string[] {
  return uniqueTerms(
    normalizeTopicDiscoveryScientificObjectTerms(value.join(" "))
  );
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function haveSameTerms(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((term) => rightSet.has(term));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
