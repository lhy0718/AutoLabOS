import type { TopicDiscoverySearchFamilyIntent } from "./semanticScholar.js";
import { resolveTopicDiscoveryRetrievalAnchorMatches } from "../core/runConstraints.js";

export function compileTopicDiscoveryPlainQuery(
  intent: TopicDiscoverySearchFamilyIntent | undefined
): string | undefined {
  const normalized = normalizeIntent(intent);
  if (!normalized) {
    return undefined;
  }
  return [...normalized.sharedAnchorTerms, ...normalized.axisTerms].join(" ");
}

export function compileTopicDiscoveryArxivQuery(
  intent: TopicDiscoverySearchFamilyIntent | undefined
): string | undefined {
  const normalized = normalizeIntent(intent);
  if (!normalized) {
    return undefined;
  }
  const anchor = compileAnchorQuorumQuery(
    normalized.sharedAnchorTerms,
    (term) => `all:${quoteTerm(term)}`
  );
  const axis = normalized.axisTerms
    .map((term) => `all:${quoteTerm(term)}`)
    .join(" OR ");
  return `${anchor} AND (${axis})`;
}

function compileAnchorQuorumQuery(
  terms: string[],
  formatTerm: (term: string) => string
): string {
  const requiredMatches = resolveTopicDiscoveryRetrievalAnchorMatches(terms);
  const combinations = chooseCombinations(terms, requiredMatches);
  const clauses = combinations.map((combination) =>
    combination.map(formatTerm).join(" AND ")
  );
  if (clauses.length === 1) {
    return clauses[0] ?? "";
  }
  return `(${clauses.map((clause) => `(${clause})`).join(" OR ")})`;
}

function chooseCombinations<T>(values: T[], size: number): T[][] {
  if (size <= 0 || values.length < size) {
    return [];
  }
  const combinations: T[][] = [];
  const visit = (start: number, selected: T[]) => {
    if (selected.length === size) {
      combinations.push([...selected]);
      return;
    }
    for (let index = start; index < values.length; index += 1) {
      const value = values[index];
      if (value === undefined) {
        continue;
      }
      selected.push(value);
      visit(index + 1, selected);
      selected.pop();
    }
  };
  visit(0, []);
  return combinations;
}

function normalizeIntent(
  intent: TopicDiscoverySearchFamilyIntent | undefined
): TopicDiscoverySearchFamilyIntent | undefined {
  if (!intent?.familyId?.trim()) {
    return undefined;
  }
  const sharedAnchorTerms = normalizeTerms(intent.sharedAnchorTerms);
  const axisTerms = normalizeTerms(intent.axisTerms);
  if (sharedAnchorTerms.length < 2 || axisTerms.length < 2) {
    return undefined;
  }
  return {
    familyId: intent.familyId.trim(),
    sharedAnchorTerms,
    axisTerms,
    ...(intent.lens?.trim() ? { lens: intent.lens.trim() } : {}),
    ...(intent.contributionIntent?.trim()
      ? { contributionIntent: intent.contributionIntent.trim() }
      : {}),
    ...(intent.contractSource ? { contractSource: intent.contractSource } : {})
  };
}

function normalizeTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of values) {
    const normalized = value
      .normalize("NFKC")
      .replace(/(?<=\p{L})-(?=\p{L})/gu, " ")
      .replace(/[+|()"'`]+/gu, " ")
      .replace(/\b(?:AND|OR|NOT)\b/giu, " ")
      .replace(/\s+/gu, " ")
      .trim()
      .toLowerCase();
    for (const term of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
      if (term.length <= 1 || seen.has(term)) {
        continue;
      }
      seen.add(term);
      terms.push(term);
    }
  }
  return terms;
}

function quotePhrase(value: string): string {
  return `"${value.replace(/"/gu, " ").replace(/\s+/gu, " ").trim()}"`;
}

function quoteTerm(value: string): string {
  return /\s/u.test(value) ? quotePhrase(value) : value;
}
