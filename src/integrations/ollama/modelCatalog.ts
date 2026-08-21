export type OllamaModelRole = "chat" | "research" | "experiment" | "vision";

export interface OllamaModelOption {
  value: string;
  label: string;
  description: string;
}

export interface OllamaRoleModels {
  chat?: string;
  research?: string;
  experiment?: string;
  vision?: string;
}

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

const OLLAMA_ROLE_LABELS: Record<OllamaModelRole, string> = {
  chat: "chat",
  research: "research",
  experiment: "experiment",
  vision: "vision/PDF"
};

export class OllamaModelConfigurationError extends Error {
  readonly code = "ollama_model_not_configured";

  constructor(readonly role: OllamaModelRole) {
    super(
      `Ollama ${OLLAMA_ROLE_LABELS[role]} model is not configured. `
      + "Select an installed model or enter a model identifier in settings."
    );
    this.name = "OllamaModelConfigurationError";
  }
}

export function normalizeOllamaModelNames(models: readonly string[]): string[] {
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

export function buildOllamaModelChoices(
  installedModels: readonly string[] = [],
  configuredModel?: string
): string[] {
  const configured = configuredModel?.trim();
  const installed = normalizeOllamaModelNames(installedModels);
  return configured
    ? [configured, ...installed.filter((model) => model !== configured)]
    : installed;
}

export function buildOllamaModelOptions(
  installedModels: readonly string[] = [],
  configuredModel?: string
): OllamaModelOption[] {
  const installed = new Set(normalizeOllamaModelNames(installedModels));
  return buildOllamaModelChoices(installedModels, configuredModel).map((model) => ({
    value: model,
    label: model,
    description: installed.has(model)
      ? "Installed on the configured Ollama server."
      : "Configured model; not reported by the latest Ollama discovery."
  }));
}

export function buildOllamaChatModelChoices(
  installedModels: readonly string[] = [],
  configuredModel?: string
): string[] {
  return buildOllamaModelChoices(installedModels, configuredModel);
}

export function buildOllamaResearchModelChoices(
  installedModels: readonly string[] = [],
  configuredModel?: string
): string[] {
  return buildOllamaModelChoices(installedModels, configuredModel);
}

export function buildOllamaExperimentModelChoices(
  installedModels: readonly string[] = [],
  configuredModel?: string
): string[] {
  return buildOllamaModelChoices(installedModels, configuredModel);
}

export function buildOllamaVisionModelChoices(
  installedModels: readonly string[] = [],
  configuredModel?: string
): string[] {
  return buildOllamaModelChoices(installedModels, configuredModel);
}

export function getOllamaModelDescription(
  model: string,
  installedModels: readonly string[] = []
): string {
  return new Set(normalizeOllamaModelNames(installedModels)).has(model.trim())
    ? "Installed on the configured Ollama server."
    : "Ollama model.";
}

export function requireOllamaModel(
  model: string | undefined,
  role: OllamaModelRole
): string {
  const configured = model?.trim();
  if (!configured) {
    throw new OllamaModelConfigurationError(role);
  }
  return configured;
}

export function getMissingOllamaModelRoles(models: OllamaRoleModels): OllamaModelRole[] {
  return (Object.keys(OLLAMA_ROLE_LABELS) as OllamaModelRole[])
    .filter((role) => !models[role]?.trim());
}
