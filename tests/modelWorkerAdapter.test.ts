import { describe, expect, it } from "vitest";

import { buildModelWorkerContractSurface } from "../src/core/runtime/modelWorkerAdapter.js";
import { resolveReviewActorProfiles } from "../src/core/reviewModelProfile.js";
import { AppConfig } from "../src/types.js";

describe("model worker adapter contract surface", () => {
  it("keeps stronger model workers under governed node contracts", () => {
    const surface = buildModelWorkerContractSurface({
      nodeId: "implement_experiments",
      config: makeConfig(),
      workerKind: "external_stronger_model",
      model: "gpt-5.5",
      reasoningEffort: "high"
    });

    expect(surface).toMatchObject({
      version: 1,
      node_id: "implement_experiments",
      worker_kind: "external_stronger_model",
      execution_profile: "local",
      model: "gpt-5.5",
      reasoning_effort: "high",
      governed_node_contract: true,
      artifact_validators_required: true,
      retry_policy_required: true,
      rollback_policy_required: true,
      trace_links_required: true,
      status: "configured"
    });
  });
});

describe("review model routing", () => {
  it("uses Sol at xhigh for Codex review without changing experiment defaults", () => {
    const config = makeConfig();
    const profiles = resolveReviewActorProfiles(config);

    expect(profiles.specialist).toEqual({
      provider: "codex",
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh"
    });
    expect(profiles.meta_reviewer).toEqual(profiles.specialist);
    expect(config.providers.codex.experiment_reasoning_effort).toBe("high");
  });

  it("caps API review at xhigh even though GPT-5.6 also exposes max", () => {
    const config = makeConfig();
    config.providers.llm_mode = "openai_api";
    const profiles = resolveReviewActorProfiles(config);

    expect(profiles.specialist).toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
      reasoning_effort: "xhigh"
    });
    expect(profiles.meta_reviewer).toEqual(profiles.specialist);
  });

  it("uses the highest supported tier for a compatibility model without xhigh", () => {
    const config = makeConfig();
    config.providers.codex.model = "gpt-5.3-codex-spark";
    const profiles = resolveReviewActorProfiles(config);

    expect(profiles.specialist.reasoning_effort).toBe("high");
  });
});

function makeConfig(): AppConfig {
  return {
    version: 1,
    project_name: "AutoLabOS",
    providers: {
      llm_mode: "codex",
      codex: {
        model: "gpt-5.6-sol",
        experiment_model: "gpt-5.6-sol",
        reasoning_effort: "high",
        experiment_reasoning_effort: "high",
        fast_mode: false,
        auth_required: true
      },
      openai: {
        model: "gpt-5.6-sol",
        experiment_model: "gpt-5.6-sol",
        reasoning_effort: "high",
        experiment_reasoning_effort: "high",
        api_key_required: true
      }
    },
    papers: {
      max_results: 30,
      per_second_limit: 1
    },
    research: {
      default_topic: "topic",
      default_constraints: [],
      default_objective_metric: "metric"
    },
    workflow: {
      mode: "agent_approval",
      wizard_enabled: true
    },
    experiments: {
      runner: "local_python",
      timeout_sec: 60
    },
    paper: {
      template: "acl",
      build_pdf: true,
      latex_engine: "auto_install"
    },
    paths: {
      runs_dir: ".autolabos/runs",
      logs_dir: ".autolabos/logs"
    },
    runtime: {
      execution_profile: "local"
    }
  };
}
