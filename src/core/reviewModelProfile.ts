import type { AppConfig } from "../types.js";
import { getReasoningEffortChoicesForModel } from "../integrations/codex/modelCatalog.js";
import { normalizeOpenAiResponsesReasoningEffort } from "../integrations/openai/modelCatalog.js";
import type { ReviewActorProfile } from "./reviewSystem.js";

const REVIEW_REASONING_EFFORT = "xhigh";

export interface ReviewActorProfiles {
  configured: boolean;
  specialist: ReviewActorProfile;
  meta_reviewer: ReviewActorProfile;
}

export function resolveReviewActorProfiles(config: AppConfig): ReviewActorProfiles {
  const mode = config.providers?.llm_mode;
  if (mode === "openai_api") {
    const provider = config.providers.openai;
    const profile = {
      provider: "openai",
      model: provider.model,
      reasoning_effort: normalizeOpenAiResponsesReasoningEffort(
        provider.model,
        REVIEW_REASONING_EFFORT
      )
    };
    return finalizeProfiles(profile, profile);
  }

  if (mode === "ollama") {
    const provider = config.providers.ollama;
    return finalizeProfiles(
      {
        provider: "ollama",
        model: provider?.research_model || "",
        reasoning_effort: provider?.research_reasoning_effort || "default"
      },
      {
        provider: "ollama",
        model: provider?.experiment_model || provider?.research_model || "",
        reasoning_effort: provider?.research_reasoning_effort || "default"
      }
    );
  }

  if (mode === "codex" || mode === "codex_chatgpt_only") {
    const provider = config.providers.codex;
    const profile = {
      provider: "codex",
      model: provider.model,
      reasoning_effort: resolveCodexReviewReasoningEffort(provider.model)
    };
    return finalizeProfiles(profile, profile);
  }

  return finalizeProfiles(
    { provider: "unconfigured", model: "unconfigured", reasoning_effort: "unconfigured" },
    { provider: "unconfigured", model: "unconfigured", reasoning_effort: "unconfigured" }
  );
}

function resolveCodexReviewReasoningEffort(model: string): string {
  const supported = getReasoningEffortChoicesForModel(model);
  if (supported.includes(REVIEW_REASONING_EFFORT)) {
    return REVIEW_REASONING_EFFORT;
  }
  return supported.at(-1) || "medium";
}

function finalizeProfiles(
  specialist: ReviewActorProfile,
  metaReviewer: ReviewActorProfile
): ReviewActorProfiles {
  const normalizedSpecialist = normalizeProfile(specialist);
  const normalizedMetaReviewer = normalizeProfile(metaReviewer);
  return {
    configured: isConfigured(normalizedSpecialist) && isConfigured(normalizedMetaReviewer),
    specialist: normalizedSpecialist,
    meta_reviewer: normalizedMetaReviewer
  };
}

function normalizeProfile(profile: ReviewActorProfile): ReviewActorProfile {
  return {
    provider: profile.provider.trim() || "unconfigured",
    model: profile.model.trim() || "unconfigured",
    reasoning_effort: profile.reasoning_effort.trim() || "unconfigured"
  };
}

function isConfigured(profile: ReviewActorProfile): boolean {
  return [profile.provider, profile.model, profile.reasoning_effort].every(
    (value) => value !== "unconfigured"
  );
}
