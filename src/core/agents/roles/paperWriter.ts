import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createPaperWriterRole(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("paper_writer", [
    "Draft sections in publication-ready structure.",
    "Bind claims to evidence references.",
    "Ensure consistency of methods/results narrative."
  ], llm);
}
