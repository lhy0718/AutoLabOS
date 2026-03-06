import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createHypothesisRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("hypothesis_agent", [
    "Generate hypothesis branches from evidence.",
    "Evaluate each branch by novelty and testability.",
    "Select top candidates with clear falsification criteria."
  ], llm);
}
