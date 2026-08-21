import { RunRecord } from "../../types.js";

export function resolveRunByQuery(runs: RunRecord[], query: string): RunRecord | undefined {
  const q = query.trim().toLowerCase();
  if (!q) {
    return undefined;
  }

  const exactId = runs.find((run) => run.id.toLowerCase() === q);
  if (exactId) {
    return exactId;
  }

  const startsWithId = runs.find((run) => run.id.toLowerCase().startsWith(q));
  if (startsWithId) {
    return startsWithId;
  }

  return runs.find((run) => run.title.toLowerCase().includes(q));
}
