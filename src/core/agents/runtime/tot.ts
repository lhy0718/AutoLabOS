export interface ThoughtCandidate {
  id: string;
  text: string;
  novelty: number;
  feasibility: number;
  testability: number;
  cost: number;
  expected_gain: number;
}

export interface ToTDecision {
  candidates: ThoughtCandidate[];
  selected: ThoughtCandidate[];
}

export interface ToTConfig {
  branchCount: number;
  topK: number;
}

export const DEFAULT_TOT_CONFIG: ToTConfig = {
  branchCount: 6,
  topK: 2
};

export function runTreeOfThoughts(seedIdeas: string[], cfg: Partial<ToTConfig> = {}): ToTDecision {
  const config = { ...DEFAULT_TOT_CONFIG, ...cfg };

  const candidates: ThoughtCandidate[] = [];
  const base = seedIdeas.length === 0 ? ["baseline"] : seedIdeas;

  for (let i = 0; i < config.branchCount; i += 1) {
    const idea = base[i % base.length];
    const candidate: ThoughtCandidate = {
      id: `cand_${i + 1}`,
      text: `${idea} :: branch ${i + 1}`,
      novelty: score(idea, i, 5),
      feasibility: score(idea, i + 1, 5),
      testability: score(idea, i + 2, 5),
      cost: score(idea, i + 3, 5),
      expected_gain: score(idea, i + 4, 5)
    };
    candidates.push(candidate);
  }

  const selected = [...candidates]
    .sort((a, b) => weightedScore(b) - weightedScore(a) || a.cost - b.cost || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, config.topK));

  return { candidates, selected };
}

export function weightedScore(c: ThoughtCandidate): number {
  return c.novelty + c.feasibility + c.testability + c.expected_gain - c.cost;
}

function score(text: string, offset: number, mod: number): number {
  const raw = text
    .split("")
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return (raw + offset) % (mod + 1);
}
