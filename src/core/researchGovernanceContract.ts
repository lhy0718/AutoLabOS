export const RESEARCH_GOVERNANCE_PLUGIN_NAME = "autolabos-research-governor" as const;

export const RESEARCH_GOVERNANCE_POSITIONING = {
  primarySurface: "codex_plugin",
  autolabosRole: "governed_research_harness",
  executionEngineRole: "codex_or_external_agent",
  standaloneWorkflowRole: "reference_workflow",
  publicContract: "artifact_gate_contract"
} as const;

export const RESEARCH_GOVERNANCE_ARTIFACTS = [
  "ResearchBrief",
  "EvidenceBundle",
  "GateReport",
  "ReviewReport",
  "MetaHarnessPatchPlan",
  "PaperReadinessBundle"
] as const;

export type ResearchGovernanceArtifact = (typeof RESEARCH_GOVERNANCE_ARTIFACTS)[number];

export type ResearchGovernanceCommandId =
  | "research:new"
  | "research:audit"
  | "research:review"
  | "research:improve"
  | "research:pack";

export type ResearchGovernanceCommand = {
  id: ResearchGovernanceCommandId;
  title: string;
  purpose: string;
  outputArtifact: ResearchGovernanceArtifact;
  requiredGate: string;
  disallowedShortcuts: readonly string[];
};

export const RESEARCH_GOVERNANCE_COMMANDS = [
  {
    id: "research:new",
    title: "Create or repair a governed research brief",
    purpose: "Turn a research intent into an execution contract with baseline, evidence floor, and failure conditions.",
    outputArtifact: "ResearchBrief",
    requiredGate: "brief_contract_completeness",
    disallowedShortcuts: [
      "starting paper-scale work without a baseline or comparator",
      "treating missing evidence floors as harmless prose gaps"
    ]
  },
  {
    id: "research:audit",
    title: "Audit an existing run or external artifact bundle",
    purpose: "Import artifacts without trusting them, then classify missing evidence, done-condition drift, and traceability gaps.",
    outputArtifact: "GateReport",
    requiredGate: "artifact_traceability",
    disallowedShortcuts: [
      "treating external agent completion as research completion",
      "inferring missing metrics, tasks, or baselines from prose"
    ]
  },
  {
    id: "research:review",
    title: "Review paper readiness and claim ceilings",
    purpose: "Decide whether evidence supports a manuscript, a research memo, a system-validation note, or an upstream repair.",
    outputArtifact: "ReviewReport",
    requiredGate: "claim_evidence_alignment",
    disallowedShortcuts: [
      "marking a PDF build as paper ready",
      "allowing claims that outrun executed artifacts"
    ]
  },
  {
    id: "research:improve",
    title: "Strengthen weak nodes from audited failures",
    purpose: "Map review and harness failures to node-local prompt, skill, or validator changes with rollback expectations.",
    outputArtifact: "MetaHarnessPatchPlan",
    requiredGate: "regression_validated_node_repair",
    disallowedShortcuts: [
      "rewriting broad orchestration when a node-local repair is enough",
      "applying meta-harness changes without validation or rollback"
    ]
  },
  {
    id: "research:pack",
    title: "Export a traceable paper-readiness bundle",
    purpose: "Prepare a portable bundle with source artifacts, downgrade decisions, claim evidence, and limitations.",
    outputArtifact: "PaperReadinessBundle",
    requiredGate: "portable_public_bundle",
    disallowedShortcuts: [
      "including private workspace paths or credentials",
      "publishing unreviewed outputs as final scientific claims"
    ]
  }
] as const satisfies readonly ResearchGovernanceCommand[];

export type ResearchGovernanceAdapterCategory =
  | "literature_retrieval"
  | "deep_research_synthesis"
  | "experiment_execution"
  | "code_reproducibility"
  | "paper_review"
  | "fully_automated_research_system";

export type ResearchGovernanceAdapterSurface = {
  category: ResearchGovernanceAdapterCategory;
  role: "import_adapter" | "audit_adapter" | "optional_executor";
  acceptedOutput: ResearchGovernanceArtifact;
  cannotBypassGates: true;
};

export const RESEARCH_GOVERNANCE_ADAPTER_SURFACES = [
  {
    category: "literature_retrieval",
    role: "import_adapter",
    acceptedOutput: "EvidenceBundle",
    cannotBypassGates: true
  },
  {
    category: "deep_research_synthesis",
    role: "audit_adapter",
    acceptedOutput: "EvidenceBundle",
    cannotBypassGates: true
  },
  {
    category: "experiment_execution",
    role: "optional_executor",
    acceptedOutput: "EvidenceBundle",
    cannotBypassGates: true
  },
  {
    category: "code_reproducibility",
    role: "audit_adapter",
    acceptedOutput: "GateReport",
    cannotBypassGates: true
  },
  {
    category: "paper_review",
    role: "audit_adapter",
    acceptedOutput: "ReviewReport",
    cannotBypassGates: true
  },
  {
    category: "fully_automated_research_system",
    role: "import_adapter",
    acceptedOutput: "PaperReadinessBundle",
    cannotBypassGates: true
  }
] as const satisfies readonly ResearchGovernanceAdapterSurface[];

export const RESEARCH_GOVERNANCE_INVARIANTS = [
  "Codex or an external agent may execute work, but AutoLabOS owns the evidence and gate contract.",
  "The standalone workflow remains a reference implementation and compatibility shell.",
  "External artifacts are imported as untrusted evidence until gates classify them.",
  "Review remains a structural gate before paper-writing or paper-ready claims.",
  "Meta-harness changes must target the smallest failing node surface and remain rollback-safe."
] as const;
