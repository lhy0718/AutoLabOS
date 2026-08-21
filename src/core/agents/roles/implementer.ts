import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createImplementerRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("implementer", [
    "Generate or patch code according to the plan.",
    "Keep changes minimal and testable.",
    "Report patch summary and unresolved blockers."
  ], llm);
}
