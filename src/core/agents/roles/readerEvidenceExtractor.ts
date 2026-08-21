import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createReaderEvidenceExtractor(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("reader_evidence_extractor", [
    "Plan the analysis first: identify focus sections, target claims, and verification checks before extraction.",
    "Extract a draft structured analysis with grounded evidence slots, datasets, metrics, limitations, short provenance spans, and concise confidence reasons when needed.",
    "Review the draft against the source, remove unsupported claims, and lower confidence with an explicit claim-level reason when provenance is weak.",
    "Produce traceable evidence items that are conservative when the source is incomplete."
  ], llm);
}
