import { Dispatch, FormEvent, ReactNode, SetStateAction, startTransition, useEffect, useRef, useState } from "react";

import {
  ArtifactEntry,
  BootstrapResponse,
  CheckpointEntry,
  ConfigSummary,
  DoctorCheck,
  DoctorResponse,
  ExplorationStatusResponse,
  HarnessValidationReport,
  KnowledgeFileResponse,
  KnowledgeResponse,
  RepositoryKnowledgeEntry,
  RunJobProjection,
  LiteratureResponse,
  RunRecord,
  RunLiteratureIndex,
  RunInsightCard,
  NodeId,
  WebConfigFormData,
  WebConfigOptions,
  WebSessionState
} from "./types";
import {
  CODEX_TASK_MODEL_DESCRIPTION,
  OPENAI_TASK_MODEL_DESCRIPTION
} from "../../src/modelSlotText.js";
import {
  buildOllamaChatModelChoices,
  buildOllamaExperimentModelChoices,
  buildOllamaResearchModelChoices,
  buildOllamaVisionModelChoices,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_CHAT_MODEL,
  DEFAULT_OLLAMA_EXPERIMENT_MODEL,
  DEFAULT_OLLAMA_RESEARCH_MODEL,
  DEFAULT_OLLAMA_VISION_MODEL
} from "../../src/integrations/ollama/modelCatalog.js";

const NODE_ORDER = [
  "collect_papers",
  "analyze_papers",
  "generate_hypotheses",
  "design_experiments",
  "implement_experiments",
  "run_experiments",
  "analyze_results",
  "figure_audit",
  "review",
  "write_paper"
] as const;

type TabId = "logs" | "artifacts" | "checkpoints" | "knowledge" | "meta" | "workspace" | "doctor";

const DETAIL_TABS: Array<{ id: TabId; label: string }> = [
  { id: "logs", label: "Live logs" },
  { id: "artifacts", label: "Artifacts" },
  { id: "checkpoints", label: "Checkpoints" },
  { id: "knowledge", label: "Knowledge" },
  { id: "meta", label: "Metadata" },
  { id: "workspace", label: "Workspace" },
  { id: "doctor", label: "Doctor" }
];

type SetupFormState = WebConfigFormData & {
  semanticScholarApiKey: string;
  openAiApiKey: string;
};

interface UiActivityState {
  id: number;
  label: string;
}

type ReviewPreviewStatus = "ready" | "warning" | "blocking" | "manual";

interface ReviewPacketPreview {
  generated_at: string;
  readiness: {
    status: Exclude<ReviewPreviewStatus, "manual">;
    ready_checks: number;
    warning_checks: number;
    blocking_checks: number;
    manual_checks: number;
  };
  objective_status: string;
  objective_summary: string;
  recommendation?: {
    action: string;
    target?: string;
    confidence_pct: number;
    reason: string;
    evidence: string[];
  };
  checks: Array<{
    id: string;
    label: string;
    status: ReviewPreviewStatus;
    detail: string;
  }>;
  suggested_actions: string[];
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapResponse | null>(null);
  const [session, setSession] = useState<WebSessionState | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedRun, setSelectedRun] = useState<RunRecord | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([]);
  const [selectedArtifact, setSelectedArtifact] = useState<ArtifactEntry | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<string | null>(null);
  const [expandedInsightReferenceKey, setExpandedInsightReferenceKey] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointEntry[]>([]);
  const [knowledgeEntries, setKnowledgeEntries] = useState<RepositoryKnowledgeEntry[]>([]);
  const [literature, setLiterature] = useState<RunLiteratureIndex | null>(null);
  const [knowledgePreviewPath, setKnowledgePreviewPath] = useState<string | null>(null);
  const [knowledgePreviewContent, setKnowledgePreviewContent] = useState<string | null>(null);
  const [doctorChecks, setDoctorChecks] = useState<DoctorCheck[]>([]);
  const [doctorReadiness, setDoctorReadiness] = useState<DoctorResponse["readiness"] | null>(null);
  const [doctorHarness, setDoctorHarness] = useState<HarnessValidationReport | null>(null);
  const [explorationStatus, setExplorationStatus] = useState<ExplorationStatusResponse | null>(null);
  const [liveJobQueue, setLiveJobQueue] = useState<BootstrapResponse["jobQueue"] | null>(null);
  const [commandInput, setCommandInput] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [activeTab, setActiveTab] = useState<TabId>("logs");
  const [showNewRunForm, setShowNewRunForm] = useState(false);
  const [newRunBrief, setNewRunBrief] = useState("");
  const [newRunTopic, setNewRunTopic] = useState("");
  const [newRunConstraints, setNewRunConstraints] = useState("");
  const [newRunObjective, setNewRunObjective] = useState("");
  const [newRunAutoStart, setNewRunAutoStart] = useState(true);
  const [configOptions, setConfigOptions] = useState<WebConfigOptions>(createDefaultConfigOptions());
  const [setupForm, setSetupForm] = useState<SetupFormState>(createEmptySetupForm());
  const [setupSeeded, setSetupSeeded] = useState(false);
  const [uiActivity, setUiActivity] = useState<UiActivityState | null>(null);
  const uiActivitySeq = useRef(0);

  useEffect(() => {
    void refreshBootstrap();
    void refreshDoctor();
    void refreshKnowledge();
    void refreshJobs();
    void refreshExplorationStatus();
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }
    setExpandedInsightReferenceKey(null);
    setKnowledgePreviewPath(null);
    setKnowledgePreviewContent(null);
    setLiterature(null);
    void refreshRunDetails(selectedRunId);
    void refreshLiterature(selectedRunId);
    void refreshExplorationStatus(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!expandedInsightReferenceKey) {
      return;
    }
    const references = session?.activeRunInsight?.references || [];
    if (!references.some((reference) => buildInsightReferenceKey(reference) === expandedInsightReferenceKey)) {
      setExpandedInsightReferenceKey(null);
    }
  }, [session?.activeRunInsight?.references, expandedInsightReferenceKey]);

  useEffect(() => {
    if (!bootstrap) {
      return;
    }
    if (bootstrap.configOptions) {
      setConfigOptions(bootstrap.configOptions);
    }
    setSession(bootstrap.session);
    setSelectedRunId(bootstrap.activeRunId || bootstrap.runs[0]?.id);
    if (!setupSeeded) {
      setSetupForm(createSetupFormFromBootstrap(bootstrap));
      setSetupSeeded(true);
      setNewRunTopic(bootstrap.setupDefaults.defaultTopic);
      setNewRunConstraints(bootstrap.setupDefaults.defaultConstraints.join(", "));
      setNewRunObjective(bootstrap.setupDefaults.defaultObjectiveMetric);
    }
  }, [bootstrap, setupSeeded]);

  useEffect(() => {
    const source = new EventSource("/api/events/stream");
    source.addEventListener("session_state", (event) => {
      const nextSession = JSON.parse((event as MessageEvent).data) as WebSessionState;
      startTransition(() => {
        setSession(nextSession);
        if (nextSession.activeRunId) {
          setSelectedRunId(nextSession.activeRunId);
        }
      });
    });
    source.addEventListener("runtime_event", () => {
      if (selectedRunId) {
        startTransition(() => {
          void refreshRunDetails(selectedRunId);
        });
      }
      startTransition(() => {
        void refreshJobs();
        void refreshKnowledge();
        void refreshExplorationStatus(selectedRunId);
      });
    });
    source.addEventListener("bootstrap", () => {
      startTransition(() => {
        void refreshBootstrap();
        void refreshJobs();
        void refreshKnowledge();
        void refreshExplorationStatus(selectedRunId);
      });
    });
    return () => {
      source.close();
    };
  }, [selectedRunId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshJobs();
      void refreshExplorationStatus(selectedRunId);
    }, 5000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  const filteredRuns = !bootstrap
    ? []
    : bootstrap.runs.filter((run) => {
        const query = runSearch.trim().toLowerCase();
        if (!query) {
          return true;
        }
        return run.id.toLowerCase().includes(query) || run.title.toLowerCase().includes(query);
      });
  const activeTabLabel = DETAIL_TABS.find((tab) => tab.id === activeTab)?.label || "Inspector";
  const jobRows = bootstrap?.jobs?.runs || [];
  const rawJobQueue = liveJobQueue || bootstrap?.jobQueue;
  const jobQueue = {
    running: rawJobQueue?.running || [],
    waiting: rawJobQueue?.waiting || [],
    stalled: rawJobQueue?.stalled || []
  };
  const completedNodeCount = selectedRun
    ? NODE_ORDER.filter((node) => selectedRun.graph.nodeStates[node]?.status === "completed").length
    : 0;
  const selectedJob = selectedRun
    ? jobRows.find((job) => job.run_id === selectedRun.id) || null
    : null;
  const selectedRunStatusClass = selectedJob
    ? statusToneClass(selectedJob.lifecycle_status)
    : selectedRun
      ? statusToneClass(selectedRun.status)
      : "is-neutral";
  const isBusy = Boolean(session?.busy || uiActivity);
  const activeBusyLabel = session?.busy
    ? session.busyLabel || uiActivity?.label || "Working..."
    : uiActivity?.label;
  const selectedReviewPacket =
    selectedArtifact?.path === "review/review_packet.json" && artifactPreview
      ? parseReviewPacketPreview(artifactPreview)
      : null;
  const selectedCompletenessChecklistArtifact =
    artifacts.find((artifact) => artifact.path === "run_completeness_checklist.json") || null;
  const activeInsight =
    session && selectedRun && session.activeRunId === selectedRun.id ? session.activeRunInsight : null;
  const selectedKnowledgeEntry =
    knowledgeEntries.find((entry) => entry.run_id === (selectedRunId || session?.activeRunId)) || null;
  const activityRun =
    selectedRun ||
    (bootstrap?.runs || []).find((run) => run.id === (session?.activeRunId || selectedRunId));

  async function refreshBootstrap() {
    const data = await api<BootstrapResponse>("/api/bootstrap");
    setBootstrap(data);
    if (data.jobQueue) {
      setLiveJobQueue(data.jobQueue);
    }
  }

  async function refreshJobs() {
    try {
      const data = await api<BootstrapResponse["jobQueue"]>("/api/jobs");
      setLiveJobQueue(data);
    } catch {
      // Older tests and reduced backends may not expose /api/jobs yet.
    }
  }

  async function refreshExplorationStatus(runId?: string) {
    try {
      const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
      const data = await api<ExplorationStatusResponse>(`/api/exploration/status${query}`);
      if (typeof data.enabled === "boolean") {
        setExplorationStatus(data);
      } else {
        setExplorationStatus(null);
      }
    } catch {
      setExplorationStatus(null);
    }
  }

  async function refreshRunDetails(runId: string) {
    const [{ run }, artifactsResponse, checkpointsResponse] = await Promise.all([
      api<{ run: RunRecord }>(`/api/runs/${encodeURIComponent(runId)}`),
      api<{ artifacts: ArtifactEntry[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`),
      api<{ checkpoints: CheckpointEntry[] }>(`/api/runs/${encodeURIComponent(runId)}/checkpoints`)
    ]);
    setSelectedRun(run);
    setArtifacts(artifactsResponse.artifacts);
    setCheckpoints(checkpointsResponse.checkpoints);
    if (selectedArtifact) {
      const nextArtifact = artifactsResponse.artifacts.find((item) => item.path === selectedArtifact.path) || null;
      setSelectedArtifact(nextArtifact);
      if (nextArtifact?.previewable) {
        await loadArtifactPreview(runId, nextArtifact);
        return;
      }
      setArtifactPreview(null);
      return;
    }
    setArtifactPreview(null);
  }

  async function refreshDoctor() {
    const response = await api<DoctorResponse>("/api/doctor");
    setDoctorChecks(response.checks);
    setDoctorReadiness(response.readiness || null);
    setDoctorHarness(response.harness || null);
  }

  async function refreshKnowledge() {
    const response = await api<KnowledgeResponse>("/api/knowledge");
    setKnowledgeEntries(response.entries);
  }

  async function refreshLiterature(runId: string) {
    const response = await api<LiteratureResponse>(`/api/runs/${encodeURIComponent(runId)}/literature`);
    setLiterature(response.literature);
  }

  async function loadKnowledgePreview(relativePath: string) {
    const response = await api<KnowledgeFileResponse>(`/api/knowledge/file?path=${encodeURIComponent(relativePath)}`);
    setKnowledgePreviewPath(response.path);
    setKnowledgePreviewContent(response.content);
  }

  async function loadArtifactPreview(runId: string, artifact: ArtifactEntry) {
    setSelectedArtifact(artifact);
    if (!artifact.previewable || artifact.kind === "directory") {
      setArtifactPreview(null);
      return;
    }
    if (artifact.kind === "image" || artifact.kind === "pdf") {
      setArtifactPreview(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`);
      return;
    }
    const text = await fetch(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`).then((response) => response.text());
    setArtifactPreview(text);
  }

  async function openInsightReference(referencePath: string) {
    const runId = selectedRunId || session?.activeRunId;
    if (!runId) {
      return;
    }
    const artifact =
      artifacts.find((item) => item.path === referencePath) || buildFallbackArtifactEntry(referencePath);
    setActiveTab("artifacts");
    await loadArtifactPreview(runId, artifact);
  }

  async function openKnowledgeArtifact(referencePath: string) {
    await openInsightReference(referencePath);
  }

  async function runSlashSelection(runId: string) {
    await withUiActivity(`Switching to ${runId}`, async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/input", {
        method: "POST",
        body: JSON.stringify({ text: `/run ${runId}` })
      });
      setSession(response.session);
      setSelectedRunId(runId);
      await refreshBootstrap();
    });
  }

  async function submitComposer(event: FormEvent) {
    event.preventDefault();
    if (!commandInput.trim()) {
      return;
    }
    await runSessionCommand(commandInput);
    setCommandInput("");
  }

  async function submitNewRun(event: FormEvent) {
    event.preventDefault();
    const constraints = newRunConstraints
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    await withUiActivity("Creating a new run", async () => {
      const response = await api<{ run: RunRecord; session: WebSessionState }>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          brief: newRunBrief.trim() || undefined,
          topic: newRunTopic,
          constraints,
          objectiveMetric: newRunObjective,
          autoStart: newRunAutoStart
        })
      });
      setShowNewRunForm(false);
      setNewRunBrief("");
      setSession(response.session);
      setSelectedRunId(response.run.id);
      await refreshBootstrap();
      await refreshRunDetails(response.run.id);
    });
  }

  async function submitSetup(event: FormEvent) {
    event.preventDefault();
    await withUiActivity("Saving workspace settings", async () => {
      await api("/api/setup", {
        method: "POST",
        body: JSON.stringify({
          ...setupForm,
          defaultConstraints: setupForm.defaultConstraints
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean)
        })
      });
      await refreshBootstrap();
      await refreshDoctor();
    });
  }

  async function triggerPending(action: "next" | "all" | "cancel") {
    await withUiActivity(labelPendingPlanAction(action), async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/pending", {
        method: "POST",
        body: JSON.stringify({ action })
      });
      setSession(response.session);
      await refreshBootstrap();
      if (selectedRunId) {
        await refreshRunDetails(selectedRunId);
      }
    });
  }

  async function cancelActive() {
    await withUiActivity("Canceling the active task", async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/cancel", {
        method: "POST"
      });
      setSession(response.session);
    });
  }

  async function runAction(endpoint: string, body?: unknown, activityLabel = "Running action") {
    await withUiActivity(activityLabel, async () => {
      const response = await api<{ session: WebSessionState }>(endpoint, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined
      });
      setSession(response.session);
      const nextRunId = response.session.activeRunId || selectedRunId;
      if (nextRunId) {
        setSelectedRunId(nextRunId);
      }
      await refreshBootstrap();
      if (nextRunId) {
        await refreshRunDetails(nextRunId);
      }
    });
  }

  async function runSessionCommand(text: string, activityLabel = `Running ${summarizeCommand(text)}`) {
    await withUiActivity(activityLabel, async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/input", {
        method: "POST",
        body: JSON.stringify({ text })
      });
      setSession(response.session);
      const nextRunId = response.session.activeRunId || selectedRunId;
      if (nextRunId) {
        setSelectedRunId(nextRunId);
      }
      await refreshBootstrap();
      if (nextRunId) {
        await refreshRunDetails(nextRunId);
      }
    });
  }

  async function withUiActivity<T>(label: string, work: () => Promise<T>): Promise<T> {
    const id = uiActivitySeq.current + 1;
    uiActivitySeq.current = id;
    setUiActivity({ id, label });
    try {
      return await work();
    } finally {
      setUiActivity((current) => (current?.id === id ? null : current));
    }
  }

  if (!bootstrap) {
    return (
      <div className="loading-shell" role="status" aria-live="polite">
        <section className="loading-card">
          <p className="eyebrow">AutoLabOS</p>
          <h1>Research Workbench</h1>
          <p>Loading local workspace state from <code>http://127.0.0.1:4317</code>.</p>
          <span className="loading-bar" aria-hidden="true" />
        </section>
      </div>
    );
  }

  if (!bootstrap.configured) {
    return (
      <div className="shell onboarding-shell">
        <div className="panel hero">
          <p className="eyebrow">AutoLabOS Web Ops</p>
          <h1>One screen for the full research loop.</h1>
          <p className="lede">
            Keep setup, runs, workflow controls, and artifacts in a browser UI that stays out of the way.
          </p>
          <div className="chip-list">
            <span className="chip">Onboarding</span>
            <span className="chip">Workflow control</span>
            <span className="chip">Artifacts</span>
            <span className="chip">Live logs</span>
          </div>
        </div>
        <ConfigEditorForm
          className="panel onboarding-form"
          form={setupForm}
          options={configOptions}
          onChange={setSetupForm}
          onSubmit={submitSetup}
          disabled={isBusy}
          heading="Initial setup"
          submitLabel="Initialize workspace"
          apiKeyHelp="API key fields are required on first setup."
        />
      </div>
    );
  }

  return (
    <ResearchWorkbench
      bootstrap={bootstrap}
      session={session}
      selectedRun={selectedRun}
      selectedRunId={selectedRunId}
      filteredRuns={filteredRuns}
      jobRows={jobRows}
      jobQueue={jobQueue}
      selectedJob={selectedJob}
      selectedRunStatusClass={selectedRunStatusClass}
      completedNodeCount={completedNodeCount}
      activeTab={activeTab}
      activeTabLabel={activeTabLabel}
      isBusy={isBusy}
      activeBusyLabel={activeBusyLabel}
      activityRun={activityRun}
      runSearch={runSearch}
      showNewRunForm={showNewRunForm}
      newRunBrief={newRunBrief}
      newRunTopic={newRunTopic}
      newRunConstraints={newRunConstraints}
      newRunObjective={newRunObjective}
      newRunAutoStart={newRunAutoStart}
      commandInput={commandInput}
      artifacts={artifacts}
      selectedArtifact={selectedArtifact}
      artifactPreview={artifactPreview}
      selectedReviewPacket={selectedReviewPacket}
      selectedCompletenessChecklistArtifact={selectedCompletenessChecklistArtifact}
      activeInsight={activeInsight}
      expandedInsightReferenceKey={expandedInsightReferenceKey}
      checkpoints={checkpoints}
      selectedKnowledgeEntry={selectedKnowledgeEntry}
      literature={literature}
      knowledgePreviewPath={knowledgePreviewPath}
      knowledgePreviewContent={knowledgePreviewContent}
      knowledgeEntries={knowledgeEntries}
      doctorChecks={doctorChecks}
      doctorReadiness={doctorReadiness}
      doctorHarness={doctorHarness}
      explorationStatus={explorationStatus}
      setupForm={setupForm}
      configOptions={configOptions}
      onSetRunSearch={setRunSearch}
      onToggleNewRunForm={() => setShowNewRunForm((current) => !current)}
      onCloseNewRunForm={() => setShowNewRunForm(false)}
      onSetNewRunBrief={setNewRunBrief}
      onSetNewRunTopic={setNewRunTopic}
      onSetNewRunConstraints={setNewRunConstraints}
      onSetNewRunObjective={setNewRunObjective}
      onSetNewRunAutoStart={setNewRunAutoStart}
      onSubmitNewRun={submitNewRun}
      onSelectRun={(runId) => void runSlashSelection(runId)}
      onApprove={(runId) => void runAction(`/api/runs/${runId}/actions/approve`, undefined, "Approving current node")}
      onApplyRecommendation={(runId) =>
        void runAction(`/api/runs/${runId}/actions/apply-transition`, undefined, "Applying transition recommendation")
      }
      onRetry={(runId, node) =>
        void runAction(`/api/runs/${runId}/actions/retry`, node ? { node } : undefined, `Retrying ${node ? formatNodeLabel(node) : "current node"}`)
      }
      onOvernight={(runId) =>
        void runAction(`/api/runs/${runId}/actions/overnight`, undefined, "Starting autonomy preset: overnight")
      }
      onRunNode={(runId, node) =>
        void runAction(`/api/runs/${runId}/actions/run-node`, { node }, `Running ${formatNodeLabel(node)}`)
      }
      onJumpNode={(runId, node) =>
        void runAction(`/api/runs/${runId}/actions/jump`, { node, force: true }, `Jumping to ${formatNodeLabel(node)}`)
      }
      onCancelActive={() => void cancelActive()}
      onSetActiveTab={setActiveTab}
      onSetCommandInput={setCommandInput}
      onSubmitComposer={submitComposer}
      onTriggerPending={(action) => void triggerPending(action)}
      onRunSessionCommand={(text, label) => void runSessionCommand(text, label)}
      onOpenInsightReference={(path) => void openInsightReference(path)}
      onToggleInsightReference={(key) =>
        setExpandedInsightReferenceKey((current) => (current === key ? null : key))
      }
      onLoadArtifactPreview={(runId, artifact) => void loadArtifactPreview(runId, artifact)}
      onLoadKnowledgePreview={(path) => void loadKnowledgePreview(path)}
      onOpenKnowledgeArtifact={(path) => void openKnowledgeArtifact(path)}
      onSetSelectedRunId={setSelectedRunId}
      onSubmitSetup={submitSetup}
      onSetSetupForm={setSetupForm}
    />
  );
}

interface ResearchWorkbenchProps {
  bootstrap: BootstrapResponse;
  session: WebSessionState | null;
  selectedRun: RunRecord | null;
  selectedRunId: string | undefined;
  filteredRuns: RunRecord[];
  jobRows: RunJobProjection[];
  jobQueue: NonNullable<BootstrapResponse["jobQueue"]>;
  selectedJob: RunJobProjection | null;
  selectedRunStatusClass: string;
  completedNodeCount: number;
  activeTab: TabId;
  activeTabLabel: string;
  isBusy: boolean;
  activeBusyLabel: string | undefined;
  activityRun: RunRecord | undefined;
  runSearch: string;
  showNewRunForm: boolean;
  newRunBrief: string;
  newRunTopic: string;
  newRunConstraints: string;
  newRunObjective: string;
  newRunAutoStart: boolean;
  commandInput: string;
  artifacts: ArtifactEntry[];
  selectedArtifact: ArtifactEntry | null;
  artifactPreview: string | null;
  selectedReviewPacket: ReviewPacketPreview | null;
  selectedCompletenessChecklistArtifact: ArtifactEntry | null;
  activeInsight: RunInsightCard | null;
  expandedInsightReferenceKey: string | null;
  checkpoints: CheckpointEntry[];
  selectedKnowledgeEntry: RepositoryKnowledgeEntry | null;
  literature: RunLiteratureIndex | null;
  knowledgePreviewPath: string | null;
  knowledgePreviewContent: string | null;
  knowledgeEntries: RepositoryKnowledgeEntry[];
  doctorChecks: DoctorCheck[];
  doctorReadiness: DoctorResponse["readiness"] | null;
  doctorHarness: HarnessValidationReport | null;
  explorationStatus: ExplorationStatusResponse | null;
  setupForm: SetupFormState;
  configOptions: WebConfigOptions;
  onSetRunSearch: (value: string) => void;
  onToggleNewRunForm: () => void;
  onCloseNewRunForm: () => void;
  onSetNewRunBrief: (value: string) => void;
  onSetNewRunTopic: (value: string) => void;
  onSetNewRunConstraints: (value: string) => void;
  onSetNewRunObjective: (value: string) => void;
  onSetNewRunAutoStart: (value: boolean) => void;
  onSubmitNewRun: (event: FormEvent) => Promise<void>;
  onSelectRun: (runId: string) => void;
  onApprove: (runId: string) => void;
  onApplyRecommendation: (runId: string) => void;
  onRetry: (runId: string, node?: NodeId) => void;
  onOvernight: (runId: string) => void;
  onRunNode: (runId: string, node: NodeId) => void;
  onJumpNode: (runId: string, node: NodeId) => void;
  onCancelActive: () => void;
  onSetActiveTab: (tab: TabId) => void;
  onSetCommandInput: (value: string) => void;
  onSubmitComposer: (event: FormEvent) => Promise<void>;
  onTriggerPending: (action: "next" | "all" | "cancel") => void;
  onRunSessionCommand: (text: string, label?: string) => void;
  onOpenInsightReference: (path: string) => void;
  onToggleInsightReference: (key: string) => void;
  onLoadArtifactPreview: (runId: string, artifact: ArtifactEntry) => void;
  onLoadKnowledgePreview: (path: string) => void;
  onOpenKnowledgeArtifact: (path: string) => void;
  onSetSelectedRunId: (runId: string) => void;
  onSubmitSetup: (event: FormEvent) => Promise<void>;
  onSetSetupForm: Dispatch<SetStateAction<SetupFormState>>;
}

function ResearchWorkbench(props: ResearchWorkbenchProps) {
  return (
    <div className="workbench-shell">
      <WorkbenchRail {...props} />
      <main className="workbench-main">
        <RuntimeRibbon {...props} />
        {props.selectedRun ? (
          <>
            <ResearchRunHero {...props} />
            <EvidenceBoard {...props} />
            <WorkflowMap {...props} />
          </>
        ) : (
          <section className="workbench-card empty-run-state">
            <p className="eyebrow">Run selection</p>
            <h2>No run selected</h2>
            <p>Choose a run from the rail or create a new run to inspect the workflow.</p>
          </section>
        )}
        <PendingPlanQueue {...props} />
      </main>
      <WorkbenchInspector {...props} />
    </div>
  );
}

function WorkbenchRail(props: ResearchWorkbenchProps) {
  return (
    <aside className="workbench-rail">
      <section className="rail-intro">
        <p className="eyebrow">AutoLabOS</p>
        <h1>Research Workbench</h1>
        <p>{props.bootstrap.configSummary?.projectName || "Governed research workspace"}</p>
        <div className="chip-list">
          <span className="chip">{labelWorkflowMode(props.bootstrap.configSummary?.workflowMode)}</span>
          <span className="chip">{labelApprovalMode(props.bootstrap.configSummary?.approvalMode)}</span>
          <span className="chip">{labelProviderMode(props.bootstrap.configSummary?.llmMode)}</span>
          <span className="chip">{labelPdfMode(props.bootstrap.configSummary?.pdfMode)}</span>
        </div>
        <small>Autonomy preset: Overnight safe policy on demand via <code>/agent overnight</code>.</small>
        <small>Research backend: {props.bootstrap.configSummary?.researchBackendModel} · {props.bootstrap.configSummary?.researchBackendReasoning}</small>
        <small>Experiment: {props.bootstrap.configSummary?.experimentModel} · {props.bootstrap.configSummary?.experimentReasoning}</small>
      </section>

      <section className="rail-panel">
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Runs</p>
            <h2>Workspace runs</h2>
          </div>
          <span className="count-badge">{props.filteredRuns.length}</span>
        </div>
        <div className="rail-toolbar">
          <input
            placeholder="Search runs"
            value={props.runSearch}
            onChange={(event) => props.onSetRunSearch(event.target.value)}
          />
          <button className="button button-primary" type="button" disabled={props.isBusy} onClick={props.onToggleNewRunForm}>
            {props.showNewRunForm ? "Close" : "New run"}
          </button>
        </div>
        {props.showNewRunForm ? <NewRunComposer {...props} /> : null}
        <div className="run-ledger">
          {props.filteredRuns.length === 0 ? (
            <div className="inline-empty">No runs match this search yet.</div>
          ) : (
            props.filteredRuns.map((run) => {
              const job = props.jobRows.find((item) => item.run_id === run.id) || null;
              const lifecycleStatus = job?.lifecycle_status || run.status;
              return (
                <button
                  key={run.id}
                  className={`run-ledger-item ${props.selectedRunId === run.id ? "selected" : ""}`}
                  type="button"
                  disabled={props.isBusy}
                  onClick={() => props.onSelectRun(run.id)}
                >
                  <span className={`status-dot ${statusToneClass(lifecycleStatus)}`} />
                  <strong>{run.title}</strong>
                  <span>{formatNodeLabel(run.currentNode)} · {formatTimestamp(job?.last_event_at || run.updatedAt)}</span>
                  {job ? (
                    <>
                      <span>Next: {formatRunRecommendedAction(job.recommended_next_action)}</span>
                      <span>A/R/P: {formatReadinessTriple(job)}</span>
                    </>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      </section>

      {props.bootstrap.jobs?.top_failures?.length ? (
        <section className="rail-panel">
          <p className="section-kicker">Top failures</p>
          {props.bootstrap.jobs.top_failures.map((failure) => (
            <article key={failure.key} className="mini-finding">
              <strong>{Math.round(failure.recurrence_probability * 100)}% · {failure.reason}</strong>
              <span>Fix: {failure.remediation}</span>
            </article>
          ))}
        </section>
      ) : null}

      <section className="rail-panel">
        <p className="section-kicker">Live watch</p>
        {renderLiveWatchTable(props.jobQueue)}
      </section>
      <section className="rail-panel">
        <p className="section-kicker">Exploration engine</p>
        {renderExplorationStatusCard(props.explorationStatus)}
      </section>
      <section className="rail-panel">
        <p className="section-kicker">Background jobs</p>
        {renderJobBucket("Running", props.jobQueue.running)}
        {renderJobBucket("Waiting", props.jobQueue.waiting)}
        {renderJobBucket("Stalled", props.jobQueue.stalled)}
      </section>
    </aside>
  );
}

function NewRunComposer(props: ResearchWorkbenchProps) {
  return (
    <form className="workbench-form new-run-form" onSubmit={props.onSubmitNewRun}>
      <label>
        Research brief
        <textarea
          disabled={props.isBusy}
          value={props.newRunBrief}
          onChange={(event) => props.onSetNewRunBrief(event.target.value)}
          rows={4}
          placeholder="Describe the topic, objective, constraints, and experiment plan in natural language."
        />
      </label>
      <label>
        Topic
        <input disabled={props.isBusy} value={props.newRunTopic} onChange={(event) => props.onSetNewRunTopic(event.target.value)} />
      </label>
      <label>
        Constraints
        <input disabled={props.isBusy} value={props.newRunConstraints} onChange={(event) => props.onSetNewRunConstraints(event.target.value)} />
      </label>
      <label>
        Objective
        <input disabled={props.isBusy} value={props.newRunObjective} onChange={(event) => props.onSetNewRunObjective(event.target.value)} />
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          disabled={props.isBusy}
          checked={props.newRunAutoStart}
          onChange={(event) => props.onSetNewRunAutoStart(event.target.checked)}
        />
        <span>Auto-start research after creating the run</span>
      </label>
      <div className="form-actions">
        <button className="button button-primary" type="submit" disabled={props.isBusy}>
          {props.isBusy ? "Working..." : "Create run"}
        </button>
        <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onCloseNewRunForm}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function RuntimeRibbon(props: ResearchWorkbenchProps) {
  if (!props.isBusy || !props.activeBusyLabel) {
    return null;
  }
  return (
    <section className="runtime-ribbon" role="status" aria-live="polite">
      <span className="activity-spinner" aria-hidden="true" />
      <div>
        <p className="section-kicker">Runtime activity</p>
        <h2>{props.activeBusyLabel}</h2>
        <p>
          {props.activityRun
            ? `${props.activityRun.title} · ${formatNodeLabel(props.activityRun.currentNode)}`
            : "Waiting for live session updates and artifact refreshes."}
        </p>
      </div>
      {props.session?.canCancel ? (
        <button className="button button-danger" type="button" onClick={props.onCancelActive}>
          Cancel active task
        </button>
      ) : null}
    </section>
  );
}

function ResearchRunHero(props: ResearchWorkbenchProps) {
  if (!props.selectedRun) {
    return null;
  }
  const transition = props.selectedRun.graph.pendingTransition;
  const decisionFocus =
    props.selectedJob?.blocker_summary ||
    (transition
      ? `${transition.action}${transition.targetNode ? ` toward ${formatNodeLabel(transition.targetNode)}` : ""}: ${transition.reason}`
      : props.selectedRun.latestSummary || "No blocking decision is currently attached to this run.");

  return (
    <section className="run-hero">
      <div className="hero-copy">
        <p className="eyebrow">Selected run</p>
        <div className="title-row">
          <h2>{props.selectedRun.title}</h2>
          <span className={`status-pill ${props.selectedRunStatusClass}`}>
            {formatStatusLabel(props.selectedJob?.lifecycle_status || props.selectedRun.status)}
          </span>
        </div>
        <p className="run-topic">{props.selectedRun.topic}</p>
        <div className="signal-row">
          <span>Node: {formatNodeLabel(props.selectedRun.currentNode)}</span>
          <span>Progress: {props.completedNodeCount}/{NODE_ORDER.length}</span>
          <span>Checkpoint #{props.selectedRun.graph.checkpointSeq}</span>
          {props.selectedJob ? <span>Next action: {formatRunRecommendedAction(props.selectedJob.recommended_next_action)}</span> : null}
        </div>
      </div>
      <div className="hero-actions">
        <button className="button button-primary" type="button" disabled={props.isBusy} onClick={() => props.onApprove(props.selectedRun!.id)}>
          Approve
        </button>
        {transition ? (
          <button className="button button-primary button-warm" type="button" disabled={props.isBusy} onClick={() => props.onApplyRecommendation(props.selectedRun!.id)}>
            Apply recommendation
          </button>
        ) : (
          <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={() => props.onRetry(props.selectedRun!.id)}>
            Retry
          </button>
        )}
        {props.session?.canCancel ? (
          <button className="button button-danger" type="button" onClick={props.onCancelActive}>
            Cancel active task
          </button>
        ) : null}
      </div>
      <article className="decision-focus">
        <span className="next-action-label">Decision focus</span>
        <p>{decisionFocus}</p>
      </article>
    </section>
  );
}

function EvidenceBoard(props: ResearchWorkbenchProps) {
  if (!props.selectedRun) {
    return null;
  }
  return (
    <section className="workbench-card evidence-board">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Governance state</p>
          <h2>Evidence, gates, and next moves</h2>
        </div>
        <span className={`status-pill ${props.selectedRunStatusClass}`}>
          {formatStatusLabel(props.selectedJob?.lifecycle_status || props.selectedRun.status)}
        </span>
      </div>
      <div className="metric-grid">
        <article><span>Current node</span><strong>{formatNodeLabel(props.selectedRun.currentNode)}</strong></article>
        <article><span>Progress</span><strong>{props.completedNodeCount}/{NODE_ORDER.length}</strong></article>
        <article><span>Checkpoint</span><strong>#{props.selectedRun.graph.checkpointSeq}</strong></article>
        {props.selectedJob ? <article><span>Readiness</span><strong>{formatReadinessTriple(props.selectedJob)}</strong></article> : null}
        {props.selectedJob?.review_gate_status ? (
          <article><span>Review gate</span><strong>{props.selectedJob.review_gate_label || formatReviewGateStatus(props.selectedJob.review_gate_status, props.selectedJob.review_decision_outcome, props.selectedJob.review_recommended_transition)}</strong></article>
        ) : null}
        {props.selectedJob?.paper_readiness_state ? (
          <article><span>Paper state</span><strong>{props.selectedJob.paper_gate_label || props.selectedJob.paper_readiness_state}</strong></article>
        ) : null}
        {props.selectedCompletenessChecklistArtifact ? (
          <article>
            <span>Completeness</span>
            <button className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onOpenInsightReference("run_completeness_checklist.json")}>
              Open checklist
            </button>
          </article>
        ) : null}
      </div>
      {props.selectedRun.constraints.length ? (
        <div className="chip-list">
          {props.selectedRun.constraints.map((constraint) => <span key={constraint} className="chip">{constraint}</span>)}
        </div>
      ) : null}
      {props.selectedRun.graph.pendingTransition ? <TransitionPanel {...props} /> : null}
      {props.activeInsight ? <InsightPanel {...props} /> : null}
      <div className="decision-actions">
        <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={() => props.onOvernight(props.selectedRun!.id)}>
          Overnight preset
        </button>
        <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={() => props.onRetry(props.selectedRun!.id)}>
          Retry current node
        </button>
      </div>
    </section>
  );
}

function TransitionPanel(props: ResearchWorkbenchProps) {
  const transition = props.selectedRun?.graph.pendingTransition;
  if (!props.selectedRun || !transition) {
    return null;
  }
  return (
    <article className="sub-panel transition-panel">
      <p className="section-kicker">Transition recommendation</p>
      <h3>{transition.action}{transition.targetNode ? ` -> ${formatNodeLabel(transition.targetNode)}` : ""}</h3>
      <p>{transition.reason}</p>
      <span>Confidence {transition.confidence.toFixed(2)} · {transition.autoExecutable ? "auto-executable" : "review first"}</span>
      <div className="chip-list">
        {transition.evidence.map((item) => <span key={item} className="chip">{item}</span>)}
      </div>
      <div className="decision-actions">
        <button className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy} onClick={() => props.onRunSessionCommand("/agent apply", "Applying transition recommendation")}>
          <span>Apply recommendation</span>
          <code>/agent apply</code>
        </button>
        {transition.autoExecutable ? (
          <button className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy} onClick={() => props.onRunSessionCommand("/agent overnight", "Starting autonomy preset: overnight")}>
            <span>Start overnight preset</span>
            <code>/agent overnight</code>
          </button>
        ) : null}
      </div>
    </article>
  );
}

function InsightPanel(props: ResearchWorkbenchProps) {
  const insight = props.activeInsight;
  if (!insight) {
    return null;
  }
  return (
    <article className="sub-panel insight-panel">
      <p className="section-kicker">{insight.title}</p>
      {insight.manuscriptQuality ? <ManuscriptQualitySummary insight={insight.manuscriptQuality} onOpen={props.onOpenInsightReference} isBusy={props.isBusy} /> : null}
      {insight.readinessRisks ? <ReadinessRiskSummary insight={insight.readinessRisks} onOpen={props.onOpenInsightReference} isBusy={props.isBusy} /> : null}
      <div className="insight-list">
        {insight.lines.map((line) => <p key={line} className="insight-line">{line}</p>)}
      </div>
      {insight.actions?.length ? (
        <div className="decision-actions">
          {insight.actions.map((action) => (
            <button key={`${action.label}-${action.command}`} className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy} onClick={() => props.onRunSessionCommand(action.command, `${action.label} · ${action.command}`)}>
              <span>{action.label}</span>
              <code>{action.command}</code>
            </button>
          ))}
        </div>
      ) : null}
      {insight.references?.length ? (
        <div className="reference-grid">
          {insight.references.map((reference) => {
            const key = buildInsightReferenceKey(reference);
            const expanded = props.expandedInsightReferenceKey === key;
            return (
              <article key={key} className={`reference-card ${expanded ? "expanded" : ""}`}>
                <button className="button button-ghost button-small insight-reference" type="button" aria-expanded={expanded} onClick={() => props.onToggleInsightReference(key)}>
                  <span className="reference-kind">{labelInsightReferenceKind(reference.kind)}</span>
                  <span>{reference.label}</span>
                  <code>{reference.path}</code>
                  <small>{reference.summary}</small>
                </button>
                {reference.facts?.length ? (
                  <div className="chip-list">
                    {reference.facts.map((fact) => <span key={`${key}-${fact.label}-${fact.value}`} className="chip">{fact.label} {fact.value}</span>)}
                  </div>
                ) : null}
                {expanded ? (
                  <div className="reference-detail">
                    {(reference.details || ["No additional grounded detail is attached to this evidence card yet."]).map((detail) => (
                      <p key={`${key}-${detail}`}>{detail}</p>
                    ))}
                    <button className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onOpenInsightReference(reference.path)} aria-label={`Open artifact for ${reference.label}`}>
                      Open artifact
                    </button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}

function ManuscriptQualitySummary(props: {
  insight: NonNullable<RunInsightCard["manuscriptQuality"]>;
  onOpen: (path: string) => void;
  isBusy: boolean;
}) {
  return (
    <div className="quality-summary">
      <div className="chip-list">
        <span className={`status-pill ${manuscriptQualityStatusToneClass(props.insight.status)}`}>{formatManuscriptQualityStatus(props.insight.status)}</span>
        <span className="chip">{props.insight.displayReasonLabel || formatManuscriptQualityReason(props.insight.reasonCategory)}</span>
        <span className="chip">{formatManuscriptQualityStage(props.insight.stage)}</span>
      </div>
      <div className="quality-grid">
        {buildManuscriptQualityGroupCards(props.insight).map((group) => (
          <article key={group.key} className="quality-group">
            <strong>{group.label}</strong>
            <span className={`status-pill ${group.toneClass}`}>{group.items.length}</span>
            {group.items.slice(0, 3).map((item) => <p key={`${group.key}-${item.code}-${item.message}`}><strong>{item.code}</strong> · {item.section} · {item.message}</p>)}
          </article>
        ))}
      </div>
      <div className="decision-actions">
        {props.insight.artifactRefs.map((artifactRef) => (
          <button key={`${artifactRef.label}-${artifactRef.path}`} className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onOpen(artifactRef.path)}>
            {artifactRef.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReadinessRiskSummary(props: {
  insight: NonNullable<RunInsightCard["readinessRisks"]>;
  onOpen: (path: string) => void;
  isBusy: boolean;
}) {
  return (
    <div className="quality-summary">
      <div className="metric-grid">
        <article><span>Readiness State</span><strong>{props.insight.readinessState}</strong></article>
        <article><span>Blocked Risks</span><strong>{props.insight.riskCounts.blocked}</strong></article>
        <article><span>Warning Risks</span><strong>{props.insight.riskCounts.warning}</strong></article>
      </div>
      <div className="quality-grid">
        {buildReadinessRiskGroupCards(props.insight).map((group) => (
          <article key={group.key} className="quality-group">
            <strong>{group.label}</strong>
            <span className={`status-pill ${group.toneClass}`}>{group.items.length}</span>
            {group.items.slice(0, 3).map((item) => <p key={`${group.key}-${item.code}-${item.message}`}><strong>{item.code}</strong> · {item.section} · {item.message}</p>)}
          </article>
        ))}
      </div>
      <div className="decision-actions">
        {props.insight.artifactRefs.map((artifactRef) => (
          <button key={`${artifactRef.label}-${artifactRef.path}`} className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onOpen(artifactRef.path)}>
            {artifactRef.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function WorkflowMap(props: ResearchWorkbenchProps) {
  if (!props.selectedRun) {
    return null;
  }
  return (
    <section className="workbench-card workflow-map">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Workflow</p>
          <h3>Workflow state graph</h3>
        </div>
        <span className="count-badge">{props.completedNodeCount}/{NODE_ORDER.length} complete</span>
      </div>
      <div className="node-map">
        {NODE_ORDER.map((node, index) => {
          const state = props.selectedRun!.graph.nodeStates[node] ?? {
            status: "pending",
            note: null,
            lastError: null,
            updatedAt: props.selectedRun!.updatedAt
          };
          const current = props.selectedRun!.currentNode === node;
          return (
            <article key={node} className={`node-tile status-${state.status} ${current ? "current" : ""}`}>
              <span className="node-index">{index + 1}</span>
              <div>
                <h3>{formatNodeLabel(node)}</h3>
                <p>{state.note || state.lastError || "No node note yet."}</p>
              </div>
              <span className={`status-pill ${statusToneClass(state.status)}`}>{formatStatusLabel(state.status)}</span>
              <div className="node-actions">
                <button className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onRunNode(props.selectedRun!.id, node)}>Run</button>
                <button className="button button-secondary button-small" type="button" disabled={props.isBusy} onClick={() => props.onRetry(props.selectedRun!.id, node)}>Retry</button>
                <button className="button button-ghost button-small" type="button" disabled={props.isBusy} onClick={() => props.onJumpNode(props.selectedRun!.id, node)}>Jump</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PendingPlanQueue(props: ResearchWorkbenchProps) {
  const plan = props.session?.pendingPlan;
  if (!plan) {
    return null;
  }
  return (
    <section className="workbench-card pending-queue">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Pending plan</p>
          <h3>Step {plan.stepIndex + 1} of {plan.totalSteps}</h3>
        </div>
        <span className="count-badge">{plan.totalSteps} queued</span>
      </div>
      <ol className="command-list">
        {plan.displayCommands.map((command) => <li key={command}>{command}</li>)}
      </ol>
      <div className="decision-actions">
        <button className="button button-primary" type="button" disabled={props.isBusy} onClick={() => props.onTriggerPending("next")}>Run next</button>
        {plan.totalSteps > 1 ? <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={() => props.onTriggerPending("all")}>Run all</button> : null}
        <button className="button button-danger" type="button" disabled={props.isBusy} onClick={() => props.onTriggerPending("cancel")}>Cancel</button>
      </div>
    </section>
  );
}

function WorkbenchInspector(props: ResearchWorkbenchProps) {
  return (
    <aside className="workbench-inspector">
      <div className="inspector-header">
        <div>
          <p className="section-kicker">Inspector</p>
          <h2>{props.activeTabLabel}</h2>
        </div>
      </div>
      <div className="inspector-tabs">
        {DETAIL_TABS.map((tab) => (
          <button key={tab.id} className={`tab-button ${props.activeTab === tab.id ? "active" : ""}`} type="button" onClick={() => props.onSetActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {props.activeTab === "logs" ? <LogsPane {...props} /> : null}
        {props.activeTab === "artifacts" ? <ArtifactsPane {...props} /> : null}
        {props.activeTab === "checkpoints" ? <CheckpointsPane {...props} /> : null}
        {props.activeTab === "knowledge" ? <KnowledgePane {...props} /> : null}
        {props.activeTab === "meta" ? <MetaPane {...props} /> : null}
        {props.activeTab === "workspace" ? (
          <ConfigEditorForm
            className="workbench-form"
            form={props.setupForm}
            options={props.configOptions}
            onChange={props.onSetSetupForm}
            onSubmit={props.onSubmitSetup}
            disabled={props.isBusy}
            heading="Workspace settings"
            submitLabel="Save settings"
            apiKeyHelp="Leave API key fields blank to keep the current stored value."
          />
        ) : null}
        {props.activeTab === "doctor" ? <DoctorPane {...props} /> : null}
      </div>
      <form className="command-console" onSubmit={props.onSubmitComposer}>
        <div className="panel-heading">
          <div>
            <p className="section-kicker">Command input</p>
            <h3>{props.activeTab === "logs" ? "Logs and input together" : "Run a command"}</h3>
          </div>
          <span className={`status-pill ${props.isBusy ? "is-active" : "is-neutral"}`}>{props.isBusy ? props.activeBusyLabel || "Working..." : "Idle"}</span>
        </div>
        <label className="field-label">
          Prompt
          <textarea value={props.commandInput} onChange={(event) => props.onSetCommandInput(event.target.value)} placeholder="collect 100 papers from the last 5 years by relevance" rows={3} disabled={props.isBusy} />
        </label>
        <div className="composer-actions">
          <button className="button button-primary" type="submit" disabled={props.isBusy}>{props.isBusy ? "Running..." : "Send"}</button>
          {props.session?.canCancel ? <button className="button button-danger" type="button" onClick={props.onCancelActive}>Cancel active task</button> : null}
        </div>
      </form>
    </aside>
  );
}

function LogsPane(props: ResearchWorkbenchProps) {
  const logs = props.session?.logs || [];
  return logs.length === 0 ? (
    <div className="inline-empty">Live runtime output will appear here.</div>
  ) : (
    <div className="log-list">{logs.slice(-80).map((line, index) => <pre key={`${line}-${index}`} className="log-line">{line}</pre>)}</div>
  );
}

function ArtifactsPane(props: ResearchWorkbenchProps) {
  return (
    <div className="artifact-workspace">
      <div className="artifact-list">
        {props.artifacts.length === 0 ? (
          <div className="inline-empty">No artifacts for this run yet.</div>
        ) : (
          props.artifacts.map((artifact) => (
            <button key={artifact.path} className={`artifact-item ${props.selectedArtifact?.path === artifact.path ? "selected" : ""}`} type="button" onClick={() => props.selectedRunId && props.onLoadArtifactPreview(props.selectedRunId, artifact)}>
              <span>{artifact.path}</span>
              <small>{labelArtifactKind(artifact.kind)} · {formatBytes(artifact.size)}</small>
            </button>
          ))
        )}
      </div>
      <ArtifactPreviewPane {...props} />
    </div>
  );
}

function ArtifactPreviewPane(props: ResearchWorkbenchProps) {
  if (!props.selectedArtifact) {
    return <div className="inline-empty">Choose an artifact to preview it here.</div>;
  }
  if (props.selectedArtifact.kind === "image" && props.artifactPreview) {
    return <div className="artifact-preview"><img src={props.artifactPreview} alt={props.selectedArtifact.path} /></div>;
  }
  if (props.selectedArtifact.kind === "pdf" && props.artifactPreview) {
    return <div className="artifact-preview"><iframe src={props.artifactPreview} title={props.selectedArtifact.path} /></div>;
  }
  if (props.selectedArtifact.path === "review/review_packet.json" && props.selectedReviewPacket) {
    return <ReviewPacketPreviewPane packet={props.selectedReviewPacket} isBusy={props.isBusy} onRunSessionCommand={props.onRunSessionCommand} />;
  }
  if (props.selectedArtifact.kind === "text" || props.selectedArtifact.kind === "json") {
    return <div className="artifact-preview"><pre>{props.artifactPreview}</pre></div>;
  }
  return (
    <a className="button button-secondary" href={`/api/runs/${encodeURIComponent(props.selectedRunId || "")}/artifact?path=${encodeURIComponent(props.selectedArtifact.path)}`} target="_blank" rel="noreferrer">
      Download artifact
    </a>
  );
}

function ReviewPacketPreviewPane(props: {
  packet: ReviewPacketPreview;
  isBusy: boolean;
  onRunSessionCommand: (command: string, label?: string) => void;
}) {
  return (
    <div className="review-preview">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Manual review</p>
          <h3>Review readiness</h3>
          <p>{props.packet.objective_summary}</p>
        </div>
        <span className={`status-pill ${reviewStatusToneClass(props.packet.readiness.status)}`}>{toHeadline(props.packet.readiness.status)}</span>
      </div>
      <div className="metric-grid">
        <article><span>Ready</span><strong>{props.packet.readiness.ready_checks}</strong></article>
        <article><span>Warning</span><strong>{props.packet.readiness.warning_checks}</strong></article>
        <article><span>Blocking</span><strong>{props.packet.readiness.blocking_checks}</strong></article>
        <article><span>Manual</span><strong>{props.packet.readiness.manual_checks}</strong></article>
      </div>
      {props.packet.recommendation ? (
        <article className="sub-panel">
          <strong>{props.packet.recommendation.action}{props.packet.recommendation.target ? ` -> ${formatNodeLabel(props.packet.recommendation.target)}` : ""}</strong>
          <p>{props.packet.recommendation.reason}</p>
        </article>
      ) : null}
      <div className="decision-actions">
        <button className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy} onClick={() => props.onRunSessionCommand("/agent review", "Refreshing review packet")}>
          <span>Refresh review</span>
          <code>/agent review</code>
        </button>
        {props.packet.suggested_actions.map((command) => (
          <button key={command} className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy} onClick={() => props.onRunSessionCommand(command, `Running ${summarizeCommand(command)}`)}>
            <span>{labelReviewAction(command)}</span>
            <code>{command}</code>
          </button>
        ))}
      </div>
      <div className="quality-grid">
        {props.packet.checks.map((check) => (
          <article key={check.id} className={`quality-group status-${check.status}`}>
            <strong>{check.label}</strong>
            <span className={`status-pill ${reviewStatusToneClass(check.status)}`}>{toHeadline(check.status)}</span>
            <p>{check.detail}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function CheckpointsPane(props: ResearchWorkbenchProps) {
  return props.checkpoints.length === 0 ? (
    <div className="inline-empty">No checkpoints recorded yet.</div>
  ) : (
    <div className="checkpoint-list">
      {props.checkpoints.map((checkpoint) => (
        <article key={checkpoint.seq} className="checkpoint-item">
          <strong>#{checkpoint.seq}</strong>
          <span>{formatNodeLabel(checkpoint.node)} · {formatStatusLabel(checkpoint.phase)}</span>
          <small>{formatTimestamp(checkpoint.createdAt)}</small>
          {checkpoint.reason ? <small>{checkpoint.reason}</small> : null}
        </article>
      ))}
    </div>
  );
}

function KnowledgePane(props: ResearchWorkbenchProps) {
  return (
    <div className="knowledge-pane">
      {props.selectedKnowledgeEntry ? (
        <article className="sub-panel">
          <p className="section-kicker">Repository knowledge</p>
          <h3>{props.selectedKnowledgeEntry.title}</h3>
          <p>{props.selectedKnowledgeEntry.research_question}</p>
          <div className="meta-grid">
            <span>Manuscript</span><strong>{props.selectedKnowledgeEntry.manuscript_type || "n/a"}</strong>
            <span>Manifest</span><strong>{props.selectedKnowledgeEntry.public_manifest}</strong>
            <span>Objective</span><strong>{props.selectedKnowledgeEntry.objective_metric}</strong>
          </div>
          <div className="decision-actions">
            <button className="button button-secondary button-small" type="button" onClick={() => props.onLoadKnowledgePreview(props.selectedKnowledgeEntry!.knowledge_note)}>Preview note</button>
            <button className="button button-secondary button-small" type="button" onClick={() => props.onLoadKnowledgePreview(props.selectedKnowledgeEntry!.public_manifest)}>Preview manifest</button>
            {props.literature ? <button className="button button-secondary button-small" type="button" onClick={() => props.onLoadKnowledgePreview(props.literature!.artifacts.literature_index_path)}>Preview literature index</button> : null}
          </div>
        </article>
      ) : <div className="inline-empty">No repository knowledge is available for the selected run yet.</div>}
      {props.literature ? (
        <article className="sub-panel">
          <h3>{props.literature.corpus.paper_count} papers</h3>
          <p>{props.literature.corpus.papers_with_pdf} with PDF / {props.literature.corpus.missing_pdf_count} missing</p>
          <p>{props.literature.corpus.papers_with_bibtex} with BibTeX / {props.literature.corpus.enriched_bibtex_count} enriched</p>
          <div className="decision-actions">
            <button className="button button-secondary button-small" type="button" onClick={() => props.onOpenKnowledgeArtifact(props.literature!.artifacts.collect_result_path)}>Open collect result</button>
            <button className="button button-secondary button-small" type="button" onClick={() => props.onOpenKnowledgeArtifact(props.literature!.artifacts.corpus_path)}>Open corpus</button>
            <button className="button button-secondary button-small" type="button" onClick={() => props.onOpenKnowledgeArtifact(props.literature!.artifacts.bibtex_path)}>Open bibtex</button>
            <button className="button button-secondary button-small" type="button" onClick={() => props.onOpenKnowledgeArtifact(props.literature!.artifacts.summaries_path)}>Open summaries</button>
            <button className="button button-secondary button-small" type="button" onClick={() => props.onOpenKnowledgeArtifact(props.literature!.artifacts.evidence_path)}>Open evidence</button>
          </div>
        </article>
      ) : props.selectedRunId ? <div className="inline-empty">Literature summary is loading for the selected run.</div> : null}
      {props.knowledgePreviewPath ? (
        <article className="sub-panel">
          <strong>{props.knowledgePreviewPath}</strong>
          <pre>{props.knowledgePreviewContent}</pre>
        </article>
      ) : <div className="inline-empty">Choose note, manifest, or literature index to preview the underlying file.</div>}
      {props.knowledgeEntries.map((entry) => (
        <article key={entry.run_id} className="checkpoint-item">
          <strong>{entry.title}</strong>
          <span>{entry.run_id}</span>
          <small>{entry.analysis_summary || entry.latest_summary || entry.topic}</small>
          <button className="button button-secondary button-small" type="button" onClick={() => props.onSetSelectedRunId(entry.run_id)}>Select run</button>
        </article>
      ))}
    </div>
  );
}

function MetaPane(props: ResearchWorkbenchProps) {
  if (!props.selectedRun) {
    return <div className="inline-empty">No run selected.</div>;
  }
  return (
    <div className="meta-grid">
      <span>ID</span><strong>{props.selectedRun.id}</strong>
      <span>Status</span><strong>{formatStatusLabel(props.selectedRun.status)}</strong>
      <span>Objective</span><strong>{props.selectedRun.objectiveMetric}</strong>
      <span>Constraints</span><strong>{props.selectedRun.constraints.join(", ") || "None"}</strong>
    </div>
  );
}

function DoctorPane(props: ResearchWorkbenchProps) {
  return (
    <div className="doctor-list">
      {props.doctorReadiness ? (
        <section className="sub-panel">
          <p className="section-kicker">Readiness profile</p>
          <div className="metric-grid">
            <article><span>Backend</span><strong>{formatDoctorBackendSummary(props.doctorReadiness)}</strong></article>
            <article><span>Runtime</span><strong>{formatDoctorRuntimeSummary(props.doctorReadiness)}</strong></article>
            <article><span>Isolation</span><strong>{props.doctorReadiness.candidateIsolation || "not-configured"}</strong></article>
            <article><span>Network</span><strong>{formatDoctorNetworkSummary(props.doctorReadiness)}</strong></article>
          </div>
        </section>
      ) : null}
      {props.doctorChecks.length === 0 ? (
        <div className="inline-empty">Doctor checks will appear after bootstrap completes.</div>
      ) : (
        props.doctorChecks.map((check) => (
          <article key={check.name} className={`doctor-item ${doctorCheckToneClass(check)}${isStrongRequiredNetworkWarning(check, props.doctorReadiness) ? " warning-strong" : ""}`}>
            <span className={`status-pill ${doctorCheckPillClass(check, props.doctorReadiness)}`}>{doctorCheckLabel(check, props.doctorReadiness)}</span>
            <div>
              <h4>{check.name}</h4>
              <p>{check.detail}</p>
              {isStrongRequiredNetworkWarning(check, props.doctorReadiness) ? <p className="doctor-emphasis">Network is required for this run. Treat outputs as network-assisted and keep operator review in the loop.</p> : null}
            </div>
          </article>
        ))
      )}
      {props.doctorHarness ? (
        <article className={`doctor-item ${props.doctorHarness.status === "ok" ? "ok" : "fail"}`}>
          <span className={`status-pill ${props.doctorHarness.status === "ok" ? "is-success" : "is-danger"}`}>{props.doctorHarness.status === "ok" ? "OK" : "FAIL"}</span>
          <div>
            <h4>harness-validation</h4>
            <p>{props.doctorHarness.findings.length} issue(s), {props.doctorHarness.runsChecked} run(s), {props.doctorHarness.runStoresChecked} run store(s) checked</p>
          </div>
        </article>
      ) : null}
    </div>
  );
}

interface ConfigEditorFormProps {
  className: string;
  form: SetupFormState;
  options: WebConfigOptions;
  onChange: Dispatch<SetStateAction<SetupFormState>>;
  onSubmit: (event: FormEvent) => Promise<void>;
  disabled?: boolean;
  heading: string;
  submitLabel: string;
  apiKeyHelp: string;
}

function ConfigEditorForm(props: ConfigEditorFormProps) {
  const isCodexMode = props.form.llmMode === "codex_chatgpt_only";
  const isOpenAiMode = props.form.llmMode === "openai_api";
  const isOllamaMode = props.form.llmMode === "ollama";

  return (
    <form className={props.className} onSubmit={props.onSubmit}>
      <div className="section-heading">
        <div>
          <p className="section-kicker">Workspace</p>
          <h2>{props.heading}</h2>
        </div>
      </div>

      <label>
        Project name
        <input disabled={props.disabled} value={props.form.projectName} onChange={(event) => patchSetupForm(props.onChange, { projectName: event.target.value })} />
      </label>
      <label>
        Default topic
        <input disabled={props.disabled} value={props.form.defaultTopic} onChange={(event) => patchSetupForm(props.onChange, { defaultTopic: event.target.value })} />
      </label>
      <label>
        Default constraints
        <input disabled={props.disabled} value={props.form.defaultConstraints} onChange={(event) => patchSetupForm(props.onChange, { defaultConstraints: event.target.value })} />
      </label>
      <label>
        Objective metric
        <input disabled={props.disabled} value={props.form.defaultObjectiveMetric} onChange={(event) => patchSetupForm(props.onChange, { defaultObjectiveMetric: event.target.value })} />
      </label>
      <p className="form-help">
        Workflow mode is fixed to Agent approval. Approval mode defaults to Minimal. Overnight is a separate
        autonomy preset, not a third workflow mode.
      </p>

      <div className="section-heading">
        <div>
          <p className="section-kicker">Execution policy</p>
          <h3>Experiment network policy</h3>
        </div>
      </div>
      <div className="inline-fields">
        <label>
          Network policy
          <select
            disabled={props.disabled}
            value={props.form.networkPolicy}
            onChange={(event) =>
              patchSetupForm(props.onChange, {
                networkPolicy: event.target.value as SetupFormState["networkPolicy"],
                networkPurpose: event.target.value === "blocked" ? "" : props.form.networkPurpose
              })
            }
          >
            <option value="blocked">Blocked (offline default)</option>
            <option value="declared">Declared dependency</option>
            <option value="required">Required dependency</option>
          </select>
        </label>
        <label>
          Network purpose
          <select
            disabled={props.disabled || props.form.networkPolicy === "blocked"}
            required={props.form.networkPolicy !== "blocked"}
            value={props.form.networkPurpose}
            onChange={(event) =>
              patchSetupForm(props.onChange, {
                networkPurpose: event.target.value as SetupFormState["networkPurpose"]
              })
            }
          >
            <option value="">Select a purpose</option>
            <option value="logging">Logging</option>
            <option value="artifact_upload">Artifact upload</option>
            <option value="model_download">Model download</option>
            <option value="dataset_fetch">Dataset fetch</option>
            <option value="remote_inference">Remote inference</option>
            <option value="other">Other</option>
          </select>
        </label>
      </div>
      <p className="form-help">
        Use Blocked for the offline default. Declared and Required runs keep network access auditable in `/doctor`
        and require manual or risk-ack execution modes rather than silent full-auto execution.
      </p>

      <div className="inline-fields">
        <label>
          Primary provider
          <select
            disabled={props.disabled}
            value={props.form.llmMode}
            onChange={(event) => patchSetupForm(props.onChange, { llmMode: event.target.value as SetupFormState["llmMode"] })}
          >
            <option value="codex_chatgpt_only">Codex ChatGPT (Default)</option>
            <option value="openai_api">OpenAI API</option>
            <option value="ollama">Ollama</option>
          </select>
        </label>
      </div>
      <p className="form-help">Only the selected provider's model slots are shown. PDF analysis backend follows that provider automatically.</p>

      <div className="section-heading">
        <div>
          <p className="section-kicker">Models</p>
          <h3>Model and reasoning by slot</h3>
        </div>
      </div>
      <p className="form-help">
        Pick the model and reasoning effort independently for chat, research, and experiment. PDF flows reuse the
        research backend model and reasoning automatically.
      </p>

      {isCodexMode ? (
        <>
          <ConfigModelSection
            title="Codex chat"
            description="General chat, titles, and lightweight interactive turns."
            disabled={props.disabled}
            modelValue={props.form.codexChatModelChoice}
            effortValue={props.form.codexChatReasoningEffort}
            modelOptions={props.options.codexModels}
            effortOptions={getEffortOptions(props.options.codexReasoningByModel, props.form.codexChatModelChoice)}
            onModelChange={(value) => updateModelAndEffort(props.onChange, "codexChatModelChoice", "codexChatReasoningEffort", value, props.options.codexReasoningByModel)}
            onEffortChange={(value) => patchSetupForm(props.onChange, { codexChatReasoningEffort: value })}
          />
          <ConfigModelSection
            title="Codex research backend"
            description={CODEX_TASK_MODEL_DESCRIPTION}
            disabled={props.disabled}
            modelValue={props.form.codexResearchBackendModelChoice}
            effortValue={props.form.codexResearchBackendReasoningEffort}
            modelOptions={props.options.codexModels}
            effortOptions={getEffortOptions(props.options.codexReasoningByModel, props.form.codexResearchBackendModelChoice)}
            onModelChange={(value) =>
              updateCodexResearchBackendModel(props.onChange, value, props.options.codexReasoningByModel)
            }
            onEffortChange={(value) => updateCodexResearchBackendEffort(props.onChange, value)}
          />
          <ConfigModelSection
            title="Codex experiment"
            description="Used when a real_execution runner needs model calls during experiment execution."
            disabled={props.disabled}
            modelValue={props.form.codexExperimentModelChoice}
            effortValue={props.form.codexExperimentReasoningEffort}
            modelOptions={props.options.codexModels}
            effortOptions={getEffortOptions(props.options.codexReasoningByModel, props.form.codexExperimentModelChoice)}
            onModelChange={(value) => updateModelAndEffort(props.onChange, "codexExperimentModelChoice", "codexExperimentReasoningEffort", value, props.options.codexReasoningByModel)}
            onEffortChange={(value) => patchSetupForm(props.onChange, { codexExperimentReasoningEffort: value })}
          />
        </>
      ) : null}

      {isOpenAiMode ? (
        <>
          <ConfigModelSection
            title="OpenAI chat"
            description="General chat model and reasoning for API mode."
            disabled={props.disabled}
            modelValue={props.form.openAiChatModel}
            effortValue={props.form.openAiChatReasoningEffort}
            modelOptions={props.options.openAiModels}
            effortOptions={getEffortOptions(props.options.openAiReasoningByModel, props.form.openAiChatModel)}
            onModelChange={(value) => updateModelAndEffort(props.onChange, "openAiChatModel", "openAiChatReasoningEffort", value, props.options.openAiReasoningByModel)}
            onEffortChange={(value) => patchSetupForm(props.onChange, { openAiChatReasoningEffort: value })}
          />
          <ConfigModelSection
            title="OpenAI research backend"
            description={OPENAI_TASK_MODEL_DESCRIPTION}
            disabled={props.disabled}
            modelValue={props.form.openAiResearchBackendModel}
            effortValue={props.form.openAiResearchBackendReasoningEffort}
            modelOptions={props.options.openAiModels}
            effortOptions={getEffortOptions(props.options.openAiReasoningByModel, props.form.openAiResearchBackendModel)}
            onModelChange={(value) =>
              updateOpenAiResearchBackendModel(props.onChange, value, props.options.openAiReasoningByModel)
            }
            onEffortChange={(value) => updateOpenAiResearchBackendEffort(props.onChange, value)}
          />
          <ConfigModelSection
            title="OpenAI experiment"
            description="Used when a real_execution runner should call the OpenAI API."
            disabled={props.disabled}
            modelValue={props.form.openAiExperimentModel}
            effortValue={props.form.openAiExperimentReasoningEffort}
            modelOptions={props.options.openAiModels}
            effortOptions={getEffortOptions(props.options.openAiReasoningByModel, props.form.openAiExperimentModel)}
            onModelChange={(value) => updateModelAndEffort(props.onChange, "openAiExperimentModel", "openAiExperimentReasoningEffort", value, props.options.openAiReasoningByModel)}
            onEffortChange={(value) => patchSetupForm(props.onChange, { openAiExperimentReasoningEffort: value })}
          />
        </>
      ) : null}

      {isOllamaMode ? (
        <>
          <label>
            Ollama base URL
            <input
              disabled={props.disabled}
              value={props.form.ollamaBaseUrl}
              onChange={(event) => patchSetupForm(props.onChange, { ollamaBaseUrl: event.target.value })}
            />
          </label>
          <p className="form-help">The web setup will use this local Ollama endpoint for chat, research backend, experiment, and vision flows.</p>
          <ConfigModelSection
            title="Ollama chat"
            description="Fast local chat model for interactive turns and lightweight assistance."
            disabled={props.disabled}
            modelValue={props.form.ollamaChatModel}
            modelOptions={props.options.ollamaChatModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaChatModel: value })}
          />
          <ConfigModelSection
            title="Ollama research backend"
            description="Primary local model for research backend, analysis, and planning tasks."
            disabled={props.disabled}
            modelValue={props.form.ollamaResearchModel}
            modelOptions={props.options.ollamaResearchModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaResearchModel: value })}
          />
          <ConfigModelSection
            title="Ollama experiment"
            description="Local model used for experiment implementation and code-oriented execution work."
            disabled={props.disabled}
            modelValue={props.form.ollamaExperimentModel}
            modelOptions={props.options.ollamaExperimentModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaExperimentModel: value })}
          />
          <ConfigModelSection
            title="Ollama vision"
            description="Vision/PDF model used when the pipeline analyzes page images locally."
            disabled={props.disabled}
            modelValue={props.form.ollamaVisionModel}
            modelOptions={props.options.ollamaVisionModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaVisionModel: value })}
          />
        </>
      ) : null}

      <label>
        Semantic Scholar API key
        <input disabled={props.disabled} type="password" value={props.form.semanticScholarApiKey} onChange={(event) => patchSetupForm(props.onChange, { semanticScholarApiKey: event.target.value })} />
      </label>
      {isOpenAiMode ? (
        <label>
          OpenAI API key
          <input disabled={props.disabled} type="password" value={props.form.openAiApiKey} onChange={(event) => patchSetupForm(props.onChange, { openAiApiKey: event.target.value })} />
        </label>
      ) : null}
      <p className="form-help">{props.apiKeyHelp}</p>

      <div className="form-actions">
        <button className="button button-primary" type="submit" disabled={props.disabled}>{props.disabled ? "Working..." : props.submitLabel}</button>
      </div>
    </form>
  );
}

interface ConfigModelSectionProps {
  title: string;
  description: string;
  disabled?: boolean;
  modelValue: string;
  modelOptions: string[];
  effortValue?: string;
  effortOptions?: string[];
  onModelChange: (value: string) => void;
  onEffortChange?: (value: string) => void;
}

function ConfigModelSection(props: ConfigModelSectionProps) {
  return (
    <section className="subtle-card config-section">
      <div className="config-section-copy">
        <h3>{props.title}</h3>
        <p>{props.description}</p>
      </div>
      <div className="inline-fields">
        <label>
          Model
          <select disabled={props.disabled} value={props.modelValue} onChange={(event) => props.onModelChange(event.target.value)}>
            {props.modelOptions.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        {props.effortOptions && props.onEffortChange ? (
          <label>
            Reasoning effort
            <select disabled={props.disabled} value={props.effortValue} onChange={(event) => props.onEffortChange?.(event.target.value)}>
              {props.effortOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
    </section>
  );
}

function createEmptySetupForm(): SetupFormState {
  return {
    ...createDefaultConfigForm(),
    semanticScholarApiKey: "",
    openAiApiKey: ""
  };
}

function createSetupFormFromBootstrap(bootstrap: BootstrapResponse): SetupFormState {
  return {
    ...createDefaultConfigForm(),
    ...(bootstrap.configForm || {}),
    projectName: bootstrap.configForm?.projectName || bootstrap.setupDefaults.projectName,
    defaultTopic: bootstrap.configForm?.defaultTopic || bootstrap.setupDefaults.defaultTopic,
    defaultConstraints:
      bootstrap.configForm?.defaultConstraints || bootstrap.setupDefaults.defaultConstraints.join(", "),
    defaultObjectiveMetric:
      bootstrap.configForm?.defaultObjectiveMetric || bootstrap.setupDefaults.defaultObjectiveMetric,
    semanticScholarApiKey: "",
    openAiApiKey: ""
  };
}

function createDefaultConfigForm(): WebConfigFormData {
  return {
    projectName: "",
    defaultTopic: "",
    defaultConstraints: "",
    defaultObjectiveMetric: "",
    llmMode: "codex_chatgpt_only",
    codexChatModelChoice: "gpt-5.3-codex-spark",
    codexChatReasoningEffort: "medium",
    codexResearchBackendModelChoice: "gpt-5.3-codex",
    codexResearchBackendReasoningEffort: "xhigh",
    codexExperimentModelChoice: "gpt-5.3-codex",
    codexExperimentReasoningEffort: "xhigh",
    openAiChatModel: "gpt-5.4",
    openAiChatReasoningEffort: "low",
    openAiResearchBackendModel: "gpt-5.4",
    openAiResearchBackendReasoningEffort: "medium",
    openAiExperimentModel: "gpt-5.4",
    openAiExperimentReasoningEffort: "medium",
    ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    ollamaChatModel: DEFAULT_OLLAMA_CHAT_MODEL,
    ollamaResearchModel: DEFAULT_OLLAMA_RESEARCH_MODEL,
    ollamaExperimentModel: DEFAULT_OLLAMA_EXPERIMENT_MODEL,
    ollamaVisionModel: DEFAULT_OLLAMA_VISION_MODEL,
    networkPolicy: "blocked",
    networkPurpose: ""
  };
}

function createDefaultConfigOptions(): WebConfigOptions {
  return {
    codexModels: [
      "gpt-5.4",
      "gpt-5.4 (fast)",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5-codex",
      "gpt-5-codex-mini",
      "gpt-5"
    ],
    codexReasoningByModel: {
      "gpt-5.4": ["low", "medium", "high", "xhigh"],
      "gpt-5.4 (fast)": ["low", "medium", "high", "xhigh"],
      "gpt-5.3-codex": ["low", "medium", "high", "xhigh"],
      "gpt-5.3-codex-spark": ["low", "medium", "high"],
      "gpt-5.2-codex": ["low", "medium", "high", "xhigh"],
      "gpt-5.2": ["low", "medium", "high"],
      "gpt-5.1-codex-max": ["low", "medium", "high"],
      "gpt-5.1": ["low", "medium", "high"],
      "gpt-5.1-codex": ["low", "medium", "high", "xhigh"],
      "gpt-5-codex": ["low", "medium", "high"],
      "gpt-5-codex-mini": ["low", "medium", "high"],
      "gpt-5": ["minimal", "low", "medium", "high"]
    },
    openAiModels: ["gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    openAiReasoningByModel: {
      "gpt-5.4": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-5-mini": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-4.1": ["medium"],
      "gpt-4o": ["medium"],
      "gpt-4o-mini": ["medium"]
    },
    ollamaChatModels: buildOllamaChatModelChoices(),
    ollamaResearchModels: buildOllamaResearchModelChoices(),
    ollamaExperimentModels: buildOllamaExperimentModelChoices(),
    ollamaVisionModels: buildOllamaVisionModelChoices()
  };
}

function patchSetupForm(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  patch: Partial<SetupFormState>
) {
  setter((current) => ({ ...current, ...patch }));
}

function updateModelAndEffort(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  modelKey: keyof SetupFormState,
  effortKey: keyof SetupFormState,
  nextModel: string,
  optionsByModel: Record<string, string[]>
) {
  setter((current) => {
    const effortOptions = getEffortOptions(optionsByModel, nextModel);
    const currentEffort = String(current[effortKey] || "");
    return {
      ...current,
      [modelKey]: nextModel,
      [effortKey]: effortOptions.includes(currentEffort) ? currentEffort : effortOptions[0]
    };
  });
}

function updateCodexResearchBackendModel(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  nextModel: string,
  optionsByModel: Record<string, string[]>
) {
  setter((current) => {
    const effortOptions = getEffortOptions(optionsByModel, nextModel);
    const currentResearchBackendEffort = String(current.codexResearchBackendReasoningEffort || "");
    const nextResearchBackendEffort = effortOptions.includes(currentResearchBackendEffort)
      ? currentResearchBackendEffort
      : effortOptions[0];
    return {
      ...current,
      codexResearchBackendModelChoice: nextModel,
      codexResearchBackendReasoningEffort: nextResearchBackendEffort
    };
  });
}

function updateCodexResearchBackendEffort(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  nextEffort: string
) {
  setter((current) => ({
    ...current,
    codexResearchBackendReasoningEffort: nextEffort
  }));
}

function updateOpenAiResearchBackendModel(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  nextModel: string,
  optionsByModel: Record<string, string[]>
) {
  setter((current) => {
    const effortOptions = getEffortOptions(optionsByModel, nextModel);
    const currentResearchBackendEffort = String(current.openAiResearchBackendReasoningEffort || "");
    const nextResearchBackendEffort = effortOptions.includes(currentResearchBackendEffort)
      ? currentResearchBackendEffort
      : effortOptions[0];
    return {
      ...current,
      openAiResearchBackendModel: nextModel,
      openAiResearchBackendReasoningEffort: nextResearchBackendEffort
    };
  });
}

function updateOpenAiResearchBackendEffort(
  setter: Dispatch<SetStateAction<SetupFormState>>,
  nextEffort: string
) {
  setter((current) => ({
    ...current,
    openAiResearchBackendReasoningEffort: nextEffort
  }));
}

function getEffortOptions(optionsByModel: Record<string, string[]>, model: string): string[] {
  return optionsByModel[model] || ["medium"];
}

function normalizeDoctorCheckStatus(check: DoctorCheck): "ok" | "warning" | "fail" {
  if (check.status === "warn") {
    return "warning";
  }
  return check.status || (check.ok ? "ok" : "fail");
}

function doctorCheckLabel(
  check: DoctorCheck,
  readiness?: DoctorResponse["readiness"] | null
): "OK" | "WARN" | "FAIL" | "REQUIRED" {
  if (isStrongRequiredNetworkWarning(check, readiness)) {
    return "REQUIRED";
  }
  const status = normalizeDoctorCheckStatus(check);
  if (status === "warning") {
    return "WARN";
  }
  return status === "fail" ? "FAIL" : "OK";
}

function doctorCheckPillClass(
  check: DoctorCheck,
  readiness?: DoctorResponse["readiness"] | null
): "is-success" | "is-warning" | "is-warning-strong" | "is-danger" {
  if (isStrongRequiredNetworkWarning(check, readiness)) {
    return "is-warning-strong";
  }
  const status = normalizeDoctorCheckStatus(check);
  if (status === "warning") {
    return "is-warning";
  }
  return status === "fail" ? "is-danger" : "is-success";
}

function doctorCheckToneClass(check: DoctorCheck): "ok" | "warning" | "fail" {
  const status = normalizeDoctorCheckStatus(check);
  if (status === "warning") {
    return "warning";
  }
  return status === "fail" ? "fail" : "ok";
}

function isStrongRequiredNetworkWarning(
  check: DoctorCheck,
  readiness?: DoctorResponse["readiness"] | null
): boolean {
  return (
    check.name === "experiment-web-restriction"
    && normalizeDoctorCheckStatus(check) === "warning"
    && readiness?.networkPolicy === "required"
  );
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

function summarizeCommand(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "command";
  }
  return normalized.length <= 52 ? normalized : `${normalized.slice(0, 49)}...`;
}

function labelPendingPlanAction(action: "next" | "all" | "cancel"): string {
  switch (action) {
    case "next":
      return "Running the next pending step";
    case "all":
      return "Running the full pending plan";
    case "cancel":
      return "Canceling the pending plan";
  }
}

function parseReviewPacketPreview(raw: string): ReviewPacketPreview | null {
  if (!raw.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const checks = Array.isArray(parsed.checks)
      ? parsed.checks
          .map((item, index) => normalizeReviewCheckPreview(item, index))
          .filter((item): item is ReviewPacketPreview["checks"][number] => Boolean(item))
      : [];
    const readiness = summarizeReviewPreviewReadiness(checks);
    const recommendation = normalizeReviewRecommendationPreview(parsed.recommendation);

    return {
      generated_at: typeof parsed.generated_at === "string" ? parsed.generated_at : "",
      readiness: normalizeReviewReadinessPreview(parsed.readiness, readiness),
      objective_status: typeof parsed.objective_status === "string" ? parsed.objective_status : "unknown",
      objective_summary:
        typeof parsed.objective_summary === "string"
          ? parsed.objective_summary
          : "No structured objective summary was available.",
      recommendation,
      checks,
      suggested_actions: Array.isArray(parsed.suggested_actions)
        ? parsed.suggested_actions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : []
    };
  } catch {
    return null;
  }
}

function summarizeReviewPreviewReadiness(
  checks: Array<{ status: ReviewPreviewStatus }>
): ReviewPacketPreview["readiness"] {
  let readyChecks = 0;
  let warningChecks = 0;
  let blockingChecks = 0;
  let manualChecks = 0;

  for (const check of checks) {
    switch (check.status) {
      case "ready":
        readyChecks += 1;
        break;
      case "warning":
        warningChecks += 1;
        break;
      case "blocking":
        blockingChecks += 1;
        break;
      case "manual":
        manualChecks += 1;
        break;
    }
  }

  return {
    status: blockingChecks > 0 ? "blocking" : warningChecks > 0 ? "warning" : "ready",
    ready_checks: readyChecks,
    warning_checks: warningChecks,
    blocking_checks: blockingChecks,
    manual_checks: manualChecks
  };
}

function normalizeReviewCheckPreview(
  value: unknown,
  index: number
): ReviewPacketPreview["checks"][number] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    id: typeof record.id === "string" ? record.id : `check_${index + 1}`,
    label: typeof record.label === "string" ? record.label : `Check ${index + 1}`,
    status: normalizeReviewStatusPreview(record.status),
    detail: typeof record.detail === "string" ? record.detail : ""
  };
}

function normalizeReviewRecommendationPreview(
  value: unknown
): ReviewPacketPreview["recommendation"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.action !== "string" || typeof record.reason !== "string") {
    return undefined;
  }
  return {
    action: record.action,
    target: typeof record.target === "string" ? record.target : undefined,
    confidence_pct: typeof record.confidence_pct === "number" ? record.confidence_pct : 0,
    reason: record.reason,
    evidence: Array.isArray(record.evidence)
      ? record.evidence.filter((item): item is string => typeof item === "string").slice(0, 3)
      : []
  };
}

function normalizeReviewReadinessPreview(
  value: unknown,
  fallback: ReviewPacketPreview["readiness"]
): ReviewPacketPreview["readiness"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallback;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  return {
    status: status === "ready" || status === "warning" || status === "blocking" ? status : fallback.status,
    ready_checks: typeof record.ready_checks === "number" ? record.ready_checks : fallback.ready_checks,
    warning_checks: typeof record.warning_checks === "number" ? record.warning_checks : fallback.warning_checks,
    blocking_checks: typeof record.blocking_checks === "number" ? record.blocking_checks : fallback.blocking_checks,
    manual_checks: typeof record.manual_checks === "number" ? record.manual_checks : fallback.manual_checks
  };
}

function normalizeReviewStatusPreview(value: unknown): ReviewPreviewStatus {
  switch (value) {
    case "ready":
    case "warning":
    case "blocking":
    case "manual":
      return value;
    default:
      return "manual";
  }
}

function reviewStatusToneClass(status: ReviewPreviewStatus | Exclude<ReviewPreviewStatus, "manual">): string {
  switch (status) {
    case "ready":
      return "is-success";
    case "blocking":
      return "is-danger";
    case "warning":
      return "is-warning";
    default:
      return "is-neutral";
  }
}

function labelReviewAction(command: string): string {
  switch (command) {
    case "/approve":
      return "Approve review";
    case "/agent run write_paper":
      return "Run write_paper";
    case "/agent review":
      return "Refresh review";
    case "/agent apply":
      return "Apply transition";
    case "/agent transition":
      return "Show transition";
    case "/agent jump analyze_results":
    case "/agent jump analyze_results --force":
      return "Jump analyze_results";
    case "/agent jump generate_hypotheses --force":
      return "Jump generate_hypotheses";
    case "/agent jump design_experiments --force":
      return "Jump design_experiments";
    case "/agent jump implement_experiments --force":
      return "Jump implement_experiments";
    default:
      return command.replace(/^\//, "");
  }
}

function formatNodeLabel(value: string): string {
  return toHeadline(value.replace(/_/g, " "));
}

function formatStatusLabel(value: string): string {
  return toHeadline(value.replace(/_/g, " "));
}

function labelProviderMode(value: ConfigSummary["llmMode"] | undefined): string {
  return value === "openai_api" ? "Provider: OpenAI API" : "Provider: Codex ChatGPT";
}

function labelPdfMode(value: ConfigSummary["pdfMode"] | undefined): string {
  return value === "responses_api_pdf" ? "PDF: Responses API PDF" : "PDF: Codex text + image hybrid";
}

function labelWorkflowMode(value: ConfigSummary["workflowMode"] | undefined): string {
  return value === "agent_approval" ? "Workflow: Agent approval" : "Workflow: Agent approval";
}

function labelApprovalMode(value: ConfigSummary["approvalMode"] | undefined): string {
  if (value === "manual") {
    return "Approval: Manual";
  }
  if (value === "hybrid") {
    return "Approval: Hybrid";
  }
  return "Approval: Minimal";
}

function formatRunRecommendedAction(
  value: "inspect_blocker" | "resume_review" | "rerun_after_fix" | "waiting_for_input" | "completed"
): string {
  switch (value) {
    case "inspect_blocker":
      return "Inspect blocker";
    case "resume_review":
      return "Resume review";
    case "rerun_after_fix":
      return "Rerun after fix";
    case "waiting_for_input":
      return "Waiting for input";
    case "completed":
      return "Completed";
  }
}

function formatReadinessTriple(input: {
  analysis_ready: boolean;
  review_ready: boolean;
  paper_ready: boolean;
}): string {
  return `${input.analysis_ready ? "yes" : "no"}/${input.review_ready ? "yes" : "no"}/${input.paper_ready ? "yes" : "no"}`;
}

function renderJobBucket(
  label: string,
  jobs: Array<{
    run_id: string;
    node: string;
    status: string;
    elapsed_seconds: number;
    source?: "run" | "collect_background_job";
    recommendation_line?: string;
  }>
): ReactNode {
  return (
    <div className="manuscript-quality-group-list">
      <p className="doctor-harness-meta">
        {label} ({jobs.length})
      </p>
      {jobs.length === 0 ? (
        <div className="manuscript-quality-group-line">
          <p>None</p>
        </div>
      ) : (
        jobs.map((job) => (
          <div key={`${label}:${job.run_id}:${job.node}:${job.source || "run"}`} className="manuscript-quality-group-line">
            <p>
              <strong>{job.run_id}</strong> · {formatNodeLabel(job.node as NodeId)} · {job.status} · {formatElapsedSeconds(job.elapsed_seconds)}
            </p>
            <p className="doctor-harness-meta">
              {job.source === "collect_background_job" ? "Background collect" : "Node run"}
              {job.recommendation_line ? ` · ${job.recommendation_line}` : ""}
            </p>
          </div>
        ))
      )}
    </div>
  );
}

function renderLiveWatchTable(
  snapshot: NonNullable<BootstrapResponse["jobQueue"]>
): ReactNode {
  const normalized = {
    running: snapshot?.running || [],
    waiting: snapshot?.waiting || [],
    stalled: snapshot?.stalled || []
  };
  const rows = [
    ...normalized.running.map((job) => ({ bucket: "running" as const, job })),
    ...normalized.waiting.map((job) => ({ bucket: "waiting" as const, job })),
    ...normalized.stalled.map((job) => ({ bucket: "stalled" as const, job }))
  ];

  if (rows.length === 0) {
    return (
      <div className="manuscript-quality-group-list">
        <div className="manuscript-quality-group-line">
          <p>No active jobs</p>
        </div>
      </div>
    );
  }

  return (
    <div className="live-watch-table">
      <div className="live-watch-header">
        <span>run_id</span>
        <span>current_node</span>
        <span>node_status</span>
        <span>run_status</span>
        <span>elapsed</span>
      </div>
      {rows.map(({ bucket, job }) => {
        const toneClass =
          bucket === "stalled" || job.status === "needs_approval"
            ? "live-watch-row is-warning"
            : "live-watch-row";
        return (
          <div
            key={`live-watch:${bucket}:${job.run_id}:${job.node}:${job.source || "run"}`}
            className={toneClass}
          >
            <span>{job.run_id.slice(0, 8)}</span>
            <span>{job.source === "collect_background_job" ? `${formatNodeLabel(job.node as NodeId)} [bg]` : formatNodeLabel(job.node as NodeId)}</span>
            <span>{job.status}</span>
            <span>{bucket}</span>
            <span>{formatElapsedSeconds(job.elapsed_seconds)}</span>
          </div>
        );
      })}
    </div>
  );
}

function renderExplorationStatusCard(
  status: ExplorationStatusResponse | null
): ReactNode {
  if (!status) {
    return (
      <div className="manuscript-quality-group-list">
        <div className="manuscript-quality-group-line">
          <p>Exploration status unavailable</p>
        </div>
      </div>
    );
  }

  return (
    <div className="manuscript-quality-group-list">
      <div className="manuscript-quality-group-line">
        <p><strong>Enabled:</strong> {status.enabled ? "true" : "false"}</p>
      </div>
      <div className="manuscript-quality-group-line">
        <p><strong>Current stage:</strong> {status.current_stage || "n/a"}</p>
      </div>
      <div className="manuscript-quality-group-line">
        <p>
          <strong>Nodes:</strong>{" "}
          {status.node_counts
            ? `${status.node_counts.explored} explored / ${status.node_counts.promoted} promoted / ${status.node_counts.blocked} blocked`
            : "n/a"}
        </p>
      </div>
      <div className="manuscript-quality-group-line">
        <p><strong>Best defensible:</strong> {status.best_defensible_branch_id || "n/a"}</p>
      </div>
      <div className="manuscript-quality-group-line">
        <p><strong>Baseline lock:</strong> {status.baseline_lock_status}</p>
      </div>
      <div className="manuscript-quality-group-line">
        <p><strong>Evidence completeness:</strong> {status.evidence_completeness ?? "n/a"}</p>
      </div>
      <div className="manuscript-quality-group-line">
        <p>
          <strong>Fig audit warns:</strong>{" "}
          {status.figure_audit_warnings == null
            ? "n/a"
            : `${status.figure_audit_warnings} (${status.severe_figure_mismatch ? "severe mismatch" : "no severe mismatch"})`}
        </p>
      </div>
      {status.rollback_reason ? (
        <div className="manuscript-quality-group-line">
          <p><strong>Rollback reason:</strong> {status.rollback_reason}</p>
        </div>
      ) : null}
    </div>
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0s";
  }
  if (totalSeconds < 60) {
    return `${Math.floor(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatReviewGateStatus(
  status: NonNullable<RunJobProjection["review_gate_status"]>,
  decision?: string,
  transition?: string
): string {
  if (decision) {
    return transition ? `${decision} -> ${transition}` : decision;
  }
  switch (status) {
    case "ready":
      return "Ready";
    case "warning":
      return "Warning";
    case "blocking":
      return "Blocking";
    case "missing":
      return "Missing";
  }
}

function formatDoctorBackendSummary(readiness: NonNullable<DoctorResponse["readiness"]>): string {
  const llm = readiness.llmMode || "unknown";
  const pdf = readiness.pdfAnalysisMode || "unknown";
  return `${llm} / ${pdf}`;
}

function formatDoctorRuntimeSummary(readiness: NonNullable<DoctorResponse["readiness"]>): string {
  return `${readiness.dependencyMode} · ${readiness.sessionMode} · ${readiness.executionApprovalMode}`;
}

function formatDoctorNetworkSummary(readiness: NonNullable<DoctorResponse["readiness"]>): string {
  if (readiness.networkPolicy === "blocked") {
    return "offline";
  }
  if (!readiness.networkDeclarationPresent) {
    return "undeclared-enabled";
  }
  return readiness.networkPurpose
    ? `${readiness.networkPolicy}:${readiness.networkPurpose}`
    : (readiness.networkPolicy || "undeclared-enabled");
}

function labelArtifactKind(value: ArtifactEntry["kind"]): string {
  switch (value) {
    case "json":
      return "JSON";
    case "pdf":
      return "PDF";
    default:
      return toHeadline(value);
  }
}

function buildFallbackArtifactEntry(path: string): ArtifactEntry {
  const lower = path.toLowerCase();
  const kind: ArtifactEntry["kind"] =
    lower.endsWith(".json") || lower.endsWith(".jsonl")
      ? "json"
      : lower.endsWith(".yaml") ||
          lower.endsWith(".yml") ||
          lower.endsWith(".txt") ||
          lower.endsWith(".tex") ||
          lower.endsWith(".bib") ||
          lower.endsWith(".md") ||
          lower.endsWith(".log") ||
          lower.endsWith(".py")
        ? "text"
        : lower.endsWith(".png") ||
            lower.endsWith(".jpg") ||
            lower.endsWith(".jpeg") ||
            lower.endsWith(".gif") ||
            lower.endsWith(".webp") ||
            lower.endsWith(".svg")
          ? "image"
          : lower.endsWith(".pdf")
            ? "pdf"
            : "download";

  return {
    path,
    kind,
    size: 0,
    modifiedAt: "",
    previewable: kind !== "download"
  };
}

function labelInsightReferenceKind(
  kind: "figure" | "comparison" | "statistics" | "transition" | "report" | "metrics"
): string {
  return toHeadline(kind);
}

function buildInsightReferenceKey(reference: NonNullable<RunInsightCard["references"]>[number]): string {
  return `${reference.kind}:${reference.label}:${reference.path}`;
}

function statusToneClass(status?: string): string {
  switch (status) {
    case "needs_approval":
      return "is-warning";
    case "completed":
      return "is-success";
    case "running":
    case "active":
      return "is-active";
    case "failed":
      return "is-danger";
    case "paused":
    case "pending":
      return "is-neutral";
    default:
      return "is-neutral";
  }
}

function manuscriptQualityStatusToneClass(
  status: NonNullable<RunInsightCard["manuscriptQuality"]>["status"]
): string {
  switch (status) {
    case "pass":
      return "is-success";
    case "repairing":
      return "is-warning";
    case "stopped":
      return "is-danger";
  }
}

function formatManuscriptQualityStatus(
  status: NonNullable<RunInsightCard["manuscriptQuality"]>["status"]
): string {
  switch (status) {
    case "pass":
      return "Pass";
    case "repairing":
      return "Repairing";
    case "stopped":
      return "Stopped";
  }
}

function formatManuscriptQualityStage(
  stage: NonNullable<RunInsightCard["manuscriptQuality"]>["stage"]
): string {
  switch (stage) {
    case "initial_gate":
      return "Initial gate";
    case "post_repair_1":
      return "After repair 1";
    case "post_repair_2":
      return "After repair 2";
  }
}

function formatManuscriptQualityReason(
  reason: NonNullable<RunInsightCard["manuscriptQuality"]>["reasonCategory"]
): string {
  return toHeadline(reason.replace(/_/g, " "));
}

function formatManuscriptQualityReliability(
  reliability: NonNullable<RunInsightCard["manuscriptQuality"]>["reviewReliability"]
): string {
  return toHeadline(reliability.replace(/_/g, " "));
}

function buildManuscriptQualityGroupCards(
  insight: NonNullable<RunInsightCard["manuscriptQuality"]>
): Array<{
  key: string;
  label: string;
  toneClass: string;
  items: Array<{
    code: string;
    section: string;
    severity: "warning" | "fail";
    message: string;
  }>;
}> {
  const groups = [
    {
      key: "manuscript",
      label: "Repairable manuscript issues",
      toneClass: "is-warning",
      items: insight.issueGroups.manuscript
    },
    {
      key: "hard-stop",
      label: "Hard-stop policy findings",
      toneClass: "is-danger",
      items: insight.issueGroups.hardStopPolicy
    },
    {
      key: "backstop",
      label: "Backstop-only findings",
      toneClass: "is-neutral",
      items: insight.issueGroups.backstopOnly
    },
    {
      key: "readiness",
      label: "Paper readiness risks",
      toneClass: (insight.issueGroups.readiness || []).some((item) => item.severity === "fail")
        ? "is-danger"
        : "is-warning",
      items: insight.issueGroups.readiness || []
    },
    {
      key: "scientific",
      label: "Scientific blockers",
      toneClass: "is-danger",
      items: insight.issueGroups.scientific
    },
    {
      key: "submission",
      label: "Submission blockers",
      toneClass: "is-danger",
      items: insight.issueGroups.submission
    }
  ];

  return groups.filter((group) => group.items.length > 0);
}

function buildReadinessRiskGroupCards(
  insight: NonNullable<RunInsightCard["readinessRisks"]>
): Array<{
  key: string;
  label: string;
  toneClass: string;
  items: typeof insight.risks;
}> {
  return [
    {
      key: "readiness",
      label: "Paper readiness risks",
      toneClass: insight.risks.some((item) => item.severity === "fail") ? "is-danger" : "is-warning",
      items: insight.risks
    }
  ].filter((group) => group.items.length > 0);
}

function formatTimestamp(value?: string): string {
  if (!value) {
    return "No timestamp";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

function toHeadline(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
