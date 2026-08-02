import type {
  PaperSearchProvider,
  PaperSearchProviderDiagnostics
} from "./types.js";

export const TOPIC_DISCOVERY_PROVIDER_COVERAGE_VERSION = 1;

export interface TopicDiscoveryProviderCoverageAudit {
  version: typeof TOPIC_DISCOVERY_PROVIDER_COVERAGE_VERSION;
  status: "available" | "degraded";
  configured_provider_count: number;
  unavailable_provider_count: number;
  available_providers: PaperSearchProvider[];
  unavailable_providers: PaperSearchProvider[];
  observations_by_provider: Record<PaperSearchProvider, number>;
}

export function assessTopicDiscoveryProviderCoverage(
  diagnostics: PaperSearchProviderDiagnostics[]
): TopicDiscoveryProviderCoverageAudit {
  const observations = new Map<
    PaperSearchProvider,
    PaperSearchProviderDiagnostics[]
  >();
  for (const diagnostic of diagnostics) {
    const current = observations.get(diagnostic.provider) ?? [];
    current.push(diagnostic);
    observations.set(diagnostic.provider, current);
  }

  const providers = [...observations.keys()].sort();
  const unavailableProviders = providers.filter((provider) => {
    const providerDiagnostics = observations.get(provider) ?? [];
    return providerDiagnostics.length > 0
      && providerDiagnostics.every(
        (diagnostic) => Boolean(diagnostic.error) && diagnostic.fetched === 0
      );
  });
  const unavailable = new Set(unavailableProviders);
  const availableProviders = providers.filter((provider) => !unavailable.has(provider));
  const degraded = providers.length >= 3
    && unavailableProviders.length >= 2
    && unavailableProviders.length * 2 >= providers.length;

  return {
    version: TOPIC_DISCOVERY_PROVIDER_COVERAGE_VERSION,
    status: degraded ? "degraded" : "available",
    configured_provider_count: providers.length,
    unavailable_provider_count: unavailableProviders.length,
    available_providers: availableProviders,
    unavailable_providers: unavailableProviders,
    observations_by_provider: Object.fromEntries(
      providers.map((provider) => [
        provider,
        observations.get(provider)?.length ?? 0
      ])
    ) as Record<PaperSearchProvider, number>
  };
}
