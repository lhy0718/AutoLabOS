import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createExperimentDesignerRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("experiment_designer", [
    "Convert hypotheses into executable plans.",
    "Pin datasets, metrics, baselines, and budget constraints.",
    "Freeze experiment plan for implementation."
  ], llm);
}
