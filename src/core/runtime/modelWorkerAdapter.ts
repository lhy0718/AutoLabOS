import { AppConfig, ExecutionProfile, GraphNodeId } from "../../types.js";

export type ModelWorkerKind = "local_runtime" | "external_stronger_model";

export interface ModelWorkerContractSurface {
  version: 1;
  node_id: GraphNodeId;
  worker_kind: ModelWorkerKind;
  execution_profile: ExecutionProfile;
  model: string;
  reasoning_effort?: string;
  governed_node_contract: true;
  artifact_validators_required: true;
  retry_policy_required: true;
  rollback_policy_required: true;
  trace_links_required: true;
  status: "configured";
  notes: string[];
}

export function buildModelWorkerContractSurface(input: {
  nodeId: GraphNodeId;
  config: AppConfig;
  workerKind?: ModelWorkerKind;
  model?: string;
  reasoningEffort?: string;
}): ModelWorkerContractSurface {
  const provider = input.config.providers.llm_mode === "openai_api"
    ? input.config.providers.openai
    : input.config.providers.codex;
  const model =
    input.model ||
    (input.nodeId === "implement_experiments"
      ? provider.experiment_model || provider.model
      : provider.model);
  const reasoningEffort =
    input.reasoningEffort ||
    (input.nodeId === "implement_experiments"
      ? provider.experiment_reasoning_effort || provider.reasoning_effort
      : provider.reasoning_effort);
  const executionProfile = input.config.runtime?.execution_profile || "local";

  return {
    version: 1,
    node_id: input.nodeId,
    worker_kind: input.workerKind || "local_runtime",
    execution_profile: executionProfile,
    model,
    reasoning_effort: reasoningEffort,
    governed_node_contract: true,
    artifact_validators_required: true,
    retry_policy_required: true,
    rollback_policy_required: true,
    trace_links_required: true,
    status: "configured",
    notes: [
      "Worker output remains subordinate to the AutoLabOS node contract.",
      "Artifact validators, retry policy, rollback policy, and trace-link recording are required for this worker surface."
    ]
  };
}
