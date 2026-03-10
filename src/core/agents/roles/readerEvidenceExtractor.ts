import { LLMClient } from "../../llm/client.js";
import { BasicRoleAgent } from "./base.js";

export function createReaderEvidenceExtractor(llm: LLMClient): BasicRoleAgent {
  return new BasicRoleAgent("reader_evidence_extractor", [
    "Plan the analysis first: identify focus sections, target claims, and verification checks before extraction.",
    "Extract a draft structured analysis with grounded evidence slots, datasets, metrics, limitations, and short provenance spans.",
    "Review the draft against the source, remove unsupported claims, and lower confidence when provenance is weak.",
    "Produce traceable evidence items that are conservative when the source is incomplete."
  ], llm);
}
