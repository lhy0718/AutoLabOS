import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createReviewerRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("reviewer", [
    "Review argument consistency and evidence links.",
    "Flag unsupported claims and missing baselines.",
    "Provide revision checklist before submission."
  ], llm);
}
