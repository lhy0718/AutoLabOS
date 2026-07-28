import type { AppConfig } from "../types.js";
import type { ReviewActorProfile } from "./reviewSystem.js";

export interface ReviewActorProfiles {
  configured: boolean;
  specialist: ReviewActorProfile;
  meta_reviewer: ReviewActorProfile;
}

export function resolveReviewActorProfiles(config: AppConfig): ReviewActorProfiles {
  const mode = config.providers?.llm_mode;
  if (mode === "openai_api") {
    const provider = config.providers.openai;
    return finalizeProfiles(
      {
        provider: "openai",
        model: provider.model,
        reasoning_effort: provider.reasoning_effort
      },
      {
        provider: "openai",
        model: provider.experiment_model || provider.model,
        reasoning_effort: provider.experiment_reasoning_effort || provider.reasoning_effort
      }
    );
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
    return finalizeProfiles(
      {
        provider: "codex",
        model: provider.model,
        reasoning_effort: provider.reasoning_effort
      },
      {
        provider: "codex",
        model: provider.experiment_model || provider.model,
        reasoning_effort: provider.experiment_reasoning_effort || provider.reasoning_effort
      }
    );
  }

  return finalizeProfiles(
    { provider: "unconfigured", model: "unconfigured", reasoning_effort: "unconfigured" },
    { provider: "unconfigured", model: "unconfigured", reasoning_effort: "unconfigured" }
  );
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
