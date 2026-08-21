import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createCollectorCurator(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("collector_curator", [
    "Define paper retrieval query and filters.",
    "Collect candidate papers and de-duplicate.",
    "Curate a high-signal corpus for downstream analysis."
  ], llm);
}
