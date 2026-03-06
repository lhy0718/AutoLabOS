import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createReaderEvidenceExtractor(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("reader_evidence_extractor", [
    "Read each paper and extract structured evidence slots.",
    "Attach confidence and limitations to each evidence item.",
    "Produce evidence IDs for traceability."
  ], llm);
}
