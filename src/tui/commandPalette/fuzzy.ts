export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.trim().toLowerCase();
  const c = candidate.toLowerCase();

  if (!q) {
    return 100;
  }

  if (c.startsWith(q)) {
    return 200 - (c.length - q.length);
  }

  const containsIndex = c.indexOf(q);
  if (containsIndex >= 0) {
    return 140 - containsIndex;
  }

  let qi = 0;
  let score = 80;
  for (let ci = 0; ci < c.length && qi < q.length; ci += 1) {
    if (c[ci] === q[qi]) {
      qi += 1;
      score += 3;
    } else {
      score -= 1;
    }
  }

  if (qi === q.length) {
    return score;
  }
  return null;
}
