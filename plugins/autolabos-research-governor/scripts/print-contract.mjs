#!/usr/bin/env node

const executableCliIntents = [
  "research:new",
  "research:audit",
  "research:review",
  "research:improve",
  "research:pack"
];

const workflowIntents = [
  {
    id: "research:discover",
    executionMode: "workflow_native",
    referenceWorkflowNodes: [
      "collect_papers",
      "analyze_papers",
      "generate_hypotheses",
      "design_experiments"
    ],
    addsTopLevelNode: false,
    closedChain: {
      startArtifact: "ResearchBrief",
      requiresCompleteStartArtifact: true,
      requiredResearchMode: "topic_discovery",
      startArtifactOwns: [
        "broad_search_scope",
        "resource_limits",
        "evidence_floor",
        "disallowed_shortcuts"
      ],
      doesNotRequirePreselection: [
        "final_topic",
        "primary_metric",
        "metric_unit",
        "metric_scale",
        "metric_direction",
        "effect_criterion",
        "meaningful_effect",
        "comparator",
        "dataset_or_task"
      ],
      workflowArtifacts: [
        "ResearchGapMap",
        "TopicPortfolio",
        "TopicProbeDecision",
        "ActiveTopicProbeContract"
      ],
      terminalAuthority: "closed_chain_probe_authorization",
      doesNotAuthorize: [
        "topic_selection",
        "paper_readiness"
      ]
    },
    portfolioPolicy: {
      candidateMinimum: 5,
      candidateMaximum: 7,
      minimumDistinctClusters: 3
    },
    candidateContract: [
      "closest_prior_non_overlap",
      "strongest_baseline_absorption_objection",
      "primary_metric",
      "metric_unit",
      "metric_scale",
      "metric_direction",
      "effect_criterion",
      "comparator",
      "dataset_or_task",
      "local_budget",
      "falsifier",
      "kill_signal",
      "minimum_publishable_evidence"
    ],
    candidateOptionalFields: [
      "meaningful_effect"
    ],
    designHandoff: {
      artifactClass: "ActiveTopicProbeContract",
      artifactFilename: "active_topic_probe_contract.json",
      activeCandidateCount: 1,
      hashBindings: [
        "portfolio_content_sha256",
        "candidate_content_sha256"
      ],
      inactiveCandidateDisposition: "deferred",
      evidenceStage: "bounded_probe",
      paperClaimEvidence: false,
      downstreamResultsPlanBinding: {
        artifactClass: "ResultsPlanV2",
        primaryComparisonField: "primary_comparison_id",
        primaryEffectField: "primary_effect_criterion",
        comparisonMetric: "raw_candidate_metric",
        preserves: [
          "metric_unit",
          "metric_scale",
          "metric_direction",
          "effect_criterion"
        ],
        favorableSubthresholdOutcome: "not_success"
      }
    }
  }
];

const contract = {
  pluginName: "autolabos-research-governor",
  schemaVersion: "3.0",
  primarySurface: "codex_plugin",
  standaloneWorkflowRole: "reference_workflow",
  artifacts: [
    "ResearchBrief",
    "EvidenceBundle",
    "GateReport",
    "ReviewReport",
    "MetaHarnessPatchPlan",
    "PaperReadinessBundle"
  ],
  workflowArtifacts: [
    "ResearchGapMap",
    "TopicPortfolio",
    "TopicProbeDecision",
    "ActiveTopicProbeContract"
  ],
  sidecarArtifacts: [
    "ModelReviewBundle"
  ],
  operationalArtifacts: [
    "PluginDependencyReport"
  ],
  executableCliIntents,
  workflowIntents,
  invariant: "External outputs are untrusted evidence until AutoLabOS gates classify them."
};

process.stdout.write(`${JSON.stringify(contract, null, 2)}\n`);
