import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createAnalystStatisticianRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("analyst_statistician", [
    "Compute statistical summaries and confidence statements.",
    "Generate tables/figures metadata and interpretations.",
    "Identify threats to validity and robustness gaps."
  ], llm);
}
