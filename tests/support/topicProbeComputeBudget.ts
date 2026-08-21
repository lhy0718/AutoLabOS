import type { TopicProbeComputeBudgetLimits } from "../../src/core/topicProbeComputeBudget.js";

export function makeTopicProbeComputeBudgetLimits(): TopicProbeComputeBudgetLimits {
  return {
    bounded_probe: {
      max_gpu_hours: 2,
      max_concurrent_gpus: 1,
      max_trials: 6
    },
    confirmatory: {
      max_gpu_hours: 8,
      max_concurrent_gpus: 1,
      max_trials: 18
    }
  };
}

export function makeTopicProbeComputeBudgetDeclaration(): string {
  return JSON.stringify(makeTopicProbeComputeBudgetLimits());
}
