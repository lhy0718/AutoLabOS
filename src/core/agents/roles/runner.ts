import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createRunnerRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("runner", [
    "Execute experiments in controlled environment.",
    "Capture logs, metrics, and artifacts.",
    "Surface failures with reproducible commands."
  ], llm);
}
