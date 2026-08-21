import { Dispatch, FormEvent, KeyboardEvent, ReactNode, RefObject, SetStateAction, startTransition, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CaretDown,
  CheckCircle,
  Circle,
  ClipboardText,
  ClockCounterClockwise,
  Command,
  Database,
  FileText,
  Flask,
  FolderOpen,
  Gear,
  ListChecks,
  Plus,
  Pulse,
  ShieldCheck,
  TerminalWindow,
  WarningCircle,
  X
} from "@phosphor-icons/react";

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
  ResearchBriefStartGate,
  ResearchFunnelProjection,
  RunJobProjection,
  LiteratureResponse,
  RunRecord,
  RunLiteratureIndex,
  RunInsightCard,
  NodeId,
  WebConfigFormData,
  WebConfigOptions,
  GuidedBriefInterviewLanguage,
  GuidedBriefResearchMode,
  WebGuidedBriefInterview,
  WebGuidedBriefInterviewResponse,
  WebRunCreationResponse,
  WebSessionState
} from "./types";
import {
  CODEX_TASK_MODEL_DESCRIPTION,
  OPENAI_TASK_MODEL_DESCRIPTION
} from "../../src/modelSlotText.js";
import {
  buildOllamaModelChoices,
  DEFAULT_OLLAMA_BASE_URL
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

type TabId = "overview" | "logs" | "artifacts" | "checkpoints" | "knowledge" | "meta" | "workspace" | "doctor";

const DETAIL_TABS: Array<{ id: TabId; label: string }> = [
  { id: "overview", label: "Run details" },
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

interface UiNoticeState {
  message: string;
  dismissLabel: string;
}

interface GovernedActionConfirmation {
  action: string;
  node?: NodeId;
}

type SyncState = "connecting" | "live" | "polling" | "degraded";

type OllamaDiscoveryStatus = "idle" | "loading" | "ready" | "empty" | "unreachable";

type NewRunCreationMode = "guided" | "paste";

const GUIDED_BRIEF_LANGUAGE_OPTIONS: Array<{
  value: GuidedBriefInterviewLanguage;
  label: string;
}> = [
  { value: "ko", label: "한국어" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "pt", label: "Português" },
  { value: "ru", label: "Русский" }
];

interface GuidedBriefUiCopy {
  guidedMode: string;
  pasteMode: string;
  pasteTitle: string;
  pasteDescription: string;
  briefLabel: string;
  briefPlaceholder: string;
  title: string;
  description: string;
  language: string;
  researchMode: string;
  hypothesisTest: string;
  topicDiscovery: string;
  draftPersistence: string;
  start: string;
  starting: string;
  cancel: string;
  coverage: string;
  coverageAriaLabel: string;
  acceptedVia: string;
  fallbackTitle: string;
  requiredQuestion: string;
  optionalQuestion: string;
  answer: string;
  answerPlaceholder: string;
  defaultAnswerPrefix: string;
  turnNote: (turn: number) => string;
  continue: string;
  interpreting: string;
  restart: string;
  close: string;
  completeTitle: string;
  completeSummary: (answered: number, required: number, turns: number) => string;
  generatedBrief: string;
  startLocked: string;
  missingFields: string;
}

const ENGLISH_GUIDED_BRIEF_UI: GuidedBriefUiCopy = {
  guidedMode: "Guided interview",
  pasteMode: "Paste complete brief",
  pasteTitle: "Governed brief import",
  pasteDescription: "Paste a complete Research Brief. With auto-start selected, incomplete input stays in this form and no run is created.",
  briefLabel: "Research brief",
  briefPlaceholder: "Paste the governed Research Brief markdown.",
  title: "Answer-driven Research Brief",
  description: "Describe several decisions together if useful. Covered fields are skipped; uncertain answers receive one focused follow-up.",
  language: "Interview language",
  researchMode: "Research mode",
  hypothesisTest: "Hypothesis test",
  topicDiscovery: "Topic discovery",
  draftPersistence: "Draft state stays in this Web server process. Restarting the server resets an unfinished interview.",
  start: "Start interview",
  starting: "Starting...",
  cancel: "Cancel",
  coverage: "Required coverage",
  coverageAriaLabel: "Required brief coverage",
  acceptedVia: "Accepted via",
  fallbackTitle: "Interpretation fallback",
  requiredQuestion: "Required question",
  optionalQuestion: "Optional question",
  answer: "Your answer",
  answerPlaceholder: "Answer the current question. You may include other declared fields too.",
  defaultAnswerPrefix: "Leave blank to use:",
  turnNote: (turn) => `Turn ${turn}. Only source-grounded declared fields can be accepted.`,
  continue: "Continue interview",
  interpreting: "Interpreting...",
  restart: "Restart",
  close: "Close",
  completeTitle: "Governed brief complete",
  completeSummary: (answered, required, turns) => `${answered}/${required} required fields covered in ${turns} turns.`,
  generatedBrief: "Generated Research Brief",
  startLocked: "Research start locked",
  missingFields: "Missing or incomplete brief fields"
};

const KOREAN_GUIDED_BRIEF_UI: GuidedBriefUiCopy = {
  guidedMode: "가이드 인터뷰",
  pasteMode: "완성된 브리프 붙여넣기",
  pasteTitle: "관리형 브리프 가져오기",
  pasteDescription: "완성된 Research Brief를 붙여넣어 주세요. 자동 시작을 선택한 상태에서 내용이 불완전하면 Run을 만들지 않고 이 입력 화면에 그대로 둡니다.",
  briefLabel: "Research Brief",
  briefPlaceholder: "관리형 Research Brief 마크다운을 붙여넣어 주세요.",
  title: "답변 기반 Research Brief",
  description: "한 번의 답변에 여러 결정을 함께 적어도 됩니다. 이미 답한 항목은 건너뛰고, 불확실한 항목만 한 번 더 확인합니다.",
  language: "인터뷰 언어",
  researchMode: "연구 방식",
  hypothesisTest: "가설 검증",
  topicDiscovery: "주제 탐색",
  draftPersistence: "작성 중인 답변은 이 Web 서버 프로세스에만 보관됩니다. 서버를 다시 시작하면 미완료 인터뷰가 초기화됩니다.",
  start: "인터뷰 시작",
  starting: "시작 중...",
  cancel: "취소",
  coverage: "필수 항목 진행",
  coverageAriaLabel: "필수 브리프 항목 진행률",
  acceptedVia: "반영 방식",
  fallbackTitle: "해석 대체 경로",
  requiredQuestion: "필수 질문",
  optionalQuestion: "선택 질문",
  answer: "답변",
  answerPlaceholder: "현재 질문에 답해 주세요. 이미 정한 다른 항목도 함께 적을 수 있습니다.",
  defaultAnswerPrefix: "비워 두면 다음 기본값 사용:",
  turnNote: (turn) => `${turn}번째 답변입니다. 입력에서 근거를 확인할 수 있는 항목만 반영됩니다.`,
  continue: "다음 질문으로",
  interpreting: "답변 해석 중...",
  restart: "처음부터 다시",
  close: "닫기",
  completeTitle: "관리형 브리프 완성",
  completeSummary: (answered, required, turns) => `필수 항목 ${answered}/${required}개를 ${turns}번의 답변으로 채웠습니다.`,
  generatedBrief: "생성된 Research Brief",
  startLocked: "연구 시작 잠금",
  missingFields: "누락되었거나 불완전한 브리프 항목"
};

function guidedBriefUiCopy(language: GuidedBriefInterviewLanguage): GuidedBriefUiCopy {
  return language === "ko" ? KOREAN_GUIDED_BRIEF_UI : ENGLISH_GUIDED_BRIEF_UI;
}

interface OllamaDiscoveryState {
  status: OllamaDiscoveryStatus;
  models: string[];
  error?: string;
}

interface OllamaDiscoveryResponse {
  baseUrl: string;
  reachable: boolean;
  models: string[];
  error?: string;
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
  const [newRunCreationMode, setNewRunCreationMode] = useState<NewRunCreationMode>("guided");
  const [newRunBrief, setNewRunBrief] = useState("");
  const [guidedBriefLanguage, setGuidedBriefLanguage] = useState<GuidedBriefInterviewLanguage>("ko");
  const [guidedBriefResearchMode, setGuidedBriefResearchMode] = useState<GuidedBriefResearchMode>("hypothesis_test");
  const [guidedBriefInterview, setGuidedBriefInterview] = useState<WebGuidedBriefInterview | null>(null);
  const [guidedBriefAnswer, setGuidedBriefAnswer] = useState("");
  const [newRunAutoStart, setNewRunAutoStart] = useState(true);
  const [newRunBriefStartGate, setNewRunBriefStartGate] = useState<ResearchBriefStartGate | null>(null);
  const [configOptions, setConfigOptions] = useState<WebConfigOptions>(createDefaultConfigOptions());
  const [setupForm, setSetupForm] = useState<SetupFormState>(createEmptySetupForm());
  const [setupSeeded, setSetupSeeded] = useState(false);
  const [uiActivity, setUiActivity] = useState<UiActivityState | null>(null);
  const [uiError, setUiError] = useState<string | null>(null);
  const [uiNotice, setUiNotice] = useState<UiNoticeState | null>(null);
  const [syncState, setSyncState] = useState<SyncState>("connecting");
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const uiActivitySeq = useRef(0);
  const selectedRunIdRef = useRef<string | undefined>(undefined);
  const selectedArtifactRef = useRef<ArtifactEntry | null>(null);
  const runDetailsRequestSeq = useRef(0);
  const bootstrapRequestSeq = useRef(0);
  const literatureRequestSeq = useRef(0);
  const explorationRequestSeq = useRef(0);
  const artifactPreviewRequestSeq = useRef(0);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    selectedArtifactRef.current = selectedArtifact;
  }, [selectedArtifact]);

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
    setSelectedRun(null);
    setArtifacts([]);
    setCheckpoints([]);
    setSelectedArtifact(null);
    setArtifactPreview(null);
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
    setSelectedRunId((current) =>
      current && bootstrap.runs.some((run) => run.id === current)
        ? current
        : bootstrap.activeRunId || bootstrap.runs[0]?.id
    );
    if (!setupSeeded) {
      setSetupForm(createSetupFormFromBootstrap(bootstrap));
      setSetupSeeded(true);
    }
  }, [bootstrap, setupSeeded]);

  useEffect(() => {
    const source = new EventSource("/api/events/stream");
    source.addEventListener("open", () => {
      setSyncState("live");
      setLastSyncedAt(new Date().toISOString());
    });
    source.addEventListener("error", () => {
      setSyncState("degraded");
    });
    source.addEventListener("session_state", (event) => {
      const nextSession = JSON.parse((event as MessageEvent).data) as WebSessionState;
      startTransition(() => {
        setSession(nextSession);
        setSelectedRunId((current) => current || nextSession.activeRunId);
        setLastSyncedAt(new Date().toISOString());
      });
    });
    source.addEventListener("runtime_event", () => {
      const inspectedRunId = selectedRunIdRef.current;
      if (inspectedRunId) {
        startTransition(() => {
          void refreshRunDetails(inspectedRunId);
        });
      }
      startTransition(() => {
        void refreshBootstrap();
        void refreshJobs();
        void refreshKnowledge();
        void refreshExplorationStatus(inspectedRunId);
      });
    });
    source.addEventListener("bootstrap", () => {
      const inspectedRunId = selectedRunIdRef.current;
      startTransition(() => {
        void refreshBootstrap();
        void refreshJobs();
        void refreshKnowledge();
        void refreshExplorationStatus(inspectedRunId);
      });
    });
    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const inspectedRunId = selectedRunIdRef.current;
      void refreshBootstrap();
      void refreshJobs();
      void refreshExplorationStatus(inspectedRunId);
      if (inspectedRunId) {
        void refreshRunDetails(inspectedRunId);
      }
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
    session && selectedRun && session.activeRunId === selectedRun.id
      ? session.activeRunInsight ?? null
      : null;
  const effectiveActiveRunId = session?.activeRunId || bootstrap?.activeRunId;
  const isSelectedRunActive = Boolean(
    selectedRun && effectiveActiveRunId && selectedRun.id === effectiveActiveRunId
  );
  const selectedKnowledgeEntry =
    knowledgeEntries.find((entry) => entry.run_id === (selectedRunId || session?.activeRunId)) || null;
  const activityRun =
    (bootstrap?.runs || []).find((run) => run.id === effectiveActiveRunId) ||
    (isSelectedRunActive ? selectedRun || undefined : undefined);

  function markSynced(): void {
    setLastSyncedAt(new Date().toISOString());
    setSyncState((current) => current === "live" ? "live" : "polling");
  }

  function reportUiError(error: unknown, fallback: string): void {
    setUiError(error instanceof Error ? error.message : fallback);
    setSyncState("degraded");
  }

  async function refreshBootstrap() {
    const requestSeq = bootstrapRequestSeq.current + 1;
    bootstrapRequestSeq.current = requestSeq;
    try {
      const data = await api<BootstrapResponse>("/api/bootstrap");
      if (requestSeq !== bootstrapRequestSeq.current) {
        return undefined;
      }
      setBootstrap(data);
      if (data.jobQueue) {
        setLiveJobQueue(data.jobQueue);
      }
      markSynced();
      return data;
    } catch (error) {
      if (requestSeq === bootstrapRequestSeq.current) {
        reportUiError(error, "Workspace state could not be loaded.");
      }
      return undefined;
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
    const requestSeq = explorationRequestSeq.current + 1;
    explorationRequestSeq.current = requestSeq;
    try {
      const query = runId ? `?run_id=${encodeURIComponent(runId)}` : "";
      const data = await api<ExplorationStatusResponse>(`/api/exploration/status${query}`);
      if (requestSeq !== explorationRequestSeq.current || (runId && selectedRunIdRef.current !== runId)) {
        return;
      }
      if (typeof data.enabled === "boolean") {
        setExplorationStatus(data);
      } else {
        setExplorationStatus(null);
      }
    } catch {
      if (requestSeq === explorationRequestSeq.current && (!runId || selectedRunIdRef.current === runId)) {
        setExplorationStatus(null);
      }
    }
  }

  async function refreshRunDetails(runId: string) {
    const requestSeq = runDetailsRequestSeq.current + 1;
    runDetailsRequestSeq.current = requestSeq;
    try {
      const [{ run }, artifactsResponse, checkpointsResponse] = await Promise.all([
        api<{ run: RunRecord }>(`/api/runs/${encodeURIComponent(runId)}`),
        api<{ artifacts: ArtifactEntry[] }>(`/api/runs/${encodeURIComponent(runId)}/artifacts`),
        api<{ checkpoints: CheckpointEntry[] }>(`/api/runs/${encodeURIComponent(runId)}/checkpoints`)
      ]);
      if (requestSeq !== runDetailsRequestSeq.current || selectedRunIdRef.current !== runId) {
        return;
      }
      setSelectedRun(run);
      setArtifacts(artifactsResponse.artifacts);
      setCheckpoints(checkpointsResponse.checkpoints);
      markSynced();
      const currentArtifact = selectedArtifactRef.current;
      if (currentArtifact) {
        const nextArtifact = artifactsResponse.artifacts.find((item) => item.path === currentArtifact.path) || null;
        setSelectedArtifact(nextArtifact);
        if (nextArtifact?.previewable) {
          await loadArtifactPreview(runId, nextArtifact);
          return;
        }
        setArtifactPreview(null);
        return;
      }
      setArtifactPreview(null);
    } catch (error) {
      if (requestSeq === runDetailsRequestSeq.current && selectedRunIdRef.current === runId) {
        reportUiError(error, `Run ${runId} could not be loaded.`);
      }
    }
  }

  async function refreshDoctor(liveProviderProbe = false) {
    try {
      const response = liveProviderProbe
        ? await api<DoctorResponse>("/api/doctor/provider-probe", {
            method: "POST",
            body: JSON.stringify({ confirm: true })
          })
        : await api<DoctorResponse>("/api/doctor");
      setDoctorChecks(response.checks);
      setDoctorReadiness(response.readiness || null);
      setDoctorHarness(response.harness || null);
    } catch (error) {
      reportUiError(error, "Doctor state could not be loaded.");
    }
  }

  async function refreshKnowledge() {
    try {
      const response = await api<KnowledgeResponse>("/api/knowledge");
      setKnowledgeEntries(response.entries);
    } catch (error) {
      reportUiError(error, "Repository knowledge could not be loaded.");
    }
  }

  async function refreshLiterature(runId: string) {
    const requestSeq = literatureRequestSeq.current + 1;
    literatureRequestSeq.current = requestSeq;
    try {
      const response = await api<LiteratureResponse>(`/api/runs/${encodeURIComponent(runId)}/literature`);
      if (requestSeq === literatureRequestSeq.current && selectedRunIdRef.current === runId) {
        setLiterature(response.literature);
      }
    } catch (error) {
      if (requestSeq === literatureRequestSeq.current && selectedRunIdRef.current === runId) {
        reportUiError(error, `Literature state for ${runId} could not be loaded.`);
      }
    }
  }

  async function loadKnowledgePreview(relativePath: string) {
    try {
      const response = await api<KnowledgeFileResponse>(`/api/knowledge/file?path=${encodeURIComponent(relativePath)}`);
      setKnowledgePreviewPath(response.path);
      setKnowledgePreviewContent(response.content);
    } catch (error) {
      reportUiError(error, `Knowledge artifact ${relativePath} could not be loaded.`);
    }
  }

  async function loadArtifactPreview(runId: string, artifact: ArtifactEntry) {
    const requestSeq = artifactPreviewRequestSeq.current + 1;
    artifactPreviewRequestSeq.current = requestSeq;
    setSelectedArtifact(artifact);
    if (!artifact.previewable || artifact.kind === "directory") {
      setArtifactPreview(null);
      return;
    }
    if (artifact.kind === "image" || artifact.kind === "pdf") {
      setArtifactPreview(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`);
      return;
    }
    try {
      const text = await fetchText(`/api/runs/${encodeURIComponent(runId)}/artifact?path=${encodeURIComponent(artifact.path)}`);
      if (requestSeq === artifactPreviewRequestSeq.current && selectedRunIdRef.current === runId) {
        setArtifactPreview(text);
      }
    } catch (error) {
      if (requestSeq === artifactPreviewRequestSeq.current && selectedRunIdRef.current === runId) {
        reportUiError(error, `Artifact ${artifact.path} could not be loaded.`);
      }
    }
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
    const runId = selectedRunIdRef.current || session?.activeRunId;
    await openInsightReference(runId ? toRunRelativeArtifactPath(runId, referencePath) : referencePath);
  }

  function inspectRun(runId: string): void {
    selectedRunIdRef.current = runId;
    setSelectedRunId(runId);
  }

  async function activateRun(runId: string) {
    await withUiActivity(`Activating ${runId}`, async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/input", {
        method: "POST",
        body: JSON.stringify({ text: `/run ${runId}` })
      });
      setSession(response.session);
      inspectRun(runId);
      await refreshBootstrap();
      await refreshRunDetails(runId);
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
    const brief = newRunBrief.trim();
    const submissionLanguage = guidedBriefInterview?.language || guidedBriefLanguage;
    const completedInterviewId = guidedBriefInterview?.status === "complete"
      ? guidedBriefInterview.id
      : undefined;
    if (!brief) {
      return;
    }
    await withUiActivity("Creating a new run", async () => {
      const response = await api<WebRunCreationResponse>("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          brief,
          autoStart: newRunAutoStart
        })
      });
      setNewRunBriefStartGate(response.briefStartGate);
      setSession(response.session);
      if (!response.created) {
        return;
      }
      if (response.startOutcome === "deferred") {
        setUiNotice(submissionLanguage === "ko"
          ? {
              message: "Run은 생성되었지만 다른 작업이 진행 중이라 연구 시작은 보류되었습니다. 생성된 Run을 선택했으니 현재 작업이 끝난 뒤 시작해 주세요.",
              dismissLabel: "닫기"
            }
          : {
              message: "The run was created, but research start was deferred because another operation is active. The created run is selected; start it after the current operation finishes.",
              dismissLabel: "Dismiss"
            });
      }
      inspectRun(response.run.id);
      await refreshBootstrap();
      await refreshRunDetails(response.run.id);
      if (completedInterviewId) {
        try {
          await api(`/api/guided-brief-interviews/${encodeURIComponent(completedInterviewId)}`, {
            method: "DELETE"
          });
        } catch {
          // The run is already created; an expired process-local interview does not invalidate it.
        }
      }
      setShowNewRunForm(false);
      setNewRunBrief("");
      setGuidedBriefInterview(null);
      setGuidedBriefAnswer("");
    });
  }

  async function startGuidedBriefInterview(event: FormEvent) {
    event.preventDefault();
    await withUiActivity("Starting a guided Research Brief", async () => {
      const response = await api<WebGuidedBriefInterviewResponse>("/api/guided-brief-interviews", {
        method: "POST",
        body: JSON.stringify({
          language: guidedBriefLanguage,
          researchMode: guidedBriefResearchMode
        })
      });
      setGuidedBriefInterview(response.interview);
      setGuidedBriefAnswer("");
      setNewRunBrief("");
      setNewRunBriefStartGate(null);
    });
  }

  async function submitGuidedBriefAnswer(event: FormEvent) {
    event.preventDefault();
    if (!guidedBriefInterview || guidedBriefInterview.status === "complete") {
      return;
    }
    const answer = guidedBriefAnswer.trim() || guidedBriefInterview.prompt.defaultValue;
    if (guidedBriefInterview.prompt.required && !answer.trim()) {
      return;
    }
    await withUiActivity("Interpreting the guided brief answer", async () => {
      const response = await api<WebGuidedBriefInterviewResponse>(
        `/api/guided-brief-interviews/${encodeURIComponent(guidedBriefInterview.id)}/answers`,
        {
          method: "POST",
          body: JSON.stringify({ answer })
        }
      );
      setGuidedBriefInterview(response.interview);
      setGuidedBriefAnswer("");
      if (response.interview.generatedBrief) {
        setNewRunBrief(response.interview.generatedBrief);
      }
      setNewRunBriefStartGate(null);
    });
  }

  async function restartGuidedBriefInterview() {
    const interviewId = guidedBriefInterview?.id;
    if (interviewId) {
      try {
        await api(`/api/guided-brief-interviews/${encodeURIComponent(interviewId)}`, {
          method: "DELETE"
        });
      } catch {
        // Resetting the local draft remains safe when the server draft has already expired.
      }
    }
    setGuidedBriefInterview(null);
    setGuidedBriefAnswer("");
    setNewRunBrief("");
    setNewRunBriefStartGate(null);
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

  async function runAction(
    endpoint: string,
    body?: unknown,
    activityLabel = "Running action",
    confirmation?: GovernedActionConfirmation
  ) {
    const endpointRunId = endpoint.match(/^\/api\/runs\/([^/]+)\/actions\//u)?.[1];
    const activeRunId = session?.activeRunId || bootstrap?.activeRunId;
    const targetRunId = endpointRunId ? decodeURIComponent(endpointRunId) : undefined;
    if (targetRunId && targetRunId !== activeRunId) {
      setUiError("Activate the inspected run before applying a workflow action.");
      return;
    }
    if (confirmation && targetRunId) {
      const targetRun = selectedRun?.id === targetRunId
        ? selectedRun
        : bootstrap?.runs.find((run) => run.id === targetRunId);
      if (!window.confirm(formatGovernedActionConfirmation({
        ...confirmation,
        runId: targetRunId,
        runTitle: targetRun?.title
      }))) {
        return;
      }
    }
    await withUiActivity(activityLabel, async () => {
      const response = await api<{ session: WebSessionState }>(endpoint, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined
      });
      setSession(response.session);
      const nextRunId = response.session.activeRunId || selectedRunId;
      if (nextRunId) {
        inspectRun(nextRunId);
      }
      await refreshBootstrap();
      if (nextRunId) {
        await refreshRunDetails(nextRunId);
      }
    });
  }

  async function runSessionCommand(text: string, activityLabel = `Running ${summarizeCommand(text)}`) {
    const targetRunId = selectedRunIdRef.current;
    if (targetRunId && (session?.activeRunId || bootstrap?.activeRunId) !== targetRunId) {
      setUiError("Activate the inspected run before sending commands or applying decisions.");
      return;
    }
    if (requiresCommandConfirmation(text) && targetRunId) {
      const targetRun = selectedRun?.id === targetRunId
        ? selectedRun
        : bootstrap?.runs.find((run) => run.id === targetRunId);
      if (!window.confirm(formatGovernedActionConfirmation({
        action: text.trim(),
        runId: targetRunId,
        runTitle: targetRun?.title,
        node: targetRun?.currentNode
      }))) {
        return;
      }
    }
    await withUiActivity(activityLabel, async () => {
      const response = await api<{ session: WebSessionState }>("/api/session/input", {
        method: "POST",
        body: JSON.stringify({ text })
      });
      setSession(response.session);
      const nextRunId = response.session.activeRunId || selectedRunId;
      if (nextRunId) {
        inspectRun(nextRunId);
      }
      await refreshBootstrap();
      if (nextRunId) {
        await refreshRunDetails(nextRunId);
      }
    });
  }

  async function withUiActivity<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    const id = uiActivitySeq.current + 1;
    uiActivitySeq.current = id;
    setUiActivity({ id, label });
    setUiError(null);
    setUiNotice(null);
    try {
      return await work();
    } catch (error) {
      reportUiError(error, `${label} failed.`);
      return undefined;
    } finally {
      setUiActivity((current) => (current?.id === id ? null : current));
    }
  }

  if (!bootstrap || !setupSeeded) {
    return (
      <div className="loading-shell" role="status" aria-live="polite">
        <section className="loading-card">
          <p className="eyebrow">AutoLabOS</p>
          <h1>Research Workbench</h1>
          <p>Loading local workspace state from <code>http://127.0.0.1:4317</code>.</p>
          {uiError ? <p className="error-message">{uiError}</p> : null}
          {uiError ? <button className="button button-primary" type="button" onClick={() => void refreshBootstrap()}>Retry connection</button> : null}
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
      activeRunId={effectiveActiveRunId}
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
      isSelectedRunActive={isSelectedRunActive}
      syncState={syncState}
      lastSyncedAt={lastSyncedAt}
      uiError={uiError}
      uiNotice={uiNotice}
      activityRun={activityRun}
      runSearch={runSearch}
      showNewRunForm={showNewRunForm}
      newRunCreationMode={newRunCreationMode}
      newRunBrief={newRunBrief}
      newRunAutoStart={newRunAutoStart}
      newRunBriefStartGate={newRunBriefStartGate}
      guidedBriefLanguage={guidedBriefLanguage}
      guidedBriefResearchMode={guidedBriefResearchMode}
      guidedBriefInterview={guidedBriefInterview}
      guidedBriefAnswer={guidedBriefAnswer}
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
      onToggleNewRunForm={() => {
        setShowNewRunForm((current) => !current);
        setNewRunBriefStartGate(null);
        setUiNotice(null);
      }}
      onCloseNewRunForm={() => {
        setShowNewRunForm(false);
        setNewRunBriefStartGate(null);
      }}
      onSetNewRunCreationMode={(value) => {
        setNewRunCreationMode(value);
        setNewRunBriefStartGate(null);
      }}
      onSetNewRunBrief={(value) => {
        setNewRunBrief(value);
        setNewRunBriefStartGate(null);
      }}
      onSetNewRunAutoStart={(value) => {
        setNewRunAutoStart(value);
        setNewRunBriefStartGate(null);
      }}
      onSetGuidedBriefLanguage={setGuidedBriefLanguage}
      onSetGuidedBriefResearchMode={setGuidedBriefResearchMode}
      onSetGuidedBriefAnswer={setGuidedBriefAnswer}
      onStartGuidedBriefInterview={startGuidedBriefInterview}
      onSubmitGuidedBriefAnswer={submitGuidedBriefAnswer}
      onRestartGuidedBriefInterview={() => void restartGuidedBriefInterview()}
      onSubmitNewRun={submitNewRun}
      onSelectRun={inspectRun}
      onActivateRun={(runId) => void activateRun(runId)}
      onApprove={(runId) => void runAction(
        `/api/runs/${runId}/actions/approve`,
        undefined,
        "Approving current node",
        { action: "Approve current node", node: selectedRun?.id === runId ? selectedRun.currentNode : undefined }
      )}
      onApplyRecommendation={(runId) =>
        void runAction(
          `/api/runs/${runId}/actions/apply-transition`,
          undefined,
          "Applying transition recommendation",
          { action: "Apply transition recommendation", node: selectedRun?.id === runId ? selectedRun.currentNode : undefined }
        )
      }
      onRetry={(runId, node) =>
        void runAction(
          `/api/runs/${runId}/actions/retry`,
          node ? { node } : undefined,
          `Retrying ${node ? formatNodeLabel(node) : "current node"}`,
          {
            action: `Retry ${node ? formatNodeLabel(node) : "current node"}`,
            node: node || (selectedRun?.id === runId ? selectedRun.currentNode : undefined)
          }
        )
      }
      onOvernight={(runId) =>
        void runAction(
          `/api/runs/${runId}/actions/overnight`,
          undefined,
          "Starting autonomy preset: overnight",
          { action: "Start overnight autonomy preset", node: selectedRun?.id === runId ? selectedRun.currentNode : undefined }
        )
      }
      onRunNode={(runId, node) =>
        void runAction(
          `/api/runs/${runId}/actions/run-node`,
          { node },
          `Running ${formatNodeLabel(node)}`,
          { action: `Run ${formatNodeLabel(node)}`, node }
        )
      }
      onJumpNode={(runId, node) =>
        void runAction(
          `/api/runs/${runId}/actions/jump`,
          { node, force: false },
          `Backtracking to ${formatNodeLabel(node)}`,
          { action: `Backtrack to ${formatNodeLabel(node)}`, node }
        )
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
      onSetSelectedRunId={inspectRun}
      onRunLiveProviderCheck={() => {
        void withUiActivity(
          "Running live provider compatibility check",
          () => refreshDoctor(true)
        );
      }}
      onRetrySync={() => {
        setUiError(null);
        void refreshBootstrap();
        void refreshDoctor();
        void refreshKnowledge();
        const runId = selectedRunIdRef.current;
        if (runId) {
          void refreshRunDetails(runId);
          void refreshLiterature(runId);
        }
      }}
      onDismissError={() => setUiError(null)}
      onDismissNotice={() => setUiNotice(null)}
      onSubmitSetup={submitSetup}
      onSetSetupForm={setSetupForm}
    />
  );
}

interface ResearchWorkbenchProps {
  bootstrap: BootstrapResponse;
  session: WebSessionState | null;
  activeRunId: string | undefined;
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
  isSelectedRunActive: boolean;
  syncState: SyncState;
  lastSyncedAt: string | null;
  uiError: string | null;
  uiNotice: UiNoticeState | null;
  activityRun: RunRecord | undefined;
  runSearch: string;
  showNewRunForm: boolean;
  newRunCreationMode: NewRunCreationMode;
  newRunBrief: string;
  newRunAutoStart: boolean;
  newRunBriefStartGate: ResearchBriefStartGate | null;
  guidedBriefLanguage: GuidedBriefInterviewLanguage;
  guidedBriefResearchMode: GuidedBriefResearchMode;
  guidedBriefInterview: WebGuidedBriefInterview | null;
  guidedBriefAnswer: string;
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
  onSetNewRunCreationMode: (value: NewRunCreationMode) => void;
  onSetNewRunBrief: (value: string) => void;
  onSetNewRunAutoStart: (value: boolean) => void;
  onSetGuidedBriefLanguage: (value: GuidedBriefInterviewLanguage) => void;
  onSetGuidedBriefResearchMode: (value: GuidedBriefResearchMode) => void;
  onSetGuidedBriefAnswer: (value: string) => void;
  onStartGuidedBriefInterview: (event: FormEvent) => Promise<void>;
  onSubmitGuidedBriefAnswer: (event: FormEvent) => Promise<void>;
  onRestartGuidedBriefInterview: () => void;
  onSubmitNewRun: (event: FormEvent) => Promise<void>;
  onSelectRun: (runId: string) => void;
  onActivateRun: (runId: string) => void;
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
  onRunLiveProviderCheck: () => void;
  onRetrySync: () => void;
  onDismissError: () => void;
  onDismissNotice: () => void;
  onSubmitSetup: (event: FormEvent) => Promise<void>;
  onSetSetupForm: Dispatch<SetStateAction<SetupFormState>>;
}

type UtilitySurface = "activity" | "details" | "workflow" | null;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) {
    return [];
  }
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
}

function ResearchWorkbench(props: ResearchWorkbenchProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const newRunWorkspaceRef = useRef<HTMLElement | null>(null);
  const newRunInvokerRef = useRef<HTMLElement | null>(null);
  const previousShowNewRunFormRef = useRef(props.showNewRunForm);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailsMenuRef = useRef<HTMLDivElement | null>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement | null>(null);
  const inspectorHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const detailsSheetRef = useRef<HTMLElement | null>(null);
  const activityCloseRef = useRef<HTMLButtonElement | null>(null);
  const activityDrawerRef = useRef<HTMLElement | null>(null);
  const workflowCloseRef = useRef<HTMLButtonElement | null>(null);
  const workflowNavRef = useRef<HTMLElement | null>(null);
  const utilityInvokerRef = useRef<HTMLElement | null>(null);
  const detailsInvokerRef = useRef<HTMLElement | null>(null);
  const detailsBackdropPointerDownRef = useRef(false);
  const [detailsMenuOpen, setDetailsMenuOpen] = useState(false);
  const [utilitySurface, setUtilitySurface] = useState<UtilitySurface>(null);
  const utilitySurfaceRef = useRef<UtilitySurface>(utilitySurface);
  utilitySurfaceRef.current = utilitySurface;
  const [compactViewport, setCompactViewport] = useState(false);
  const [activityModalViewport, setActivityModalViewport] = useState(false);
  const inspectorOpen = utilitySurface === "details";
  const activityOpen = utilitySurface === "activity";
  const workflowOpen = utilitySurface === "workflow";

  useEffect(() => {
    if (!props.showNewRunForm) {
      return;
    }
    newRunWorkspaceRef.current?.focus({ preventScroll: true });
    newRunWorkspaceRef.current?.scrollIntoView?.({ block: "start" });
  }, [props.showNewRunForm]);

  useEffect(() => {
    const wasOpen = previousShowNewRunFormRef.current;
    previousShowNewRunFormRef.current = props.showNewRunForm;
    if (!wasOpen || props.showNewRunForm) {
      return;
    }
    const invoker = newRunInvokerRef.current;
    window.requestAnimationFrame(() => {
      if (invoker?.isConnected) {
        invoker.focus();
      } else {
        shellRef.current?.querySelector<HTMLButtonElement>(".topbar-new-run")?.focus();
      }
    });
  }, [props.showNewRunForm]);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const compactQuery = window.matchMedia("(max-width: 767px)");
    const activityQuery = window.matchMedia("(max-width: 1320px)");
    const update = () => {
      setCompactViewport(compactQuery.matches);
      setActivityModalViewport(activityQuery.matches);
    };
    update();
    compactQuery.addEventListener?.("change", update);
    activityQuery.addEventListener?.("change", update);
    return () => {
      compactQuery.removeEventListener?.("change", update);
      activityQuery.removeEventListener?.("change", update);
    };
  }, []);

  useEffect(() => {
    const openCommandPanel = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const runPickerInvoker = shellRef.current?.querySelector<HTMLElement>(
          ".run-picker-popover"
        )
          ? shellRef.current?.querySelector<HTMLElement>(".run-picker-trigger") || null
          : null;
        openInspector("logs", runPickerInvoker);
      }
    };
    document.addEventListener("keydown", openCommandPanel);
    return () => document.removeEventListener("keydown", openCommandPanel);
  }, [utilitySurface, detailsMenuOpen]);

  useEffect(() => {
    if (!detailsMenuOpen) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (!detailsMenuRef.current?.contains(event.target as Node)) {
        setDetailsMenuOpen(false);
      }
    };
    const dismissWithKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setDetailsMenuOpen(false);
        detailsButtonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [detailsMenuOpen]);

  useEffect(() => {
    if (!utilitySurface) {
      return;
    }
    const surface = utilitySurface === "details"
      ? detailsSheetRef.current
      : utilitySurface === "activity"
        ? activityDrawerRef.current
        : workflowNavRef.current;
    const isModal = utilitySurface === "details"
      || (utilitySurface === "activity" ? activityModalViewport : compactViewport);
    const focusTarget = utilitySurface === "details"
      ? inspectorHeadingRef.current
      : utilitySurface === "activity"
        ? activityCloseRef.current
        : workflowCloseRef.current;
    const background = Array.from(shellRef.current?.querySelectorAll<HTMLElement>(
      ".skip-link, .console-topbar, .workflow-map, .decision-workspace, .run-action-dock"
    ) || []).filter((element) => !element.contains(surface) && element !== surface);

    if (isModal) {
      document.body.classList.add("has-console-overlay");
      for (const element of background) {
        element.setAttribute("inert", "");
      }
    }
    window.requestAnimationFrame(() => focusTarget?.focus());

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (utilitySurfaceRef.current !== utilitySurface) {
        return;
      }
      if (event.key === "Escape") {
        if (isModal || surface?.contains(document.activeElement)) {
          event.preventDefault();
          closeUtilitySurface();
        }
        return;
      }
      if (event.key !== "Tab" || !isModal) {
        return;
      }
      const focusable = focusableElements(surface);
      if (focusable.length === 0) {
        event.preventDefault();
        focusTarget?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const activeIndex = activeElement ? focusable.indexOf(activeElement) : -1;
      if (event.shiftKey && activeIndex <= 0) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (activeIndex < 0 || activeElement === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.classList.remove("has-console-overlay");
      for (const element of background) {
        element.removeAttribute("inert");
      }
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [utilitySurface, compactViewport, activityModalViewport]);

  function rememberUtilityInvoker(fallback?: HTMLElement | null): void {
    utilityInvokerRef.current = resolveUtilityInvoker(fallback);
  }

  function resolveUtilityInvoker(fallback?: HTMLElement | null): HTMLElement | null {
    const current = document.activeElement;
    if (current instanceof HTMLElement && current.closest(".run-picker-popover")) {
      return shellRef.current?.querySelector<HTMLElement>(".run-picker-trigger") || fallback || null;
    }
    return current instanceof HTMLElement ? current : fallback || null;
  }

  function closeUtilitySurface(): void {
    const invoker = utilitySurface === "details"
      ? detailsInvokerRef.current
      : utilityInvokerRef.current;
    setUtilitySurface(null);
    window.requestAnimationFrame(() => {
      if (invoker?.isConnected) {
        invoker.focus();
      } else {
        detailsButtonRef.current?.focus();
      }
    });
  }

  function openInspector(tab: TabId, preferredInvoker?: HTMLElement | null): void {
    if (utilitySurface === "details") {
      props.onSetActiveTab(tab);
      setDetailsMenuOpen(false);
      return;
    }
    if (utilitySurface === "activity") {
      const activeElement = document.activeElement;
      if (preferredInvoker) {
        detailsInvokerRef.current = preferredInvoker;
      } else if (!(activeElement instanceof Node) || !activityDrawerRef.current?.contains(activeElement)) {
        detailsInvokerRef.current = resolveUtilityInvoker();
      } else {
        detailsInvokerRef.current = utilityInvokerRef.current;
      }
    } else {
      if (preferredInvoker) {
        detailsInvokerRef.current = preferredInvoker;
      } else if (detailsMenuOpen && detailsButtonRef.current) {
        detailsInvokerRef.current = detailsButtonRef.current;
      } else {
        detailsInvokerRef.current = resolveUtilityInvoker();
      }
    }
    props.onSetActiveTab(tab);
    setDetailsMenuOpen(false);
    setUtilitySurface("details");
  }

  function openActivity(): void {
    if (utilitySurface === "activity") {
      rememberUtilityInvoker();
      closeUtilitySurface();
      return;
    }
    rememberUtilityInvoker();
    setDetailsMenuOpen(false);
    setUtilitySurface("activity");
  }

  function openWorkflow(): void {
    if (utilitySurface === "workflow") {
      rememberUtilityInvoker();
      closeUtilitySurface();
      return;
    }
    rememberUtilityInvoker();
    setDetailsMenuOpen(false);
    setUtilitySurface("workflow");
  }

  function toggleNewRunForm(): void {
    if (!props.showNewRunForm) {
      const activeElement = document.activeElement;
      newRunInvokerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
    }
    props.onToggleNewRunForm();
  }

  function closeNewRunForm(): void {
    props.onCloseNewRunForm();
  }

  const compactUtilityOpen = (activityOpen && activityModalViewport) || (workflowOpen && compactViewport);

  return (
    <div
      ref={shellRef}
      className={`workbench-shell research-console ${activityOpen ? "activity-is-open" : ""} ${compactUtilityOpen ? "compact-utility-is-open" : ""}`}
    >
      <a className="skip-link" href="#decision-workspace">Skip to decision workspace</a>
      <OperatorContextBar
        {...props}
        onToggleNewRunForm={toggleNewRunForm}
        onOpenCommand={() => openInspector("logs")}
        utilitySurface={utilitySurface}
        activityOpen={activityOpen}
        workflowOpen={workflowOpen}
        onToggleActivity={openActivity}
        onToggleWorkflow={openWorkflow}
      />
      <div className={`console-body ${props.selectedRun && !props.showNewRunForm ? "has-workflow" : "without-workflow"}`}>
        {props.selectedRun && !props.showNewRunForm ? (
          <WorkflowMap
            {...props}
            closeRef={workflowCloseRef}
            navRef={workflowNavRef}
            mobileOpen={workflowOpen}
            compactViewport={compactViewport}
            onClose={closeUtilitySurface}
          />
        ) : null}
        <main id="decision-workspace" className="workbench-main decision-workspace">
          {props.selectedRunId && props.activeRunId !== props.selectedRunId ? (
            <div className="context-mismatch-notice" role="status">
              <span><strong>Inspection only.</strong> Actions still target <code>{props.activeRunId || "none"}</code>. Use the Next action dock to switch targets.</span>
            </div>
          ) : null}
          <RuntimeRibbon {...props} />
          {props.showNewRunForm ? (
            <section
              ref={newRunWorkspaceRef}
              id="new-run-workspace"
              className="new-run-workspace"
              aria-labelledby="new-run-workspace-heading"
              tabIndex={-1}
            >
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">New research run</p>
                  <h2 id="new-run-workspace-heading">Create research run</h2>
                </div>
                <button
                  className="button button-secondary button-small"
                  type="button"
                  disabled={props.isBusy}
                  onClick={closeNewRunForm}
                >
                  Close
                </button>
              </div>
              <p className="new-run-workspace-intro">
                Build a governed brief through an adaptive interview, or paste a complete brief you already prepared.
              </p>
              <NewRunComposer {...props} />
            </section>
          ) : props.selectedRun ? (
            <>
              <ResearchRunHero
                {...props}
                detailsButtonRef={detailsButtonRef}
                detailsMenuRef={detailsMenuRef}
                activityOpen={activityOpen}
                detailsMenuOpen={detailsMenuOpen}
                onToggleActivity={() => {
                  openActivity();
                }}
                onToggleDetails={() => setDetailsMenuOpen((current) => !current)}
                onOpenInspector={openInspector}
              />
              <DecisionEvidence {...props} onOpenInspector={openInspector} />
              <RecentRunActivity {...props} onOpenActivity={openActivity} />
              <HumanInterventionCard {...props} />
              <PendingPlanQueue {...props} />
            </>
          ) : (
            <section className="empty-run-state">
              <p className="eyebrow">Run selection</p>
              <h2>No run selected</h2>
              <p>Create a governed research run, or choose an existing run from the run selector above.</p>
              <button
                className="button button-primary"
                type="button"
                disabled={props.isBusy}
                onClick={toggleNewRunForm}
              >
                Create research run
              </button>
            </section>
          )}
        </main>
        {activityOpen ? (
          <LiveActivityDrawer
            {...props}
            drawerRef={activityDrawerRef}
            closeRef={activityCloseRef}
            compactViewport={activityModalViewport}
            onClose={closeUtilitySurface}
            onOpenInspector={openInspector}
          />
        ) : null}
      </div>
      {props.selectedRun && !props.showNewRunForm ? <RunActionDock {...props} onOpenInspector={openInspector} /> : null}
      {compactUtilityOpen ? (
        <div className="utility-backdrop" aria-hidden="true" onClick={closeUtilitySurface} />
      ) : null}
      {inspectorOpen ? (
        <div
          className="details-overlay"
          role="presentation"
          onPointerDown={(event) => {
            detailsBackdropPointerDownRef.current = event.target === event.currentTarget;
          }}
          onPointerUp={(event) => {
            if (detailsBackdropPointerDownRef.current && event.target === event.currentTarget) {
              closeUtilitySurface();
            }
            detailsBackdropPointerDownRef.current = false;
          }}
        >
          <section ref={detailsSheetRef} className="details-sheet" role="dialog" aria-modal="true" aria-labelledby="details-sheet-heading">
            <WorkbenchInspector
              {...props}
              closeRef={inspectorCloseRef}
              headingRef={inspectorHeadingRef}
              onClose={closeUtilitySurface}
            />
          </section>
        </div>
      ) : null}
    </div>
  );
}

function OperatorContextBar(props: ResearchWorkbenchProps & {
  utilitySurface: UtilitySurface;
  activityOpen: boolean;
  workflowOpen: boolean;
  onOpenCommand: () => void;
  onToggleActivity: () => void;
  onToggleWorkflow: () => void;
}) {
  const contextMismatch = Boolean(props.selectedRunId && props.activeRunId !== props.selectedRunId);
  const runPickerRef = useRef<HTMLDivElement | null>(null);
  const runPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [runPickerOpen, setRunPickerOpen] = useState(false);
  const inspectedRun = props.bootstrap.runs.find((run) => run.id === props.selectedRunId);

  useEffect(() => {
    if (props.utilitySurface) {
      setRunPickerOpen(false);
    }
  }, [props.utilitySurface]);

  useEffect(() => {
    if (!runPickerOpen) {
      return;
    }
    const dismiss = (event: PointerEvent) => {
      if (!runPickerRef.current?.contains(event.target as Node)) {
        setRunPickerOpen(false);
      }
    };
    const dismissWithKeyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setRunPickerOpen(false);
        runPickerTriggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [runPickerOpen]);

  return (
    <header className={`operator-context console-topbar ${contextMismatch ? "context-locked" : ""}`} aria-label="Run context">
      <div className="console-brand" aria-label="AutoLabOS">
        <Flask aria-hidden="true" size={28} weight="duotone" />
        <h1>AutoLabOS</h1>
      </div>
      <button
        className="mobile-workflow-toggle"
        type="button"
        aria-expanded={props.workflowOpen}
        aria-controls="workflow-navigation"
        disabled={!props.selectedRun || props.showNewRunForm}
        onClick={props.onToggleWorkflow}
      >
        <ListChecks aria-hidden="true" size={18} weight="bold" />
        Workflow
      </button>
      <div className="context-run-picker topbar-run-picker" ref={runPickerRef}>
        <button
          ref={runPickerTriggerRef}
          className="run-picker-trigger"
          type="button"
          aria-label={`Inspect run. Current: ${inspectedRun?.title || "No runs"}`}
          aria-describedby="active-run-description"
          aria-expanded={runPickerOpen}
          aria-controls="run-picker-options"
          disabled={props.bootstrap.runs.length === 0}
          onClick={() => setRunPickerOpen((current) => !current)}
        >
          <span><small>Inspecting run</small><strong>{inspectedRun?.title || "No runs"}</strong></span>
          <CaretDown className="run-picker-caret" aria-hidden="true" size={16} weight="bold" />
        </button>
        <span id="active-run-description" className="visually-hidden">Active command target: {props.activeRunId || "none"}</span>
        {runPickerOpen ? (
          <div className="run-picker-popover" id="run-picker-options">
            <label>
              <span className="visually-hidden">Search runs</span>
              <input
                autoFocus
                type="search"
                aria-label="Search runs"
                placeholder="Search by title or ID"
                value={props.runSearch}
                onChange={(event) => props.onSetRunSearch(event.target.value)}
              />
            </label>
            <div className="run-picker-options">
              {props.filteredRuns.length === 0 ? <p>No runs match this search.</p> : props.filteredRuns.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={props.selectedRunId === run.id ? "selected" : ""}
                  aria-current={props.selectedRunId === run.id ? "true" : undefined}
                  onClick={() => {
                    props.onSelectRun(run.id);
                    setRunPickerOpen(false);
                    window.requestAnimationFrame(() => runPickerTriggerRef.current?.focus());
                  }}
                >
                  <span><strong>{run.title}</strong><small>{run.id}</small></span>
                  {props.activeRunId === run.id ? <span className="active-target-label">Active</span> : null}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <button
        className={`topbar-sync sync-${props.syncState}`}
        type="button"
        aria-label={`Open live activity. Sync status: ${formatSyncState(props.syncState)}`}
        aria-expanded={props.activityOpen}
        aria-controls="live-activity-drawer"
        onClick={props.onToggleActivity}
      >
        <span className="sync-indicator" aria-hidden="true" />
        <span role="status" aria-live="polite">{formatSyncState(props.syncState)}</span>
      </button>
      <button className="console-command" type="button" aria-label="Open command panel" aria-keyshortcuts="Meta+K Control+K" onClick={props.onOpenCommand}>
        <TerminalWindow aria-hidden="true" size={18} />
        <span>Open command panel</span>
        <kbd><Command aria-hidden="true" size={13} />K</kbd>
      </button>
      <div className="topbar-time">
        <small>Last update</small>
        <time
          dateTime={props.lastSyncedAt || undefined}
          aria-label={props.lastSyncedAt ? formatTimestamp(props.lastSyncedAt) : undefined}
        >
          {props.lastSyncedAt ? formatActivityTime(props.lastSyncedAt) : "not yet"}
        </time>
      </div>
      <div className="operator-context-actions">
        <button
          className="button button-primary topbar-new-run"
          type="button"
          aria-expanded={props.showNewRunForm}
          aria-controls="new-run-workspace"
          disabled={props.isBusy}
          onClick={props.onToggleNewRunForm}
        >
          <Plus aria-hidden="true" size={18} weight="bold" />
          {props.showNewRunForm ? "Close new run" : "New run"}
        </button>
      </div>
      {!contextMismatch && props.selectedRunId ? <span className="visually-hidden">Actions target this run</span> : null}
      {props.uiError ? (
        <div className="operator-error" role="alert">
          <span>{props.uiError}</span>
          <div className="operator-error-actions">
            <button className="button button-secondary button-small" type="button" onClick={props.onRetrySync}>Retry sync</button>
            <button className="button button-ghost button-small" type="button" onClick={props.onDismissError}>Dismiss</button>
          </div>
        </div>
      ) : null}
      {props.uiNotice ? (
        <div className="operator-notice" role="status">
          <span>{props.uiNotice.message}</span>
          <button className="button button-ghost button-small" type="button" onClick={props.onDismissNotice}>{props.uiNotice.dismissLabel}</button>
        </div>
      ) : null}
    </header>
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
            aria-label="Search runs"
            placeholder="Search runs"
            value={props.runSearch}
            onChange={(event) => props.onSetRunSearch(event.target.value)}
          />
        </div>
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
                  className={`run-ledger-item ${props.selectedRunId === run.id ? "selected" : ""} ${props.activeRunId === run.id ? "active-target" : ""}`}
                  type="button"
                  disabled={props.isBusy}
                  onClick={() => props.onSelectRun(run.id)}
                >
                  <span className={`status-dot ${statusToneClass(lifecycleStatus)}`} />
                  <strong>{run.title}</strong>
                  <span>{formatNodeLabel(run.currentNode)} · {formatTimestamp(job?.last_event_at || run.updatedAt)}</span>
                  {props.activeRunId === run.id ? <span className="active-target-label">Active command target</span> : null}
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
        <h2 className="section-kicker" id="live-watch-heading">Live watch</h2>
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
  const interview = props.guidedBriefInterview;
  const language = interview?.language || props.guidedBriefLanguage;
  const copy = guidedBriefUiCopy(language);
  const canSubmitGuidedAnswer = Boolean(
    interview
    && interview.status === "active"
    && (!interview.prompt.required || props.guidedBriefAnswer.trim() || interview.prompt.defaultValue)
  );
  return (
    <div className="workbench-form new-run-form" lang={language === "ko" ? "ko" : "en"}>
      <div
        className="new-run-mode-switch"
        role="group"
        aria-label={language === "ko" ? "Research Brief 입력 방식" : "Research brief input mode"}
      >
        <button
          className={`button ${props.newRunCreationMode === "guided" ? "button-primary" : "button-secondary"}`}
          type="button"
          aria-pressed={props.newRunCreationMode === "guided"}
          disabled={props.isBusy}
          onClick={() => props.onSetNewRunCreationMode("guided")}
        >
          {copy.guidedMode}
        </button>
        <button
          className={`button ${props.newRunCreationMode === "paste" ? "button-primary" : "button-secondary"}`}
          type="button"
          aria-pressed={props.newRunCreationMode === "paste"}
          disabled={props.isBusy}
          onClick={() => props.onSetNewRunCreationMode("paste")}
        >
          {copy.pasteMode}
        </button>
      </div>

      {props.newRunCreationMode === "paste" ? (
        <form className="guided-brief-stage" onSubmit={props.onSubmitNewRun}>
          <div className="form-explainer">
            <strong>{copy.pasteTitle}</strong>
            <p>{copy.pasteDescription}</p>
          </div>
          <label>
            {copy.briefLabel}
            <textarea
              required
              disabled={props.isBusy}
              value={props.newRunBrief}
              onChange={(event) => props.onSetNewRunBrief(event.target.value)}
              rows={9}
              placeholder={copy.briefPlaceholder}
            />
          </label>
          <ResearchBriefStartGateNotice copy={copy} gate={props.newRunBriefStartGate} />
          <NewRunAutoStartControl {...props} />
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={props.isBusy || !props.newRunBrief.trim()}>
              {props.isBusy ? formatNewRunWorkingLabel(language) : formatNewRunSubmitLabel(props.newRunAutoStart, language)}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onCloseNewRunForm}>
              {copy.cancel}
            </button>
          </div>
        </form>
      ) : !interview ? (
        <form className="guided-brief-stage" onSubmit={props.onStartGuidedBriefInterview}>
          <div className="form-explainer">
            <strong>{copy.title}</strong>
            <p>{copy.description}</p>
          </div>
          <label>
            {copy.language}
            <select
              disabled={props.isBusy}
              value={props.guidedBriefLanguage}
              onChange={(event) => props.onSetGuidedBriefLanguage(event.target.value as GuidedBriefInterviewLanguage)}
            >
              {GUIDED_BRIEF_LANGUAGE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            {copy.researchMode}
            <select
              disabled={props.isBusy}
              value={props.guidedBriefResearchMode}
              onChange={(event) => props.onSetGuidedBriefResearchMode(event.target.value as GuidedBriefResearchMode)}
            >
              <option value="hypothesis_test">{copy.hypothesisTest}</option>
              <option value="topic_discovery">{copy.topicDiscovery}</option>
            </select>
          </label>
          <p className="form-note">{copy.draftPersistence}</p>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={props.isBusy}>
              {props.isBusy ? copy.starting : copy.start}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onCloseNewRunForm}>
              {copy.cancel}
            </button>
          </div>
        </form>
      ) : interview.status === "active" ? (
        <form className="guided-brief-stage" onSubmit={props.onSubmitGuidedBriefAnswer}>
          {interview.turnCount === 0 && interview.introLines.length > 0 ? (
            <div className="form-explainer guided-brief-intro" lang={language}>
              {interview.introLines.map((line) => <p key={line}>{line}</p>)}
            </div>
          ) : null}
          <div className="guided-brief-progress" role="status" aria-live="polite">
            <div>
              <span>{copy.coverage}</span>
              <strong>{interview.coverage.answered}/{interview.coverage.required}</strong>
            </div>
            <progress
              aria-label={copy.coverageAriaLabel}
              max={interview.coverage.required}
              value={interview.coverage.answered}
            />
          </div>
          {interview.lastAcceptedFields.length > 0 ? (
            <div
              className="guided-brief-accepted"
              aria-label={language === "ko" ? "이전 답변에서 반영된 항목" : "Fields accepted from the previous answer"}
            >
              <span>{copy.acceptedVia} {formatGuidedBriefResolutionSource(interview.lastResolutionSource, language)}</span>
              <div className="chip-list">
                {interview.lastAcceptedFields.map((field) => (
                  <span className="chip" key={field}>{formatGuidedBriefField(field, language)}</span>
                ))}
              </div>
            </div>
          ) : null}
          {interview.lastFallbackReason ? (
            <div className="guided-brief-diagnostic" role="status" aria-live="polite">
              <strong>{copy.fallbackTitle}</strong>
              <span>{formatGuidedBriefFallbackReason(interview.lastFallbackReason, language)}</span>
            </div>
          ) : null}
          <div className="guided-brief-question" lang={language}>
            <span>{interview.prompt.required ? copy.requiredQuestion : copy.optionalQuestion}</span>
            <strong>{interview.prompt.question}</strong>
          </div>
          <label>
            {copy.answer}
            <textarea
              autoFocus
              disabled={props.isBusy}
              value={props.guidedBriefAnswer}
              onChange={(event) => props.onSetGuidedBriefAnswer(event.target.value)}
              rows={5}
              placeholder={interview.prompt.defaultValue
                ? `${copy.defaultAnswerPrefix} ${interview.prompt.defaultValue}`
                : copy.answerPlaceholder}
            />
          </label>
          <p className="form-note">{copy.turnNote(interview.turnCount + 1)}</p>
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={props.isBusy || !canSubmitGuidedAnswer}>
              {props.isBusy ? copy.interpreting : copy.continue}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onRestartGuidedBriefInterview}>
              {copy.restart}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onCloseNewRunForm}>
              {copy.close}
            </button>
          </div>
        </form>
      ) : (
        <form className="guided-brief-stage" onSubmit={props.onSubmitNewRun}>
          <div className="guided-brief-complete" role="status" aria-live="polite">
            <strong>{copy.completeTitle}</strong>
            <span>{copy.completeSummary(interview.coverage.answered, interview.coverage.required, interview.turnCount)}</span>
          </div>
          <label>
            {copy.generatedBrief}
            <textarea
              required
              disabled={props.isBusy}
              value={props.newRunBrief}
              onChange={(event) => props.onSetNewRunBrief(event.target.value)}
              rows={10}
            />
          </label>
          <ResearchBriefStartGateNotice copy={copy} gate={props.newRunBriefStartGate} />
          <NewRunAutoStartControl {...props} />
          <div className="form-actions">
            <button className="button button-primary" type="submit" disabled={props.isBusy || !props.newRunBrief.trim()}>
              {props.isBusy ? formatNewRunWorkingLabel(language) : formatNewRunSubmitLabel(props.newRunAutoStart, language)}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onRestartGuidedBriefInterview}>
              {copy.restart}
            </button>
            <button className="button button-secondary" type="button" disabled={props.isBusy} onClick={props.onCloseNewRunForm}>
              {copy.close}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function ResearchBriefStartGateNotice(props: {
  copy: GuidedBriefUiCopy;
  gate: ResearchBriefStartGate | null;
}) {
  if (!props.gate?.blocked) {
    return null;
  }
  return (
    <div className="operator-error" role="status" aria-live="polite">
      <div>
        <strong>{props.copy.startLocked}</strong>
        <p>{props.copy.missingFields}:</p>
        <div className="chip-list" aria-label={props.copy.missingFields}>
          {props.gate.missingFields.map((field) => (
            <span className="chip" key={field}>{field}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function NewRunAutoStartControl(props: ResearchWorkbenchProps) {
  const language = props.guidedBriefInterview?.language || props.guidedBriefLanguage;
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        disabled={props.isBusy}
        checked={props.newRunAutoStart}
        onChange={(event) => props.onSetNewRunAutoStart(event.target.checked)}
      />
      <span>{language === "ko" ? "Run을 만든 뒤 연구를 바로 시작" : "Auto-start research after creating the run"}</span>
    </label>
  );
}

function formatNewRunSubmitLabel(autoStart: boolean, language: GuidedBriefInterviewLanguage): string {
  if (language === "ko") {
    return autoStart ? "Run 생성 후 연구 시작" : "Run만 생성";
  }
  return autoStart ? "Create and start research" : "Create run without starting";
}

function formatNewRunWorkingLabel(language: GuidedBriefInterviewLanguage): string {
  return language === "ko" ? "처리 중..." : "Working...";
}

const KOREAN_GUIDED_BRIEF_FIELDS: Record<WebGuidedBriefInterview["lastAcceptedFields"][number], string> = {
  topic: "주제",
  scientificObject: "과학적 대상",
  empiricalProblems: "관찰된 문제",
  priorWorkProbes: "선행연구 탐색 기준",
  primaryMetric: "주요 지표",
  meaningfulImprovement: "의미 있는 개선 기준",
  constraints: "제약 조건",
  researchQuestion: "연구 질문",
  whySmallExperiment: "소규모 실험 가능성",
  baselineComparator: "베이스라인 / 비교 대상",
  datasetTaskBench: "데이터셋 / 작업 / 벤치마크",
  targetComparison: "목표 비교",
  minimumAcceptableEvidence: "최소 허용 증거",
  disallowedShortcuts: "금지되는 지름길",
  allowedBudgetedPasses: "허용된 추가 패스",
  paperCeiling: "증거가 약할 때의 논문 상한",
  minimumExperimentPlan: "최소 실험 계획",
  failureConditions: "실패 조건",
  secondaryMetrics: "보조 지표",
  manuscriptTemplate: "원고 템플릿",
  appendixPrefer: "부록 권장 항목",
  appendixKeepMain: "본문 유지 항목",
  notes: "메모",
  questionsRisks: "질문 / 리스크"
};

function formatGuidedBriefField(
  field: WebGuidedBriefInterview["lastAcceptedFields"][number],
  language: GuidedBriefInterviewLanguage
): string {
  if (language === "ko") {
    return KOREAN_GUIDED_BRIEF_FIELDS[field];
  }
  return field.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (value) => value.toUpperCase());
}

function formatGuidedBriefResolutionSource(
  source: WebGuidedBriefInterview["lastResolutionSource"],
  language: GuidedBriefInterviewLanguage
): string {
  if (language === "ko") {
    if (source === "labeled_input") return "명시적 항목 입력";
    if (source === "model") return "범위가 제한된 해석";
    if (source === "operator_control") return "사용자 직접 제어";
    return "보수적 대체 처리";
  }
  if (source === "labeled_input") return "labeled input";
  if (source === "model") return "bounded interpretation";
  if (source === "operator_control") return "operator control";
  return "guarded fallback";
}

function formatGuidedBriefFallbackReason(
  reason: NonNullable<WebGuidedBriefInterview["lastFallbackReason"]>,
  language: GuidedBriefInterviewLanguage
): string {
  if (language === "ko") {
    if (reason === "empty_answer") return "답변이 없어 현재 항목을 미완료 상태로 유지했습니다.";
    if (reason === "explicit_uncertainty") return "답변에 불확실성이 명시되어 모델 해석을 시도하지 않았습니다.";
    if (reason === "model_unavailable") return "해석 모델을 사용할 수 없어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_auth_unavailable") return "해석 제공자의 인증을 사용할 수 없거나 거부되어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_request_rejected") return "설정된 모델 지원 문제 등으로 해석 요청이 거부되어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_quota_exhausted") return "해석 제공자의 사용량 한도가 소진되었습니다. 한도 초기화 또는 계정 설정 복구 후 다시 시도해 주세요.";
    if (reason === "provider_rate_limited") return "해석 요청이 일시적으로 제한되어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_timeout") return "해석 요청 시간이 초과되어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_transport_error") return "해석 제공자에 연결할 수 없어 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "provider_empty_response") return "해석 제공자가 사용할 수 있는 답변을 반환하지 않아 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "invalid_model_json") return "해석 응답이 올바른 JSON이 아니어서 현재 항목만 보수적으로 반영했습니다.";
    if (reason === "invalid_model_schema") return "해석 응답이 제한된 스키마와 맞지 않아 현재 항목만 보수적으로 반영했습니다.";
    return "안전하게 표시할 수 있는 세부 진단 없이 해석 요청이 실패해 현재 항목만 보수적으로 반영했습니다.";
  }
  if (reason === "empty_answer") {
    return "No answer was supplied, so the current field remains pending.";
  }
  if (reason === "explicit_uncertainty") {
    return "The answer marked this field as uncertain, so model interpretation was not attempted.";
  }
  if (reason === "model_unavailable") {
    return "No interpretation model was available. Only the current field was accepted.";
  }
  if (reason === "provider_auth_unavailable") {
    return "The interpretation provider authentication was unavailable or rejected. Only the current field was accepted.";
  }
  if (reason === "provider_request_rejected") {
    return "The provider rejected the interpretation request, such as when the configured model is unsupported. Only the current field was accepted.";
  }
  if (reason === "provider_quota_exhausted") {
    return "The interpretation provider usage quota is exhausted. Wait for the quota to reset or repair the provider account before retrying. Only the current field was accepted.";
  }
  if (reason === "provider_rate_limited") {
    return "The interpretation provider rate-limited the request. Only the current field was accepted.";
  }
  if (reason === "provider_timeout") {
    return "The interpretation request timed out. Only the current field was accepted.";
  }
  if (reason === "provider_transport_error") {
    return "The interpretation provider could not be reached. Only the current field was accepted.";
  }
  if (reason === "provider_empty_response") {
    return "The interpretation provider returned no usable text. Only the current field was accepted.";
  }
  if (reason === "invalid_model_json") {
    return "The interpretation response was not valid JSON. Only the current field was accepted.";
  }
  if (reason === "invalid_model_schema") {
    return "The interpretation response did not match the bounded schema. Only the current field was accepted.";
  }
  return "The interpretation provider failed without a safe diagnostic detail. Only the current field was accepted.";
}

function RuntimeRibbon(props: ResearchWorkbenchProps) {
  if (!props.isBusy || !props.activeBusyLabel) {
    return null;
  }
  return (
    <section className="runtime-ribbon">
      <div className="runtime-status" role="status" aria-live="polite">
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
      </div>
      {props.session?.canCancel && !props.isSelectedRunActive ? (
        <button className="button button-danger" type="button" onClick={props.onCancelActive}>
          Cancel active task
        </button>
      ) : null}
    </section>
  );
}

function ResearchRunHero(props: ResearchWorkbenchProps & {
  detailsButtonRef: RefObject<HTMLButtonElement | null>;
  detailsMenuRef: RefObject<HTMLDivElement | null>;
  activityOpen: boolean;
  detailsMenuOpen: boolean;
  onToggleActivity: () => void;
  onToggleDetails: () => void;
  onOpenInspector: (tab: TabId) => void;
}) {
  if (!props.selectedRun) {
    return null;
  }
  const transition = props.selectedRun.graph.pendingTransition;
  const decisionFocus =
    transition
      ? `${transition.action}${transition.targetNode ? ` toward ${formatNodeLabel(transition.targetNode)}` : ""}: ${transition.reason}`
      : props.selectedJob?.blocker_summary
        || props.selectedRun.latestSummary
        || "No blocking decision is currently attached to this run.";
  const currentState = props.selectedRun.graph.nodeStates[props.selectedRun.currentNode];
  const decisionQuestion = buildDecisionQuestion(props.selectedRun.currentNode, currentState?.status);

  return (
    <section className="run-hero decision-header" aria-labelledby="decision-heading">
      <div className="decision-heading-row">
        <div>
          <p className="eyebrow">Node {NODE_ORDER.indexOf(props.selectedRun.currentNode) + 1} of {NODE_ORDER.length}</p>
          <h2 id="decision-heading">{formatNodeLabel(props.selectedRun.currentNode)} decision</h2>
        </div>
        <div className="decision-toolbar">
          <button
            className="button button-secondary button-small"
            type="button"
            aria-expanded={props.activityOpen}
            aria-controls="live-activity-drawer"
            onClick={props.onToggleActivity}
          >
            <Pulse aria-hidden="true" size={17} weight="bold" />
            Live activity
          </button>
          <div className="details-menu-wrap" ref={props.detailsMenuRef}>
            <button
              ref={props.detailsButtonRef}
              className="button button-secondary button-small"
              type="button"
              aria-expanded={props.detailsMenuOpen}
              aria-controls="run-details-menu"
              onClick={props.onToggleDetails}
            >
              Details
              <CaretDown aria-hidden="true" size={15} weight="bold" />
            </button>
            {props.detailsMenuOpen ? (
              <nav className="details-menu" id="run-details-menu" aria-label="Run details destinations">
                {DETAIL_TABS.map((tab) => (
                  <button key={tab.id} type="button" onClick={() => props.onOpenInspector(tab.id)}>
                    {detailTabIcon(tab.id)}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </nav>
            ) : null}
          </div>
        </div>
      </div>
      <div className="decision-run-line">
        <span>Run: <strong>{props.selectedRun.title}</strong></span>
        <span aria-hidden="true">•</span>
        <span>State: <strong className={`inline-status ${props.selectedRunStatusClass}`}>{formatStatusLabel(currentState?.status || props.selectedRun.status)}</strong></span>
        <span aria-hidden="true">•</span>
        <span>Checkpoint #{props.selectedRun.graph.checkpointSeq}</span>
      </div>
      <div className="decision-question">
        <h3>Decision question</h3>
        <p>{decisionQuestion}</p>
        <p className="decision-explanation">{decisionFocus}</p>
      </div>
    </section>
  );
}

function buildDecisionQuestion(node: NodeId, status: string | undefined): string {
  if (status === "needs_approval") {
    return node === "review"
      ? "Do we have sufficient, trustworthy evidence to proceed with paper drafting?"
      : `Is the evidence sufficient to approve ${formatNodeLabel(node)} and continue?`;
  }
  if (status === "failed") {
    return `What must be repaired before ${formatNodeLabel(node)} can run again?`;
  }
  if (status === "running") {
    return `Is ${formatNodeLabel(node)} progressing within the governed execution contract?`;
  }
  if (status === "completed") {
    return `What evidence from ${formatNodeLabel(node)} should guide the next governed step?`;
  }
  return `Is ${formatNodeLabel(node)} ready to run under the current research contract?`;
}

function detailTabIcon(tab: TabId): ReactNode {
  const iconProps = { "aria-hidden": true, size: 17 } as const;
  switch (tab) {
    case "overview":
      return <FileText {...iconProps} />;
    case "logs":
      return <TerminalWindow {...iconProps} />;
    case "artifacts":
      return <FolderOpen {...iconProps} />;
    case "checkpoints":
      return <ClockCounterClockwise {...iconProps} />;
    case "knowledge":
      return <Database {...iconProps} />;
    case "meta":
      return <ClipboardText {...iconProps} />;
    case "workspace":
      return <Gear {...iconProps} />;
    case "doctor":
      return <ShieldCheck {...iconProps} />;
  }
}

type ResearchRunHeroAction = { kind: "approve" | "apply" | "retry" | "run" };

function deriveResearchRunHeroAction(
  props: ResearchWorkbenchProps,
  currentStatus: string | undefined
): ResearchRunHeroAction | null {
  if (!props.selectedRun || !props.isSelectedRunActive || props.isBusy || props.session?.canCancel) {
    return null;
  }
  if (props.session?.pendingPlan || props.session?.humanIntervention?.runId === props.selectedRun.id) {
    return null;
  }
  if (props.selectedRun.status === "completed") {
    return null;
  }

  const transition = props.selectedRun.graph.pendingTransition;
  if (currentStatus === "needs_approval") {
    return transition?.action === "delegate_successor" ? null : { kind: "approve" };
  }
  if (transition) {
    if (
      transition.autoExecutable === true
      && transition.action !== "pause_for_human"
      && transition.action !== "delegate_successor"
    ) {
      return { kind: "apply" };
    }
    return null;
  }
  if (currentStatus === "completed") {
    return null;
  }
  if (currentStatus === "failed") {
    return { kind: "retry" };
  }
  if (currentStatus === "pending") {
    return { kind: "run" };
  }
  const recommendationAligned = props.selectedJob?.current_node === props.selectedRun.currentNode;
  if (
    currentStatus === "running"
    && recommendationAligned
    && props.selectedJob?.recommended_next_action === "rerun_after_fix"
  ) {
    return { kind: "retry" };
  }
  return null;
}

function RunActionDock(props: ResearchWorkbenchProps & { onOpenInspector?: (tab: TabId) => void }) {
  if (!props.selectedRun) {
    return null;
  }
  const currentStatus = props.selectedRun.graph.nodeStates[props.selectedRun.currentNode]?.status;
  const action = deriveResearchRunHeroAction(props, currentStatus);
  const actionCopy = describeHeroAction(action?.kind, props.selectedRun.currentNode);

  if (!props.isSelectedRunActive) {
    return (
      <section className="run-action-dock" role="region" aria-label="Next action">
        <div>
          <span className="action-dock-label">Inspection only</span>
          <strong>Activate this run before changing its state</strong>
          <small>The current active command target will remain unchanged until you switch it explicitly.</small>
        </div>
        <button className="button button-primary" type="button" disabled={props.isBusy} onClick={() => props.onActivateRun(props.selectedRun!.id)}>
          Activate inspected run
        </button>
      </section>
    );
  }

  if (props.isBusy && props.session?.canCancel) {
    return (
      <section className="run-action-dock" role="region" aria-label="Next action">
        <div>
          <span className="action-dock-label">Active task</span>
          <strong>{props.activeBusyLabel || "The current node is running"}</strong>
          <small>Cancel only if the active operation should stop before completion.</small>
        </div>
        <button className="button button-danger" type="button" onClick={props.onCancelActive}>Cancel active task</button>
      </section>
    );
  }

  if (!action) {
    const intervention = props.session?.humanIntervention?.runId === props.selectedRun.id;
    return (
      <section className="run-action-dock is-passive" role="region" aria-label="Next action">
        <div>
          <span className="action-dock-label">{intervention ? "Your next action" : "Current state"}</span>
          <strong>{intervention ? "Answer the requested question to continue" : formatStatusLabel(currentStatus || props.selectedRun.status)}</strong>
          <small>{intervention ? "Open the command panel to respond within the declared recovery choices." : "No governed state change is available from this screen right now."}</small>
        </div>
        {intervention && props.onOpenInspector ? (
          <button className="button button-primary" type="button" onClick={() => props.onOpenInspector?.("logs")}>Open command panel</button>
        ) : null}
      </section>
    );
  }

  return (
    <section className="run-action-dock" role="region" aria-label="Next action">
      <div>
        <span className="action-dock-label">Your next action</span>
        <strong>{actionCopy.title}</strong>
        <small>{actionCopy.detail}</small>
      </div>
      {action.kind === "approve" ? (
        <button className="button button-primary" type="button" onClick={() => props.onApprove(props.selectedRun!.id)}>
          <CheckCircle aria-hidden="true" size={20} weight="bold" />
          Approve current node
        </button>
      ) : null}
      {action.kind === "apply" ? (
        <button className="button button-primary" type="button" onClick={() => props.onApplyRecommendation(props.selectedRun!.id)}>
          Apply recommendation
        </button>
      ) : null}
      {action.kind === "retry" ? (
        <button className="button button-primary" type="button" onClick={() => props.onRetry(props.selectedRun!.id)}>
          Retry current node
        </button>
      ) : null}
      {action.kind === "run" ? (
        <button className="button button-primary" type="button" onClick={() => props.onRunNode(props.selectedRun!.id, props.selectedRun!.currentNode)}>
          Run current node
        </button>
      ) : null}
    </section>
  );
}

function describeHeroAction(kind: ResearchRunHeroAction["kind"] | undefined, node: NodeId): { title: string; detail: string } {
  switch (kind) {
    case "approve":
      return {
        title: "Approve the current node to continue",
        detail: "The workflow will apply the governed approval transition after confirmation."
      };
    case "apply":
      return {
        title: "Apply the reviewed transition recommendation",
        detail: "The pending transition remains inspectable and requires confirmation before it changes the run."
      };
    case "retry":
      return {
        title: `Retry ${formatNodeLabel(node)} after reviewing the blocker`,
        detail: "The node will restart under the same governed run contract after confirmation."
      };
    case "run":
      return {
        title: `Run ${formatNodeLabel(node)}`,
        detail: "The current pending node will start after confirmation."
      };
    default:
      return { title: "No action available", detail: "Inspect the current run state for the next governed step." };
  }
}

interface DecisionEvidenceProps extends ResearchWorkbenchProps {
  onOpenInspector: (tab: TabId) => void;
}

interface DecisionEvidenceRow {
  key: string;
  label: string;
  status: string;
  detail: string;
  tone: "warning" | "danger" | "success" | "neutral";
  path?: string;
  icon: ReactNode;
}

function DecisionEvidence(props: DecisionEvidenceProps) {
  const rows = buildDecisionEvidenceRows(props);
  const hasBlockingEvidence = rows.some((row) => row.tone === "danger");
  const hasEvidenceWarning = rows.some((row) => row.tone === "warning");
  const evidenceHeading = hasBlockingEvidence
    ? "Blocking evidence"
    : hasEvidenceWarning
      ? "Evidence requiring attention"
      : "Evidence checks";
  return (
    <section className="decision-evidence" aria-labelledby="decision-evidence-heading">
      <div className="section-heading editorial-heading">
        <div>
          <h3 id="decision-evidence-heading">{evidenceHeading}</h3>
          <p>These checks determine whether the run can advance.</p>
        </div>
      </div>
      <div className="evidence-row-list">
        {rows.map((row) => (
          <article className={`evidence-row tone-${row.tone}`} key={row.key}>
            <span className="evidence-icon" aria-hidden="true">{row.icon}</span>
            <strong className="evidence-title">{row.label}</strong>
            <span className="evidence-result">{row.status}</span>
            <p>{row.detail}</p>
            <button
              className="evidence-link"
              type="button"
              onClick={() => {
                if (row.path) {
                  props.onOpenInsightReference(row.path);
                  props.onOpenInspector("artifacts");
                } else {
                  props.onOpenInspector("overview");
                }
              }}
            >
              {row.path ? "View artifact" : "View run details"} <ArrowRight aria-hidden="true" size={16} weight="bold" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

function buildDecisionEvidenceRows(props: ResearchWorkbenchProps): DecisionEvidenceRow[] {
  const adequacy = props.selectedJob?.evidence_adequacy;
  const assurance = props.selectedJob?.review_assurance;
  const readiness = props.selectedJob?.evidence_readiness;
  const adequacyPath = adequacy?.artifact_refs[0]?.path || readiness?.artifact_ref?.path;
  const adequacyPending = adequacy?.status === "unmeasured" || adequacy?.status === "awaiting_execution";
  const adequacyTone: DecisionEvidenceRow["tone"] = adequacy?.status === "pass"
    ? "success"
    : adequacy?.status === "fail" || adequacy?.status === "invalid"
      ? "danger"
      : adequacyPending || !adequacy
        ? "neutral"
        : "warning";
  const paperStatus = !adequacy || adequacy.status === "unmeasured"
    ? "Unmeasured"
    : adequacy.status === "awaiting_execution"
      ? "Awaiting execution"
      : adequacy.paper_evidence_allowed
        ? "Allowed"
        : "Blocked";
  const paperBlocked = paperStatus === "Blocked";
  const paperTone: DecisionEvidenceRow["tone"] = paperStatus === "Allowed"
    ? "success"
    : paperBlocked
      ? "danger"
      : "neutral";
  const assuranceTone: DecisionEvidenceRow["tone"] = assurance?.status === "valid"
    ? "success"
    : assurance?.status === "invalid"
      ? "danger"
      : assurance?.status === "missing" || (assurance?.status === "not_started" && assurance.required_for_paper_ready)
        ? "warning"
        : "neutral";
  const genericDetail = props.selectedJob?.blocker_summary || props.selectedRun?.latestSummary || "No additional evidence detail is available yet.";
  return [
    {
      key: "evidence-adequacy",
      label: "Evidence adequacy",
      status: adequacy ? formatEvidenceAdequacy(adequacy) : readiness ? formatEvidenceReadiness(readiness) : "Unmeasured",
      detail: adequacy
        ? adequacy.status === "unmeasured"
          ? "Evidence adequacy has not been measured yet."
          : adequacy.status === "awaiting_execution"
            ? "Evidence adequacy will be evaluated after execution receipts are available."
            : `Trusted ${adequacy.trusted ? "yes" : "no"} · Integrity ${adequacy.integrity_valid ? "valid" : "invalid"}`
        : genericDetail,
      tone: adequacyTone,
      path: adequacyPath,
      icon: <WarningCircle size={22} weight="duotone" />
    },
    {
      key: "paper-evidence",
      label: "Paper evidence",
      status: paperStatus,
      detail: props.selectedJob?.paper_readiness_reason || (paperStatus === "Unmeasured"
        ? "Paper-facing evidence has not been evaluated yet."
        : paperStatus === "Awaiting execution"
          ? "Paper-facing evidence will be evaluated after experiment execution."
          : paperBlocked
            ? "Required review-gate evidence for paper scope is missing."
            : "The current evidence contract permits paper-facing use."),
      tone: paperTone,
      path: props.selectedCompletenessChecklistArtifact?.path,
      icon: <FileText size={22} weight="duotone" />
    },
    {
      key: "review-assurance",
      label: "Review assurance",
      status: assurance ? formatReviewAssuranceStatus(assurance.status) : "Unmeasured",
      detail: assurance ? formatReviewAssuranceSummary(assurance) : genericDetail,
      tone: assuranceTone,
      path: assurance?.artifact_refs[0]?.path,
      icon: <ShieldCheck size={22} weight="duotone" />
    }
  ];
}

interface RunActivityItem {
  id: string;
  label: string;
  detail: string;
  timestamp: string;
  tone: "active" | "success" | "warning" | "neutral";
}

function RecentRunActivity(props: ResearchWorkbenchProps & { onOpenActivity: () => void }) {
  const items = buildRunActivityItems(props, false).slice(0, 3);
  return (
    <section className="recent-run-activity" aria-labelledby="recent-activity-heading">
      <div className="section-heading editorial-heading">
        <h3 id="recent-activity-heading">Recent activity</h3>
        <button className="text-action" type="button" onClick={props.onOpenActivity}>View all activity <ArrowRight aria-hidden="true" size={15} /></button>
      </div>
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <span className={`activity-dot tone-${item.tone}`} aria-hidden="true" />
            <time dateTime={item.timestamp}>{formatActivityTime(item.timestamp)}</time>
            <span>{item.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LiveActivityDrawer(props: ResearchWorkbenchProps & {
  closeRef: RefObject<HTMLButtonElement | null>;
  drawerRef: RefObject<HTMLElement | null>;
  compactViewport: boolean;
  onClose: () => void;
  onOpenInspector: (tab: TabId) => void;
}) {
  const items = buildRunActivityItems(props, true);
  return (
    <aside
      ref={props.drawerRef}
      className={`live-activity-drawer ${props.compactViewport ? "is-modal-sheet" : ""}`}
      id="live-activity-drawer"
      role={props.compactViewport ? "dialog" : undefined}
      aria-modal={props.compactViewport ? true : undefined}
      aria-labelledby="live-activity-heading"
    >
      <div className="activity-drawer-header">
        <div>
          <h2 id="live-activity-heading">Live activity</h2>
          <p><span className={`sync-indicator sync-${props.syncState}`} aria-hidden="true" /> {formatSyncState(props.syncState)}</p>
        </div>
        <button ref={props.closeRef} className="icon-button" type="button" aria-label="Close live activity" onClick={props.onClose}>
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <ol className="activity-timeline">
        {items.length === 0 ? <li className="activity-empty">No run or background activity has been recorded yet.</li> : items.map((item) => (
          <li key={item.id} className={`tone-${item.tone}`}>
            <time dateTime={item.timestamp} aria-label={formatTimestamp(item.timestamp)}>{formatActivityTime(item.timestamp)}</time>
            <span className="timeline-marker" aria-hidden="true" />
            <div><strong>{item.label}</strong><p>{item.detail}</p></div>
          </li>
        ))}
      </ol>
      {props.session?.logs.length ? (
        <section className="activity-output" aria-labelledby="recent-output-heading">
          <h3 id="recent-output-heading">Recent output</h3>
          <p>Runtime output does not include structured timestamps, so it is shown separately.</p>
          {props.session.logs.slice(-4).map((line, index) => <pre key={`${line}-${index}`}>{line}</pre>)}
        </section>
      ) : null}
      <details className="live-operations">
        <summary>Operations</summary>
        <section aria-labelledby="live-watch-heading">
          <h3 id="live-watch-heading">Live watch</h3>
          {renderLiveWatchTable(props.jobQueue)}
        </section>
        <section>
          <h3>Background jobs</h3>
          {renderJobBucket("Running", props.jobQueue.running)}
          {renderJobBucket("Waiting", props.jobQueue.waiting)}
          {renderJobBucket("Stalled", props.jobQueue.stalled)}
        </section>
        <section>
          <h3>Exploration engine</h3>
          {renderExplorationStatusCard(props.explorationStatus)}
        </section>
        {props.bootstrap.jobs?.top_failures?.length ? (
          <section>
            <h3>Top failures</h3>
            {props.bootstrap.jobs.top_failures.map((failure) => (
              <article key={failure.key} className="mini-finding">
                <strong>{Math.round(failure.recurrence_probability * 100)}% · {failure.reason}</strong>
                <span>Fix: {failure.remediation}</span>
              </article>
            ))}
          </section>
        ) : null}
      </details>
      <div className="activity-drawer-links">
        <button type="button" onClick={() => props.onOpenInspector("logs")}><TerminalWindow aria-hidden="true" size={18} /> View logs</button>
        <button type="button" onClick={() => props.onOpenInspector("artifacts")}><FolderOpen aria-hidden="true" size={18} /> View artifacts</button>
      </div>
      <small>Times shown in your local timezone.</small>
    </aside>
  );
}

function buildRunActivityItems(props: ResearchWorkbenchProps, includeWorkspaceJobs: boolean): RunActivityItem[] {
  const items: RunActivityItem[] = [];
  if (props.selectedRun) {
    const currentState = props.selectedRun.graph.nodeStates[props.selectedRun.currentNode];
    items.push({
      id: `current:${props.selectedRun.currentNode}:${currentState?.updatedAt || props.selectedRun.updatedAt}`,
      label: `${formatNodeLabel(props.selectedRun.currentNode)} · ${formatStatusLabel(currentState?.status || props.selectedRun.status)}`,
      detail: currentState?.note || currentState?.lastError || props.selectedRun.latestSummary || "Current node state updated.",
      timestamp: currentState?.updatedAt || props.selectedRun.updatedAt,
      tone: currentState?.status === "completed" ? "success" : currentState?.status === "failed" || currentState?.status === "needs_approval" ? "warning" : "active"
    });
    for (const transition of props.selectedRun.graph.transitionHistory || []) {
      items.push({
        id: `transition:${transition.action}:${transition.appliedAt}`,
        label: `Transition · ${formatStatusLabel(transition.action)}`,
        detail: transition.reason,
        timestamp: transition.appliedAt,
        tone: "active"
      });
    }
    for (const checkpoint of props.checkpoints) {
      items.push({
        id: `checkpoint:${checkpoint.seq}:${checkpoint.createdAt}`,
        label: `Checkpoint #${checkpoint.seq}`,
        detail: `${formatNodeLabel(checkpoint.node)} · ${checkpoint.reason || checkpoint.phase}`,
        timestamp: checkpoint.createdAt,
        tone: "success"
      });
    }
    for (const artifact of props.artifacts.slice(0, 5)) {
      items.push({
        id: `artifact:${artifact.path}:${artifact.modifiedAt}`,
        label: `Artifact updated · ${artifact.path.split("/").pop() || artifact.path}`,
        detail: artifact.path,
        timestamp: artifact.modifiedAt,
        tone: "neutral"
      });
    }
  }
  for (const [bucket, jobs] of Object.entries(props.jobQueue) as Array<["running" | "waiting" | "stalled", typeof props.jobQueue.running]>) {
    for (const job of jobs.filter((entry) => includeWorkspaceJobs || entry.run_id === props.selectedRun?.id)) {
      items.push({
        id: `job:${bucket}:${job.run_id}:${job.node}:${job.started_at}`,
        label: `${formatNodeLabel(job.node)} · ${formatStatusLabel(bucket)}`,
        detail: `${job.run_id} · ${job.recommendation_line || (job.source === "collect_background_job" ? "Background collection job" : "Governed node job")}`,
        timestamp: job.started_at,
        tone: bucket === "stalled" || job.status === "needs_approval" ? "warning" : bucket === "running" ? "active" : "neutral"
      });
    }
  }
  return items
    .filter((item) => Number.isFinite(Date.parse(item.timestamp)))
    .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .slice(0, 12);
}

function formatActivityTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "Unknown time";
  }
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
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
        {props.selectedJob ? <article><span>Workflow readiness</span><strong>{formatReadinessTriple(props.selectedJob)}</strong></article> : null}
        {props.selectedJob?.evidence_readiness ? (
          <article>
            <span>Evidence readiness</span>
            <strong>{formatEvidenceReadiness(props.selectedJob.evidence_readiness)}</strong>
          </article>
        ) : null}
        {props.selectedJob?.evidence_readiness?.primary_comparison_id ? (
          <article>
            <span>Primary comparison</span>
            <strong><code>{props.selectedJob.evidence_readiness.primary_comparison_id}</code></strong>
          </article>
        ) : null}
        {props.selectedJob?.evidence_adequacy ? (
          <article>
            <span>Evidence adequacy</span>
            <strong>{formatEvidenceAdequacy(props.selectedJob.evidence_adequacy)}</strong>
            <p>
              Trusted {props.selectedJob.evidence_adequacy.trusted ? "yes" : "no"}
              {" · "}
              Integrity {props.selectedJob.evidence_adequacy.integrity_valid ? "valid" : "invalid"}
            </p>
          </article>
        ) : null}
        {props.selectedJob?.evidence_adequacy ? (
          <article>
            <span>Paper evidence</span>
            <strong>{props.selectedJob.evidence_adequacy.paper_evidence_allowed ? "Allowed" : "Blocked"}</strong>
          </article>
        ) : null}
        {props.selectedJob?.evidence_adequacy?.primary_comparison_id ? (
          <article>
            <span>Adequacy comparison</span>
            <strong><code>{props.selectedJob.evidence_adequacy.primary_comparison_id}</code></strong>
          </article>
        ) : null}
        {shouldShowEvidenceAdequacyReasons(props.selectedJob?.evidence_adequacy) ? (
          <article>
            <span>Adequacy reasons</span>
            <strong>{formatEvidenceAdequacyReasons(props.selectedJob!.evidence_adequacy!)}</strong>
          </article>
        ) : null}
        {props.selectedJob?.evidence_adequacy?.artifact_refs.length ? (
          <article>
            <span>Adequacy artifacts</span>
            <div className="decision-actions">
              {props.selectedJob.evidence_adequacy.artifact_refs.map((artifact) => (
                <button
                  key={`${artifact.kind}-${artifact.path}`}
                  className="button button-secondary button-small"
                  type="button"
                  disabled={props.isBusy}
                  onClick={() => props.onOpenInsightReference(artifact.path)}
                  aria-label={`Open ${artifact.label}`}
                >
                  {formatEvidenceAdequacyArtifactKind(artifact.kind)}
                </button>
              ))}
            </div>
          </article>
        ) : null}
        {props.selectedJob?.review_gate_status ? (
          <article><span>Review gate</span><strong>{props.selectedJob.review_gate_label || formatReviewGateStatus(props.selectedJob.review_gate_status, props.selectedJob.review_decision_outcome, props.selectedJob.review_recommended_transition)}</strong></article>
        ) : null}
        {props.selectedJob?.review_assurance ? (
          <article>
            <span>Review assurance</span>
            <strong>{formatReviewAssuranceStatus(props.selectedJob.review_assurance.status)}</strong>
            <p>{formatReviewAssuranceSummary(props.selectedJob.review_assurance)}</p>
          </article>
        ) : null}
        {props.selectedJob?.review_assurance?.reason_codes.length ? (
          <article>
            <span>Review assurance reasons</span>
            <strong><code>{props.selectedJob.review_assurance.reason_codes.join(", ")}</code></strong>
          </article>
        ) : null}
        {props.selectedJob?.review_assurance?.artifact_refs.length ? (
          <article>
            <span>Review assurance artifacts</span>
            <div className="decision-actions">
              {props.selectedJob.review_assurance.artifact_refs.map((artifact) => (
                <button
                  key={`${artifact.kind}-${artifact.path}`}
                  className="button button-secondary button-small"
                  type="button"
                  disabled={props.isBusy}
                  onClick={() => props.onOpenInsightReference(artifact.path)}
                  aria-label={`Open ${artifact.label}`}
                >
                  {artifact.kind.replaceAll("_", " ")}
                </button>
              ))}
            </div>
          </article>
        ) : null}
        {props.selectedJob?.research_process ? (
          <article>
            <span>Research process</span>
            <strong>
              {props.selectedJob.research_process.status.replaceAll("_", " ")}
              {" · "}
              {props.selectedJob.research_process.passed_required_check_count}/{props.selectedJob.research_process.required_check_count}
            </strong>
            <p>
              Blockers {props.selectedJob.research_process.blocker_count}
              {" · "}
              Paper gate {props.selectedJob.research_process.paper_ready_eligible ? "eligible" : "blocked"}
            </p>
          </article>
        ) : null}
        {props.selectedJob?.research_process?.checks.some((check) => check.required && check.status !== "pass") ? (
          <article className="process-checks-card">
            <span>Process checks requiring action</span>
            <ul className="process-check-list" aria-label="Research process checks requiring action">
              {props.selectedJob.research_process.checks
                .filter((check) => check.required && check.status !== "pass")
                .map((check) => (
                  <li key={check.id}>
                    <code>{check.id}</code>
                    <span className={`status-pill process-check-status ${check.status === "fail" || check.status === "invalid" ? "is-danger" : "is-warning"}`}>
                      {formatStatusLabel(check.status)}
                    </span>
                  </li>
                ))}
            </ul>
          </article>
        ) : null}
        {props.selectedJob?.research_process?.checks.some((check) => check.required && check.status !== "pass" && check.artifact_refs.length > 0) ? (
          <article>
            <span>Process evidence</span>
            <div className="decision-actions">
              {props.selectedJob.research_process.checks
                .filter((check) => check.required && check.status !== "pass")
                .flatMap((check) => check.artifact_refs)
                .filter((artifact, index, artifacts) => artifacts.findIndex((candidate) => candidate.path === artifact.path) === index)
                .slice(0, 4)
                .map((artifact) => (
                  <button
                    key={artifact.path}
                    className="button button-secondary button-small"
                    type="button"
                    disabled={props.isBusy}
                    onClick={() => props.onOpenInsightReference(artifact.path)}
                    aria-label={`Open ${artifact.label}`}
                  >
                    {artifact.label}
                  </button>
                ))}
            </div>
          </article>
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
      {props.selectedJob?.research_funnel?.research_mode === "topic_discovery" ? (
        <ResearchFunnelSummary
          funnel={props.selectedJob.research_funnel}
          runScope={props.selectedRun.topic}
        />
      ) : null}
      {props.selectedRun.constraints.length ? (
        <div className="chip-list">
          {props.selectedRun.constraints.map((constraint) => <span key={constraint} className="chip">{constraint}</span>)}
        </div>
      ) : null}
      {props.selectedRun.graph.pendingTransition ? <TransitionPanel {...props} /> : null}
      {!props.selectedRun.graph.pendingTransition ? <AppliedTransitionNotice run={props.selectedRun} /> : null}
      {props.activeInsight ? <InsightPanel {...props} /> : null}
    </section>
  );
}

function ResearchFunnelSummary({
  funnel,
  runScope
}: {
  funnel: NonNullable<RunJobProjection["research_funnel"]>;
  runScope: string;
}) {
  const toneClass = researchFunnelToneClass(funnel);
  const activeProbe = readVerifiedActiveTopicProbe(funnel);
  const executionAuthorization = readExecutionAuthorization(funnel);
  const gapEvidenceAudit = normalizeResearchGapEvidenceAudit(
    funnel.gap_evidence_audit
  );
  const visibleReasonCodes = funnel.reason_codes;
  const blockedGates = funnel.gates.filter((gate) => gate.status === "block");
  const reviewerDissent = funnel.dissent.filter(
    (finding) => finding.hard_block || finding.findings.length > 0
  );
  const collectionFailure = formatCollectionFailureSummary(funnel);
  const collectionHint = readCollectionHintView(funnel);
  const activeQueryReformulation =
    collectionHint
    && isActiveQueryReformulationHint(funnel, collectionHint)
      ? formatQueryReformulationSummary(collectionHint)
      : undefined;
  const portfolioCandidates = Array.isArray(funnel.portfolio_candidates)
    ? funnel.portfolio_candidates
    : [];

  return (
    <section className={`research-funnel ${toneClass}`} aria-label="Research topic funnel">
      <div className="research-funnel-heading">
        <div>
          <p className="section-kicker">Research topic funnel</p>
          <h3>Topic discovery lifecycle</h3>
        </div>
        <span className={`status-pill ${toneClass}`}>{formatResearchFunnelStatus(funnel)}</span>
      </div>
      <div
        className="research-funnel-evidence-boundary"
        role="note"
        aria-label="Bounded probe evidence boundary"
      >
        Bounded probe only; not paper evidence · <code>paper_evidence_allowed=false</code>
      </div>
      <dl className="research-funnel-metrics">
        <div>
          <dt>Mode</dt>
          <dd><code>{funnel.research_mode}</code></dd>
        </div>
        <div>
          <dt>Lifecycle</dt>
          <dd>{formatResearchFunnelLifecycle(funnel)}</dd>
        </div>
        <div>
          <dt>Integrity</dt>
          <dd>{formatStatusLabel(funnel.integrity_status)}</dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd className={collectionStateStatusClass(funnel.collection_state)}>
            {formatStatusLabel(funnel.collection_state)}
            {formatCollectionAttempt(funnel)}
          </dd>
        </div>
        {collectionFailure ? (
          <div>
            <dt>Collection issue</dt>
            <dd className="status-warning">{collectionFailure}</dd>
          </div>
        ) : null}
        {activeQueryReformulation ? (
          <div>
            <dt>Query reformulation</dt>
            <dd>{activeQueryReformulation}</dd>
          </div>
        ) : null}
        <div>
          <dt>Pre-probe disposition</dt>
          <dd>{formatResearchFunnelDisposition(funnel)}</dd>
        </div>
        <div>
          <dt>Outcome disposition</dt>
          <dd>{funnel.outcome_disposition
            ? formatStatusLabel(funnel.outcome_disposition)
            : "Unmeasured"}</dd>
        </div>
        <div>
          <dt>Outcome next action</dt>
          <dd>{funnel.outcome_next_action
            ? formatStatusLabel(funnel.outcome_next_action)
            : "Unmeasured"}</dd>
        </div>
        {funnel.venue_viability && (
          funnel.outcome_disposition
          || funnel.venue_viability.status !== "unmeasured"
        ) ? (
          <>
            <div>
              <dt>Venue assessment</dt>
              <dd>{formatStatusLabel(funnel.venue_viability.status)} ({
                funnel.venue_viability.trusted ? "trusted" : "untrusted"
              })</dd>
            </div>
            {funnel.venue_viability.candidate_viability ? (
            <div>
              <dt>Candidate viability</dt>
              <dd>{formatStatusLabel(funnel.venue_viability.candidate_viability)}</dd>
            </div>
            ) : null}
            {funnel.venue_viability.confirmatory_candidacy ? (
              <div>
                <dt>Confirmatory candidacy</dt>
                <dd>{formatStatusLabel(funnel.venue_viability.confirmatory_candidacy)}</dd>
              </div>
            ) : null}
            {funnel.venue_viability.current_evidence_ceiling ? (
            <div>
              <dt>Current evidence ceiling</dt>
              <dd>{formatStatusLabel(funnel.venue_viability.current_evidence_ceiling)}</dd>
            </div>
            ) : null}
            <div>
              <dt>Top-tier readiness</dt>
              <dd>{funnel.venue_viability?.top_tier_readiness
                ? formatStatusLabel(funnel.venue_viability.top_tier_readiness)
                  + " (not ready; acceptance not assessed)"
                : "Unmeasured (not assessed)"}</dd>
            </div>
          </>
        ) : null}
        <div>
          <dt>Candidates</dt>
          <dd>{funnel.candidate_count}{funnel.diagnostics_trusted ? "" : " (diagnostic)"}</dd>
        </div>
        <div>
          <dt>Clusters</dt>
          <dd>{funnel.cluster_count}{funnel.diagnostics_trusted ? "" : " (diagnostic)"}</dd>
        </div>
        <div>
          <dt>Candidate direct-prior search</dt>
          <dd className={
            funnel.candidate_prior_search.status === "blocked"
            || funnel.candidate_prior_search.status === "exhausted"
              ? "status-warning"
              : undefined
          }>
            {formatStatusLabel(funnel.candidate_prior_search.status)}
            {` · ${funnel.candidate_prior_search.trusted ? "trusted" : "not trusted"}`}
          </dd>
        </div>
        <div>
          <dt>Direct-prior rounds</dt>
          <dd>
            {funnel.candidate_prior_search.completed_rounds}/{funnel.candidate_prior_search.max_rounds || "unmeasured"}
            {` · receipt ${formatStatusLabel(funnel.candidate_prior_search.current_receipt_status)}`}
          </dd>
        </div>
        <div>
          <dt>Estimator feasibility</dt>
          <dd className={
            funnel.estimator_feasibility.status === "blocked"
            || funnel.estimator_feasibility.status === "invalid"
              ? "status-warning"
              : undefined
          }>
            {formatStatusLabel(funnel.estimator_feasibility.status)}
            {` · ${funnel.estimator_feasibility.trusted ? "trusted" : "not trusted"}`}
          </dd>
        </div>
        <div>
          <dt>Experiment execution</dt>
          <dd className={
            executionAuthorization.status === "blocked"
            || executionAuthorization.status === "invalid"
              ? "status-warning"
              : undefined
          }>
            {formatStatusLabel(executionAuthorization.status)}
            {` · ${executionAuthorization.trusted ? "trusted" : "not trusted"}`}
          </dd>
        </div>
        <div>
          <dt>Topic memory</dt>
          <dd className={
            funnel.topic_memory.status === "blocked" ? "status-warning" : undefined
          }>
            {formatStatusLabel(funnel.topic_memory.status)}
            {` · ${funnel.topic_memory.trusted ? "trusted" : "not trusted"}`}
          </dd>
        </div>
        <div>
          <dt>Memory decisions</dt>
          <dd>
            {funnel.topic_memory.record_count} records · {funnel.topic_memory.blocked_candidate_count} blocked · {funnel.topic_memory.reentry_required_count} reentry required · {funnel.topic_memory.reentry_allowed_count} allowed
          </dd>
        </div>
        <div>
          <dt>Evidence chain</dt>
          <dd>{formatStatusLabel(gapEvidenceAudit.status)}</dd>
        </div>
        <div>
          <dt>Grounded scientific evidence</dt>
          <dd>{gapEvidenceAudit.grounded_scientific_evidence_count}/{gapEvidenceAudit.scientific_evidence_count}</dd>
        </div>
        <div>
          <dt>Synthesis eligible</dt>
          <dd>{gapEvidenceAudit.synthesis_eligible_evidence_count}/{gapEvidenceAudit.total_evidence_count}</dd>
        </div>
        <div>
          <dt>Accepted gap clusters</dt>
          <dd>{gapEvidenceAudit.accepted_cluster_count}</dd>
        </div>
        {gapEvidenceAudit.analysis_coverage ? (
          <div>
            <dt>Analysis coverage</dt>
            <dd>{gapEvidenceAudit.analysis_coverage.completed_paper_count}/{gapEvidenceAudit.analysis_coverage.selected_paper_count}</dd>
          </div>
        ) : null}
        <div>
          <dt>Probe candidates</dt>
          <dd>{funnel.probe_candidate_count}</dd>
        </div>
        <div>
          <dt>Pre-probe authorization</dt>
          <dd className={
            isResearchFunnelProbeAuthorized(funnel)
            || funnel.integrity_status === "unmeasured"
            || funnel.authorization_disposition === "unmeasured"
              ? undefined
              : "status-warning"
          }>
            {formatProbeAuthorization(funnel)}
          </dd>
        </div>
        <div>
          <dt>Authority</dt>
          <dd>{funnel.authorization_trusted ? "Trusted" : "Not authoritative"}</dd>
        </div>
      </dl>
      {funnel.topic_memory.ledger_sha256
      || funnel.topic_memory.audit_artifact_ref
      || funnel.topic_memory.update_artifact_ref ? (
        <div className="research-funnel-memory" aria-label="Topic memory provenance">
          <span className="stat-label">Topic memory provenance</span>
          {funnel.topic_memory.ledger_sha256 ? (
            <span>Ledger <code>{funnel.topic_memory.ledger_sha256}</code></span>
          ) : null}
          {funnel.topic_memory.audit_artifact_ref ? (
            <span>Audit <code>{funnel.topic_memory.audit_artifact_ref.path}</code></span>
          ) : null}
          {funnel.topic_memory.update_artifact_ref ? (
            <span>Update <code>{funnel.topic_memory.update_artifact_ref.path}</code></span>
          ) : null}
        </div>
      ) : null}
      {funnel.candidate_prior_search.plan_sha256
      || funnel.candidate_prior_search.receipt_sha256
      || funnel.candidate_prior_search.artifact_refs.length > 0 ? (
        <div className="research-funnel-memory" aria-label="Candidate direct-prior provenance">
          <span className="stat-label">Candidate direct-prior provenance</span>
          {funnel.candidate_prior_search.plan_sha256 ? (
            <span>Plan <code>{funnel.candidate_prior_search.plan_sha256}</code></span>
          ) : null}
          {funnel.candidate_prior_search.receipt_sha256 ? (
            <span>Receipt <code>{funnel.candidate_prior_search.receipt_sha256}</code></span>
          ) : null}
          {funnel.candidate_prior_search.artifact_refs.map((ref) => (
            <span key={ref.path}>{ref.label} <code>{ref.path}</code></span>
          ))}
        </div>
      ) : null}
      <div className="research-funnel-context" aria-label="Topic probe persisted lifecycle">
        {activeProbe ? (
          <div className="research-funnel-scope">
            <span className="stat-label">Research chain hashes</span>
            <p>
              Gap <code>{funnel.hashes.gap_map || "unmeasured"}</code>
              {" · Portfolio "}<code>{funnel.hashes.topic_portfolio || "unmeasured"}</code>
              {" · Decision "}<code>{funnel.hashes.topic_decision || "unmeasured"}</code>
              {" · Active "}<code>{activeProbe.contractHash}</code>
            </p>
          </div>
        ) : null}
        <div className="research-funnel-scope">
          <span className="stat-label">Estimator contract</span>
          <p>
            <code>{funnel.estimator_feasibility.estimand_type || "unmeasured"}</code>
            {" · "}
            <code>{funnel.estimator_feasibility.estimator_family || "unmeasured"}</code>
            {` · clusters=${funnel.estimator_feasibility.independent_cluster_count ?? "unmeasured"}`}
            {` · denominator=${funnel.estimator_feasibility.primary_denominator ?? "unmeasured"}`}
          </p>
        </div>
        <div className="research-funnel-scope">
          <span className="stat-label">Estimator artifacts</span>
          <p>
            {funnel.estimator_feasibility.artifact_refs.length > 0
              ? funnel.estimator_feasibility.artifact_refs.map((ref) => ref.path).join(" · ")
              : "Unmeasured"}
          </p>
        </div>
        <div className="research-funnel-scope">
          <span className="stat-label">Outcome gate</span>
          <p>
            <code>{funnel.outcome_gate.status}</code>
            {` · ${funnel.outcome_gate.trusted ? "trusted" : "not trusted"}`}
            {funnel.outcome_gate.artifact_ref ? <> · <code>{funnel.outcome_gate.artifact_ref.path}</code></> : null}
          </p>
        </div>
        <div className="research-funnel-scope">
          <span className="stat-label">Follow-up handoff</span>
          <p>
            <code>{funnel.followup_handoff.status}</code>
            {` · ${funnel.followup_handoff.trusted ? "trusted" : "not trusted"}`}
            {funnel.followup_handoff.recommended_followup_mode ? <> · <code>{funnel.followup_handoff.recommended_followup_mode}</code></> : null}
            {funnel.followup_handoff.evidence_stage ? <> · <code>{funnel.followup_handoff.evidence_stage}</code></> : null}
            {funnel.followup_handoff.artifact_ref ? <> · <code>{funnel.followup_handoff.artifact_ref.path}</code></> : null}
          </p>
        </div>
        <div className="research-funnel-scope">
          <span className="stat-label">Topic-probe review gate</span>
          <p>
            <code>{funnel.review_gate.status}</code>
            {` · ${funnel.review_gate.trusted ? "trusted" : "not trusted"}`}
            {` · paper_drafting_allowed=${String(funnel.review_gate.paper_drafting_allowed)}`}
            {funnel.review_gate.artifact_ref ? <> · <code>{funnel.review_gate.artifact_ref.path}</code></> : null}
          </p>
        </div>
      </div>
      <div className="research-funnel-context">
        <div className="research-funnel-scope">
          <span className="stat-label">Run scope</span>
          <p>{runScope}</p>
        </div>
        {funnel.probe_candidate_statements.length > 0 ? (
          <div className="research-funnel-topics">
            <span className="stat-label">Bounded probe candidates</span>
            <ul>
              {funnel.probe_candidate_statements.map((statement, index) => (
                <li key={`${funnel.probe_candidate_ids[index] || "topic"}:${index}`}>{statement}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {portfolioCandidates.length > 0 ? (
        <ResearchTopicPortfolio candidates={portfolioCandidates} />
      ) : null}
      {activeProbe ? (
        <div className="research-funnel-active-probe" role="region" aria-label="Verified active bounded probe">
          <div className="research-funnel-active-heading">
            <span className="stat-label">Active bounded probe</span>
            <span className="research-funnel-evidence-boundary">Bounded probe only; not paper evidence</span>
          </div>
          <dl className="research-funnel-active-details">
            <div>
              <dt>Candidate ID</dt>
              <dd><code>{activeProbe.candidateId}</code></dd>
            </div>
            <div>
              <dt>Candidate SHA-256</dt>
              <dd><code>{activeProbe.candidateHash}</code></dd>
            </div>
            <div>
              <dt>Metric / unit / scale / direction</dt>
              <dd><code>{activeProbe.primaryMetric}</code> · <code>{activeProbe.metricUnit}</code> · <code>{activeProbe.metricScale}</code> · <code>{activeProbe.metricDirection}</code></dd>
            </div>
            <div>
              <dt>Effect criterion</dt>
              <dd><code>{formatEffectCriterion(activeProbe.effectCriterion, activeProbe.metricDirection)}</code></dd>
            </div>
            {activeProbe.meaningfulEffect ? (
              <div>
                <dt>Effect note</dt>
                <dd>{activeProbe.meaningfulEffect}</dd>
              </div>
            ) : null}
            <div>
              <dt>Objective binding</dt>
              <dd><code>{activeProbe.objectiveRaw}</code></dd>
            </div>
            <div>
              <dt>Deferred candidates</dt>
              <dd>{activeProbe.deferredCandidateIds.length > 0
                ? activeProbe.deferredCandidateIds.map((candidateId) => <code key={candidateId}>{candidateId}</code>)
                : "None"}</dd>
            </div>
            <div>
              <dt>Evidence stage</dt>
              <dd><code>{activeProbe.evidenceStage}</code></dd>
            </div>
            <div>
              <dt>Contract artifact</dt>
              <dd><code>{activeProbe.contractArtifactPath}</code></dd>
            </div>
            <div className="research-funnel-contract-hash">
              <dt>Contract SHA-256</dt>
              <dd><code>{activeProbe.contractHash}</code></dd>
            </div>
          </dl>
        </div>
      ) : null}
      {funnel.literature_queries.length > 0 ? (
        <div className="research-funnel-reasons">
          <span className="stat-label">Literature query provenance</span>
          <ul>
            {funnel.literature_queries.map((query, index) => (
              <li key={`${query.query}:${index}`}>
                <code>{query.source}</code> · {query.source_reason} · {query.fallback ? "fallback" : "planned"} · retrieved {query.fetched ?? "unmeasured"} · relevant {query.relevant_fetched ?? "unmeasured"} · selected {query.selected ?? "unmeasured"}
                <p>{query.query}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {blockedGates.length > 0 ? (
        <div className="research-funnel-reasons">
          <span className="stat-label">Blocking gates</span>
          <ul>
            {blockedGates.map((gate, index) => (
              <li key={`${gate.scope}:${gate.code}:${index}`}>
                <code>{gate.code}</code> · {gate.scope} · {gate.trusted ? "trusted" : "diagnostic only"}
                <p>{gate.message}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {reviewerDissent.length > 0 ? (
        <div className="research-funnel-reasons">
          <span className="stat-label">Reviewer dissent</span>
          <ul>
            {reviewerDissent.map((finding, index) => (
              <li key={`${finding.source}:${finding.candidate_id}:${finding.reviewer_id || index}`}>
                <code>{finding.reviewer_label || finding.reviewer_id || finding.source}</code> · <code>{finding.candidate_id}</code> · {finding.hard_block ? "hard block" : "objection"} · {finding.trusted ? "trusted" : "diagnostic only"}
                <p>{finding.summary}</p>
                {finding.findings.map((detail) => <p key={detail}>{detail}</p>)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {funnel.invalid_chain_blockers.length > 0 ? (
        <div className="research-funnel-reasons" role="alert">
          <span className="stat-label">Invalid-chain blockers</span>
          <div className="research-funnel-reason-list">
            {funnel.invalid_chain_blockers.map((blocker, index) => (
              <code className="research-funnel-reason" key={`${blocker}:${index}`}>{blocker}</code>
            ))}
          </div>
        </div>
      ) : null}
      {visibleReasonCodes.length > 0 ? (
        <div className="research-funnel-reasons">
          <span className="stat-label">Reason codes</span>
          <div className="research-funnel-reason-list">
            {visibleReasonCodes.map((reasonCode, index) => (
              <code className="research-funnel-reason" key={`${reasonCode}:${index}`}>{reasonCode}</code>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ResearchTopicPortfolio({
  candidates
}: {
  candidates: NonNullable<RunJobProjection["research_funnel"]>["portfolio_candidates"];
}) {
  return (
    <div className="research-funnel-candidates" aria-label="Topic candidate audit portfolio">
      <div className="research-funnel-candidates-heading">
        <span className="stat-label">Candidate audit portfolio</span>
        <span>{candidates.length} bounded candidates</span>
      </div>
      <ol>
        {candidates.map((candidate) => {
          const priorDispositions = candidate.prior_absorption_comparisons
            .map((comparison) => `${comparison.prior_paper_id}: ${formatStatusLabel(comparison.disposition)}`);
          return (
            <li key={candidate.candidate_id}>
              <div className="research-funnel-candidate-heading">
                <div>
                  <span className="stat-label">Candidate {candidate.rank}</span>
                  <code>{candidate.candidate_id}</code>
                </div>
                <div className="research-funnel-candidate-status">
                  <span className="chip">{formatStatusLabel(candidate.review_status)}</span>
                  <span className="chip">{formatStatusLabel(candidate.probe_status)}</span>
                  <span className="chip">{candidate.trusted ? "Trusted" : "Diagnostic only"}</span>
                </div>
              </div>
              <p className="research-funnel-candidate-statement">{candidate.statement}</p>
              <dl className="research-funnel-candidate-facts">
                <div>
                  <dt>Scorecard</dt>
                  <dd>
                    N {candidate.scores.novelty} · F {candidate.scores.feasibility} · T {candidate.scores.testability} · C {candidate.scores.cost} · G {candidate.scores.expected_gain}
                  </dd>
                </div>
                <div>
                  <dt>Probe state</dt>
                  <dd>{candidate.probe_eligible ? "Eligible" : "Blocked"}</dd>
                </div>
                <div>
                  <dt>Comparator</dt>
                  <dd>{candidate.comparator || "Unmeasured"}</dd>
                </div>
                <div>
                  <dt>Task / metric</dt>
                  <dd>{candidate.dataset_task_bench || "Unmeasured"} · {candidate.primary_metric || "Unmeasured"}</dd>
                </div>
                <div>
                  <dt>Closest-prior evidence</dt>
                  <dd>{candidate.closest_prior_full_text_paper_ids.length}/{candidate.closest_prior_paper_ids.length} full text</dd>
                </div>
                <div>
                  <dt>Topic memory</dt>
                  <dd>
                    {candidate.topic_memory_disposition
                      ? formatStatusLabel(candidate.topic_memory_disposition)
                      : "Unmeasured"}
                    {candidate.topic_memory_maximum_lineage_similarity !== undefined
                      ? ` · similarity ${candidate.topic_memory_maximum_lineage_similarity.toFixed(3)}`
                      : ""}
                  </dd>
                </div>
              </dl>
              <div className="research-funnel-candidate-evidence">
                <p><strong>Prior absorption</strong> {priorDispositions.join(" · ") || "Unmeasured"}</p>
                {candidate.reviewer_absorption_objection ? (
                  <p><strong>Reviewer objection</strong> {candidate.reviewer_absorption_objection}</p>
                ) : null}
                {candidate.closest_prior_non_overlap ? (
                  <p><strong>Defended non-overlap</strong> {candidate.closest_prior_non_overlap}</p>
                ) : null}
                {candidate.kill_signal ? (
                  <p><strong>Kill signal</strong> {candidate.kill_signal}</p>
                ) : null}
                {candidate.minimum_publishable_evidence ? (
                  <p><strong>Minimum evidence</strong> {candidate.minimum_publishable_evidence}</p>
                ) : null}
                {candidate.contribution_claim ? (
                  <p><strong>Contribution ceiling</strong> {candidate.contribution_claim}</p>
                ) : null}
                {candidate.local_budget ? (
                  <p><strong>Local budget</strong> {candidate.local_budget}</p>
                ) : null}
                {candidate.review_summary ? (
                  <p><strong>Review summary</strong> {candidate.review_summary}</p>
                ) : null}
                {candidate.blocked_gate_codes.length > 0 ? (
                  <p><strong>Blocking gates</strong> {candidate.blocked_gate_codes.join(" · ")}</p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function TransitionPanel(props: ResearchWorkbenchProps) {
  const transition = props.selectedRun?.graph.pendingTransition;
  if (!props.selectedRun || !transition) {
    return null;
  }
  const currentStatus = props.selectedRun.graph.nodeStates[props.selectedRun.currentNode]?.status;
  const canApplyTransition = currentStatus !== "needs_approval"
    && transition.autoExecutable
    && transition.action !== "pause_for_human"
    && transition.action !== "delegate_successor";
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
        {canApplyTransition ? (
          <button className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onRunSessionCommand("/agent apply", "Applying transition recommendation")}>
            <span>Apply recommendation</span>
            <code>/agent apply</code>
          </button>
        ) : null}
        {canApplyTransition ? (
          <button className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onRunSessionCommand("/agent overnight", "Starting autonomy preset: overnight")}>
            <span>Start overnight preset</span>
            <code>/agent overnight</code>
          </button>
        ) : null}
      </div>
    </article>
  );
}

function AppliedTransitionNotice({ run }: { run: RunRecord }) {
  const transition = [...(run.graph.transitionHistory || [])]
    .reverse()
    .find((entry) => entry.action.startsWith("backtrack_to_"))
    ?? (run.graph.lastAppliedTransition?.action.startsWith("backtrack_to_")
      ? run.graph.lastAppliedTransition
      : undefined);
  if (!transition) {
    return null;
  }
  return (
    <div className="research-funnel-context" role="status" aria-label="Last applied backtrack">
      <div className="research-funnel-scope">
        <span className="stat-label">Last applied backtrack</span>
        <p>
          <code>{transition.fromNode}</code>
          {" -> "}
          <code>{transition.toNode || "unmeasured"}</code>
          {" · "}
          {transition.reason}
        </p>
      </div>
    </div>
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
            <button key={`${action.label}-${action.command}`} className="button button-secondary button-small insight-action" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onRunSessionCommand(action.command, `${action.label} · ${action.command}`)}>
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

function WorkflowMap(props: ResearchWorkbenchProps & {
  closeRef: RefObject<HTMLButtonElement | null>;
  navRef: RefObject<HTMLElement | null>;
  mobileOpen: boolean;
  compactViewport: boolean;
  onClose: () => void;
}) {
  if (!props.selectedRun) {
    return null;
  }
  const currentIndex = NODE_ORDER.indexOf(props.selectedRun.currentNode);
  return (
    <aside
      ref={props.navRef}
      className={`workflow-map ${props.mobileOpen ? "is-open" : ""}`}
      role={props.compactViewport && props.mobileOpen ? "dialog" : undefined}
      aria-modal={props.compactViewport && props.mobileOpen ? true : undefined}
      aria-labelledby="workflow-heading"
      hidden={props.compactViewport && !props.mobileOpen}
    >
      <div className="workflow-map-header">
        <div>
          <p className="section-kicker">Governed workflow</p>
          <h2 id="workflow-heading">Workflow</h2>
          <span>{props.completedNodeCount} of {NODE_ORDER.length} complete</span>
        </div>
        <button ref={props.closeRef} className="icon-button workflow-close" type="button" aria-label="Close workflow" onClick={props.onClose}>
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <nav id="workflow-navigation" aria-label="Workflow steps">
        <ol className="node-map">
        {NODE_ORDER.map((node, index) => {
          const state = props.selectedRun!.graph.nodeStates[node] ?? {
            status: "pending",
            note: null,
            lastError: null,
            updatedAt: props.selectedRun!.updatedAt
          };
          const current = props.selectedRun!.currentNode === node;
          const canBacktrack = props.isSelectedRunActive && index < currentIndex;
          return (
            <li
              key={node}
              className={`node-tile status-${state.status} ${current ? "current" : ""}`}
              aria-current={current ? "step" : undefined}
            >
              <span className="node-marker" aria-hidden="true">
                {state.status === "completed" ? <CheckCircle size={24} weight="fill" /> : <Circle size={24} weight={current ? "fill" : "regular"} />}
              </span>
              <span className="node-copy">
                <span className="node-order">{index + 1}</span>
                <strong>{formatNodeLabel(node)}</strong>
                <small>{formatStatusLabel(state.status)}</small>
              </span>
              {canBacktrack && !props.isBusy ? (
                <button
                  className="workflow-backtrack"
                  type="button"
                  onClick={() => props.onJumpNode(props.selectedRun!.id, node)}
                  aria-label={`Backtrack to ${formatNodeLabel(node)}`}
                >
                  Backtrack
                </button>
              ) : null}
              <span className="visually-hidden">
                {state.note || state.lastError || "No node note yet."}
              </span>
            </li>
          );
        })}
        </ol>
      </nav>
    </aside>
  );
}

function PendingPlanQueue(props: ResearchWorkbenchProps) {
  const plan = props.session?.pendingPlan;
  if (!plan || !props.isSelectedRunActive) {
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
        <button className="button button-primary" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onTriggerPending("next")}>Run next</button>
        {plan.totalSteps > 1 ? <button className="button button-secondary" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onTriggerPending("all")}>Run all</button> : null}
        <button className="button button-danger" type="button" disabled={props.isBusy || !props.isSelectedRunActive} onClick={() => props.onTriggerPending("cancel")}>Cancel</button>
      </div>
    </section>
  );
}

function HumanInterventionCard(props: ResearchWorkbenchProps) {
  const sessionIntervention = props.session?.humanIntervention;
  const intervention = props.isSelectedRunActive
    && sessionIntervention?.runId === props.selectedRun?.id
    ? sessionIntervention
    : undefined;
  if (!intervention) {
    return null;
  }
  const isActiveTarget = intervention.runId === props.activeRunId && props.isSelectedRunActive;
  return (
    <section className="workbench-card human-intervention-card" aria-label="Human input required">
      <div className="panel-heading">
        <div>
          <p className="section-kicker">Human input required</p>
          <h3>{intervention.title}</h3>
        </div>
        <span className="status-pill is-warning">{formatNodeLabel(intervention.sourceNode)}</span>
      </div>
      <p className="human-intervention-question">{intervention.question}</p>
      {intervention.context.length > 0 ? (
        <ul className="finding-list">
          {intervention.context.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
      {intervention.conversationTurnCount > 0 ? (
        <p className="doctor-harness-meta">Follow-up turn {intervention.conversationTurnCount + 1}</p>
      ) : null}
      {intervention.choices.length > 0 ? (
        <div className="decision-actions" aria-label="Declared recovery choices">
          {intervention.choices.map((choice) => (
            <button
              className="button button-secondary"
              type="button"
              key={choice.id}
              title={choice.description}
              disabled={props.isBusy || !isActiveTarget}
              onClick={() => props.onRunSessionCommand(choice.id, `Answering ${intervention.title}`)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : null}
      <p className="doctor-harness-meta">
        You can also answer naturally in the composer. The interpreter may select only a declared route or ask a follow-up; evidence gates remain unchanged.
      </p>
    </section>
  );
}

function WorkbenchInspector(props: ResearchWorkbenchProps & {
  closeRef: RefObject<HTMLButtonElement | null>;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onClose: () => void;
}) {
  const sessionIntervention = props.session?.humanIntervention;
  const intervention = props.isSelectedRunActive
    && sessionIntervention?.runId === props.selectedRun?.id
    ? sessionIntervention
    : undefined;
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number): void {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % DETAIL_TABS.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + DETAIL_TABS.length) % DETAIL_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = DETAIL_TABS.length - 1;
    }
    if (nextIndex === undefined) {
      return;
    }
    event.preventDefault();
    props.onSetActiveTab(DETAIL_TABS[nextIndex]!.id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <aside className="workbench-inspector">
      <div className="inspector-header">
        <div>
          <p className="section-kicker">Inspector</p>
          <h2 ref={props.headingRef} id="details-sheet-heading" tabIndex={-1}>{props.activeTabLabel}</h2>
        </div>
        <button ref={props.closeRef} className="icon-button" type="button" aria-label="Close run details" onClick={props.onClose}>
          <X aria-hidden="true" size={20} />
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Inspector views" aria-orientation="horizontal">
        {DETAIL_TABS.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            id={`inspector-tab-${tab.id}`}
            className={`tab-button ${props.activeTab === tab.id ? "active" : ""}`}
            type="button"
            role="tab"
            aria-selected={props.activeTab === tab.id}
            aria-controls={`inspector-panel-${tab.id}`}
            tabIndex={props.activeTab === tab.id ? 0 : -1}
            onClick={() => props.onSetActiveTab(tab.id)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {DETAIL_TABS.map((tab) => (
          <div
            key={tab.id}
            id={`inspector-panel-${tab.id}`}
            className="inspector-tab-panel"
            role="tabpanel"
            aria-labelledby={`inspector-tab-${tab.id}`}
            tabIndex={0}
            hidden={props.activeTab !== tab.id}
          >
            {props.activeTab === tab.id ? renderInspectorTabContent(tab.id, props) : null}
          </div>
        ))}
      </div>
      {props.activeTab === "logs" ? (
        <form className="command-console" onSubmit={props.onSubmitComposer}>
          <div className="panel-heading">
            <div>
              <p className="section-kicker">{!props.isSelectedRunActive ? "Inspection only" : intervention ? "Operator answer" : "Command input"}</p>
              <h3>{!props.isSelectedRunActive ? "Activate this run to send commands" : intervention ? intervention.title : "Logs and input together"}</h3>
            </div>
            <span className={`status-pill ${props.isSelectedRunActive && props.isBusy ? "is-active" : "is-neutral"}`}>
              {!props.isSelectedRunActive ? "Inactive" : props.isBusy ? props.activeBusyLabel || "Working..." : "Idle"}
            </span>
          </div>
          <label className="field-label">
            {intervention ? "Answer" : "Prompt"}
            <textarea
              value={props.commandInput}
              onChange={(event) => props.onSetCommandInput(event.target.value)}
              placeholder={intervention?.question || "collect papers using the run's declared literature scope"}
              rows={3}
              disabled={props.isBusy || !props.isSelectedRunActive}
            />
          </label>
          <div className="composer-actions">
            <button className="button button-primary" type="submit" disabled={props.isBusy || !props.isSelectedRunActive}>{props.isBusy ? "Running..." : intervention ? "Submit answer" : "Send"}</button>
            {props.session?.canCancel && props.isSelectedRunActive ? <button className="button button-danger" type="button" onClick={props.onCancelActive}>Cancel active task</button> : null}
          </div>
        </form>
      ) : null}
    </aside>
  );
}

function renderInspectorTabContent(tab: TabId, props: ResearchWorkbenchProps): ReactNode {
  switch (tab) {
    case "overview":
      return <EvidenceBoard {...props} />;
    case "logs":
      return <LogsPane {...props} />;
    case "artifacts":
      return <ArtifactsPane {...props} />;
    case "checkpoints":
      return <CheckpointsPane {...props} />;
    case "knowledge":
      return <KnowledgePane {...props} />;
    case "meta":
      return <MetaPane {...props} />;
    case "workspace":
      return (
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
      );
    case "doctor":
      return <DoctorPane {...props} />;
  }
}

function LogsPane(props: ResearchWorkbenchProps) {
  if (!props.isSelectedRunActive) {
    return (
      <div className="inline-empty">
        Live logs belong to the active command target. Activate this run to inspect its runtime output, or use Live activity for workspace-wide status.
      </div>
    );
  }
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
    return <ReviewPacketPreviewPane packet={props.selectedReviewPacket} isBusy={props.isBusy || !props.isSelectedRunActive} onRunSessionCommand={props.onRunSessionCommand} />;
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
  const canRunLiveProviderCheck = isCodexProviderMode(props.bootstrap.configSummary?.llmMode);
  return (
    <div className="doctor-list">
      {canRunLiveProviderCheck ? (
        <section className="sub-panel" aria-labelledby="live-provider-check-heading">
          <p className="section-kicker">Opt-in network check</p>
          <h3 id="live-provider-check-heading">Live Codex chat compatibility</h3>
          <p>
            Sends one fixed non-user prompt to the configured Codex chat model and may use provider quota.
            The provider output is not stored.
          </p>
          <div className="decision-actions">
            <button
              className="button button-secondary button-small"
              type="button"
              disabled={props.isBusy}
              onClick={props.onRunLiveProviderCheck}
            >
              {props.isBusy ? "Live check unavailable while busy" : "Run live Codex chat check"}
            </button>
          </div>
        </section>
      ) : null}
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
  const [ollamaDiscovery, setOllamaDiscovery] = useState<OllamaDiscoveryState>({
    status: "idle",
    models: []
  });

  async function refreshOllamaModels(signal?: AbortSignal) {
    const baseUrl = props.form.ollamaBaseUrl.trim();
    if (!baseUrl) {
      setOllamaDiscovery({
        status: "unreachable",
        models: [],
        error: "Ollama base URL is required."
      });
      return;
    }

    setOllamaDiscovery({ status: "loading", models: [] });
    try {
      const discovered = await api<OllamaDiscoveryResponse>(
        "/api/ollama/models?baseUrl=" + encodeURIComponent(baseUrl),
        { signal }
      );
      if (signal?.aborted) return;
      const models = Array.from(
        new Set(discovered.models.map((model) => model.trim()).filter(Boolean))
      ).sort((left, right) => left.localeCompare(right));
      if (!discovered.reachable) {
        setOllamaDiscovery({
          status: "unreachable",
          models: [],
          error: discovered.error || "Ollama server is unreachable."
        });
        return;
      }
      setOllamaDiscovery({
        status: models.length > 0 ? "ready" : "empty",
        models
      });
    } catch (error) {
      if (signal?.aborted) return;
      setOllamaDiscovery({
        status: "unreachable",
        models: [],
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  useEffect(() => {
    if (!isOllamaMode) {
      setOllamaDiscovery({ status: "idle", models: [] });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void refreshOllamaModels(controller.signal);
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [isOllamaMode, props.form.ollamaBaseUrl]);

  const ollamaChatModels = buildOllamaModelChoices(
    [...props.options.ollamaChatModels, ...ollamaDiscovery.models],
    props.form.ollamaChatModel
  );
  const ollamaResearchModels = buildOllamaModelChoices(
    [...props.options.ollamaResearchModels, ...ollamaDiscovery.models],
    props.form.ollamaResearchModel
  );
  const ollamaExperimentModels = buildOllamaModelChoices(
    [...props.options.ollamaExperimentModels, ...ollamaDiscovery.models],
    props.form.ollamaExperimentModel
  );
  const ollamaVisionModels = buildOllamaModelChoices(
    [...props.options.ollamaVisionModels, ...ollamaDiscovery.models],
    props.form.ollamaVisionModel
  );

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
        Pick each provider's chat, research, and experiment slots independently. Provider-specific PDF controls are
        shown when a separate vision model is required.
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
              required
              value={props.form.ollamaBaseUrl}
              onChange={(event) => patchSetupForm(props.onChange, { ollamaBaseUrl: event.target.value })}
            />
          </label>
          <div className="form-actions">
            <button
              className="button button-secondary"
              type="button"
              disabled={props.disabled || ollamaDiscovery.status === "loading"}
              onClick={() => void refreshOllamaModels()}
            >
              {ollamaDiscovery.status === "loading" ? "Checking Ollama..." : "Refresh installed models"}
            </button>
          </div>
          {ollamaDiscovery.status === "ready" ? (
            <p className="form-help" role="status" aria-live="polite">
              {ollamaDiscovery.models.length} installed model(s) discovered.
            </p>
          ) : null}
          {ollamaDiscovery.status === "empty" ? (
            <div className="operator-error" role="status" aria-live="polite">
              Ollama is reachable, but no installed models were found. Install a model or enter installed model identifiers before saving.
            </div>
          ) : null}
          {ollamaDiscovery.status === "unreachable" ? (
            <div className="operator-error" role="status" aria-live="polite">
              Ollama is unreachable: {ollamaDiscovery.error || "Connection failed."} Update the base URL or enter installed model identifiers before saving.
            </div>
          ) : null}
          <ConfigModelSection
            title="Ollama chat"
            description="Local model for interactive turns and lightweight assistance."
            disabled={props.disabled}
            required
            allowCustomModel
            modelListId="ollama-chat-models"
            modelValue={props.form.ollamaChatModel}
            modelOptions={ollamaChatModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaChatModel: value })}
          />
          <ConfigModelSection
            title="Ollama research backend"
            description="Local model for research analysis and planning tasks."
            disabled={props.disabled}
            required
            allowCustomModel
            modelListId="ollama-research-models"
            modelValue={props.form.ollamaResearchModel}
            modelOptions={ollamaResearchModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaResearchModel: value })}
          />
          <ConfigModelSection
            title="Ollama experiment"
            description="Local model for experiment implementation and code-oriented execution work."
            disabled={props.disabled}
            required
            allowCustomModel
            modelListId="ollama-experiment-models"
            modelValue={props.form.ollamaExperimentModel}
            modelOptions={ollamaExperimentModels}
            onModelChange={(value) => patchSetupForm(props.onChange, { ollamaExperimentModel: value })}
          />
          <ConfigModelSection
            title="Ollama vision"
            description="Local vision/PDF model for page-image analysis."
            disabled={props.disabled}
            required
            allowCustomModel
            modelListId="ollama-vision-models"
            modelValue={props.form.ollamaVisionModel}
            modelOptions={ollamaVisionModels}
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
  allowCustomModel?: boolean;
  modelListId?: string;
  required?: boolean;
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
          {props.allowCustomModel ? (
            <>
              <input
                disabled={props.disabled}
                required={props.required}
                list={props.modelListId}
                value={props.modelValue}
                onChange={(event) => props.onModelChange(event.target.value)}
                placeholder="Enter or select an installed model identifier"
              />
              <datalist id={props.modelListId}>
                {props.modelOptions.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </>
          ) : (
            <select
              disabled={props.disabled}
              required={props.required}
              value={props.modelValue}
              onChange={(event) => props.onModelChange(event.target.value)}
            >
              {props.modelOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          )}
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
    codexChatModelChoice: "gpt-5.6-terra",
    codexChatReasoningEffort: "medium",
    codexResearchBackendModelChoice: "gpt-5.6-sol",
    codexResearchBackendReasoningEffort: "high",
    codexExperimentModelChoice: "gpt-5.6-sol",
    codexExperimentReasoningEffort: "high",
    openAiChatModel: "gpt-5.6-terra",
    openAiChatReasoningEffort: "medium",
    openAiResearchBackendModel: "gpt-5.6-sol",
    openAiResearchBackendReasoningEffort: "high",
    openAiExperimentModel: "gpt-5.6-sol",
    openAiExperimentReasoningEffort: "high",
    ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
    ollamaChatModel: "",
    ollamaResearchModel: "",
    ollamaExperimentModel: "",
    ollamaVisionModel: "",
    networkPolicy: "blocked",
    networkPurpose: ""
  };
}

function createDefaultConfigOptions(): WebConfigOptions {
  return {
    codexModels: [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4 (fast)",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ],
    codexReasoningByModel: {
      "gpt-5.6-sol": ["low", "medium", "high", "xhigh"],
      "gpt-5.6-terra": ["low", "medium", "high", "xhigh"],
      "gpt-5.6-luna": ["low", "medium", "high", "xhigh"],
      "gpt-5.5": ["low", "medium", "high", "xhigh"],
      "gpt-5.4": ["low", "medium", "high", "xhigh"],
      "gpt-5.4 (fast)": ["low", "medium", "high", "xhigh"],
      "gpt-5.4-mini": ["low", "medium", "high"],
      "gpt-5.3-codex-spark": ["low", "medium", "high"],
    },
    openAiModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5", "gpt-5-mini", "gpt-4.1", "gpt-4o", "gpt-4o-mini"],
    openAiReasoningByModel: {
      "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
      "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
      "gpt-5.5": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-5.4": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-5": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-5-mini": ["minimal", "low", "medium", "high", "xhigh"],
      "gpt-4.1": ["medium"],
      "gpt-4o": ["medium"],
      "gpt-4o-mini": ["medium"]
    },
    ollamaChatModels: [],
    ollamaResearchModels: [],
    ollamaExperimentModels: [],
    ollamaVisionModels: []
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

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Request failed: ${response.status}`);
  }
  return response.text();
}

function toRunRelativeArtifactPath(runId: string, referencePath: string): string {
  const normalized = referencePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const prefix = `.autolabos/runs/${runId}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function requiresCommandConfirmation(text: string): boolean {
  const normalized = text.trim();
  return /^\/(?:approve|retry)\b/iu.test(normalized)
    || /^\/agent\s+(?:apply|jump|retry|overnight|autonomous)\b/iu.test(normalized);
}

function formatGovernedActionConfirmation(input: GovernedActionConfirmation & {
  runId: string;
  runTitle?: string;
}): string {
  const lines = [
    "Run this governed action?",
    "",
    `Action: ${input.action}`,
    `Run: ${input.runTitle || "Untitled run"}`,
    `Run ID: ${input.runId}`
  ];
  if (input.node) {
    lines.push(`Node: ${formatNodeLabel(input.node)}`);
  }
  return lines.join("\n");
}

function formatSyncState(state: SyncState): string {
  switch (state) {
    case "connecting":
      return "Connecting";
    case "live":
      return "Live stream";
    case "polling":
      return "Polling";
    case "degraded":
      return "Needs attention";
  }
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
  if (value === "openai_api") {
    return "Provider: OpenAI API";
  }
  if (value === "ollama") {
    return "Provider: Ollama";
  }
  return "Provider: Codex ChatGPT";
}

function isCodexProviderMode(value: string | undefined): boolean {
  return value === "codex" || value === "codex_chatgpt_only";
}

function labelPdfMode(value: ConfigSummary["pdfMode"] | undefined): string {
  if (value === "responses_api_pdf") {
    return "PDF: Responses API PDF";
  }
  if (value === "ollama_vision") {
    return "PDF: Ollama vision";
  }
  return "PDF: Codex text + image hybrid";
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

function formatEvidenceReadiness(
  input: NonNullable<RunJobProjection["evidence_readiness"]>
): string {
  if (input.status === "unmeasured") {
    return "Unmeasured";
  }
  if (input.status === "invalid") {
    return "Invalid artifact";
  }
  if (input.status === "missing") {
    return "Comparison missing";
  }
  return input.evidence_ready && input.trusted
    ? "Comparison ready"
    : "Available, not authoritative";
}

function formatEvidenceAdequacy(
  input: NonNullable<RunJobProjection["evidence_adequacy"]>
): string {
  switch (input.status) {
    case "unmeasured":
      return "Unmeasured";
    case "awaiting_execution":
      return "Awaiting execution";
    case "missing_contract":
      return "Contract missing";
    case "missing_receipt":
      return "Receipt missing";
    case "pass":
      return "Pass";
    case "fail":
      return "Fail";
    case "unknown":
      return "Unknown";
    case "invalid":
      return "Invalid";
  }
}

function shouldShowEvidenceAdequacyReasons(
  input: RunJobProjection["evidence_adequacy"]
): input is NonNullable<RunJobProjection["evidence_adequacy"]> {
  return Boolean(
    input
    && input.reason_codes.length > 0
    && input.status !== "unmeasured"
    && input.status !== "awaiting_execution"
    && input.status !== "pass"
  );
}

function formatEvidenceAdequacyReasons(
  input: NonNullable<RunJobProjection["evidence_adequacy"]>
): string {
  const visible = input.reason_codes.slice(0, 3).map((code) => {
    const words = code.replace(/^evidence_adequacy_/, "").replaceAll("_", " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  });
  const remaining = input.reason_codes.length - visible.length;
  return `${visible.join(", ")}${remaining > 0 ? ` (+${remaining})` : ""}`;
}

function formatEvidenceAdequacyArtifactKind(
  kind: NonNullable<RunJobProjection["evidence_adequacy"]>["artifact_refs"][number]["kind"]
): string {
  switch (kind) {
    case "contract":
      return "Contract";
    case "receipt":
      return "Receipt";
    case "assessment":
      return "Assessment";
    case "review_reassessment":
      return "Review reassessment";
  }
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
    <div className="live-watch-scroll" role="region" aria-labelledby="live-watch-heading" tabIndex={0}>
      <table className="live-watch-table">
        <caption className="visually-hidden">Live watch jobs</caption>
        <thead>
          <tr>
            <th scope="col">Run</th>
            <th scope="col">Current node</th>
            <th scope="col">Node status</th>
            <th scope="col">Queue</th>
            <th scope="col">Elapsed</th>
            <th scope="col">Recommended action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ bucket, job }) => {
            const toneClass = bucket === "stalled" || job.status === "needs_approval" ? "is-warning" : undefined;
            const recommendation = job.recommendation_line || job.recommended_action || "No recommendation";
            return (
              <tr
                key={`live-watch:${bucket}:${job.run_id}:${job.node}:${job.source || "run"}`}
                className={toneClass}
              >
                <th scope="row"><code>{job.run_id}</code></th>
                <td>{job.source === "collect_background_job" ? `${formatNodeLabel(job.node as NodeId)} [bg]` : formatNodeLabel(job.node as NodeId)}</td>
                <td>{formatStatusLabel(job.status)}</td>
                <td>{formatStatusLabel(bucket)}</td>
                <td>{formatElapsedSeconds(job.elapsed_seconds)}</td>
                <td>{recommendation}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
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

function formatReviewAssuranceStatus(
  status: NonNullable<RunJobProjection["review_assurance"]>["status"]
): string {
  switch (status) {
    case "not_started":
      return "Not started";
    case "missing":
      return "Missing";
    case "valid":
      return "Verified";
    case "invalid":
      return "Invalid";
  }
}

function formatReviewAssuranceSummary(
  assurance: NonNullable<RunJobProjection["review_assurance"]>
): string {
  if (assurance.status === "not_started") {
    return "Review has not started.";
  }
  if (assurance.status === "missing") {
    return "Review artifacts are missing · Paper blocked";
  }
  return `Paper ${assurance.paper_ready_eligible ? "eligible" : "blocked"}`
    + ` · Manifest ${assurance.input_manifest_valid ? "valid" : "invalid"}`
    + ` · Gate ${assurance.gate_report_valid ? "valid" : "invalid"}`
    + ` · Handoff ${assurance.handoff_valid ? "valid" : "invalid"}`;
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

function normalizeResearchGapEvidenceAudit(
  audit: NonNullable<RunJobProjection["research_funnel"]>["gap_evidence_audit"]
): NonNullable<NonNullable<RunJobProjection["research_funnel"]>["gap_evidence_audit"]> {
  return audit ?? {
    status: "unmeasured",
    total_evidence_count: 0,
    scientific_evidence_count: 0,
    grounded_scientific_evidence_count: 0,
    synthesis_eligible_evidence_count: 0,
    synthesis_excluded_evidence_count: 0,
    accepted_cluster_count: 0,
    malformed_evidence_row_count: 0,
    source_scope_counts: {
      abstract: 0,
      full_text_excerpt: 0,
      full_document: 0,
      unknown: 0
    },
    grounding_status_counts: {
      grounded_span: 0,
      ungrounded_span: 0,
      fallback: 0,
      unknown: 0
    }
  };
}

type CollectionFailureClassView =
  | "query_quality_failure"
  | "semantic_review_operational_failure"
  | "semantic_review_incomplete";

type CollectionHintView = NonNullable<
  ResearchFunnelProjection["collection_reformulation_hint"]
> & {
  active?: boolean;
  failure_class?: CollectionFailureClassView;
  feedback_applied?: boolean;
  semantic_review_status?: "complete" | "partial" | "operational_failure";
};

function readCollectionHintView(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): CollectionHintView | undefined {
  return funnel.collection_reformulation_hint as CollectionHintView | undefined;
}

function readCollectionFailureClass(
  funnel: NonNullable<RunJobProjection["research_funnel"]>,
  hint = readCollectionHintView(funnel)
): CollectionFailureClassView | undefined {
  if (isCollectionFailureClassView(hint?.failure_class)) {
    return hint.failure_class;
  }
  const reasonCode = funnel.reason_codes.find(isCollectionFailureClassView);
  if (reasonCode) {
    return reasonCode;
  }
  const qualityReason = funnel.collection_quality_failure_reasons.join(" ");
  if (/semantic review failed operationally/iu.test(qualityReason)) {
    return "semantic_review_operational_failure";
  }
  if (/semantic review (?:was incomplete|is incomplete)/iu.test(qualityReason)) {
    return "semantic_review_incomplete";
  }
  return hint ? "query_quality_failure" : undefined;
}

function isCollectionFailureClassView(
  value: unknown
): value is CollectionFailureClassView {
  return value === "query_quality_failure"
    || value === "semantic_review_operational_failure"
    || value === "semantic_review_incomplete";
}

function formatCollectionAttempt(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  if (funnel.collection_node_attempt === undefined) {
    return "";
  }
  const attempt = funnel.collection_node_max_attempts === undefined
    ? funnel.collection_node_attempt
    : Math.min(
        funnel.collection_node_attempt,
        funnel.collection_node_max_attempts
      );
  return funnel.collection_node_max_attempts === undefined
    ? ` · attempt ${attempt}`
    : ` · attempt ${attempt}/${funnel.collection_node_max_attempts}`;
}

function collectionStateStatusClass(
  state: NonNullable<RunJobProjection["research_funnel"]>["collection_state"]
): string | undefined {
  if (state === "quality_gate_passed") {
    return "status-success";
  }
  return state === "unmeasured" ? undefined : "status-warning";
}

function formatCollectionFailureSummary(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string | undefined {
  if (
    funnel.collection_state === "unmeasured"
    || funnel.collection_state === "quality_gate_passed"
  ) {
    return undefined;
  }
  if (
    funnel.collection_state === "collecting"
    && funnel.reason_codes.includes("collect_artifact_generation_mismatch")
  ) {
    return "Generation mismatch · collecting the current retry generation";
  }
  const failureClass = readCollectionFailureClass(funnel);
  const reason = funnel.collection_quality_failure_reasons[0]
    ?.replace(/\s+/gu, " ")
    .trim();
  const prefix = failureClass === "semantic_review_operational_failure"
    ? "Reviewer operational failure"
    : failureClass === "semantic_review_incomplete"
      ? "Reviewer incomplete"
      : failureClass === "query_quality_failure"
        ? "Query quality"
        : "Quality gate";
  return reason ? `${prefix} · ${reason}` : prefix;
}

function isActiveQueryReformulationHint(
  funnel: NonNullable<RunJobProjection["research_funnel"]>,
  hint: CollectionHintView
): boolean {
  return hint.active !== false
    && readCollectionFailureClass(funnel, hint) === "query_quality_failure";
}

function formatQueryReformulationSummary(hint: CollectionHintView): string {
  const axis = hint.axes[0]?.axis_terms.join(" ").trim();
  const title = hint.candidate_titles[0]?.replace(/\s+/gu, " ").trim();
  return [axis, title].filter(Boolean).join(" · ") || "Query feedback available";
}

function researchFunnelToneClass(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  const executionAuthorization = readExecutionAuthorization(funnel);
  if (funnel.lifecycle_stage === "invalid_chain") {
    return "is-danger";
  }
  if (executionAuthorization.status === "invalid") {
    return "is-danger";
  }
  if (
    funnel.collection_state === "failed"
    || funnel.collection_state === "quality_gate_exhausted"
  ) {
    return "is-danger";
  }
  if (
    executionAuthorization.status === "blocked"
    || funnel.candidate_prior_search.status === "blocked"
    || funnel.candidate_prior_search.status === "exhausted"
    || funnel.candidate_prior_search.status === "search_required"
    ||
    funnel.collection_state === "collecting"
    || funnel.collection_state === "quality_gate_failed"
    || (
      funnel.collection_state !== "quality_gate_passed"
      && (
        funnel.authorization_disposition === "probe_authorized"
        || funnel.lifecycle_stage !== "discovery"
      )
    )
  ) {
    return "is-warning";
  }
  if (funnel.lifecycle_stage === "reviewed" || funnel.lifecycle_stage === "followup_required") {
    return "is-warning";
  }
  if (funnel.lifecycle_stage === "outcome_decided") {
    return "is-active";
  }
  if (funnel.lifecycle_stage === "probe_authorized") {
    return isResearchFunnelProbeAuthorized(funnel) ? "is-active" : "is-warning";
  }
  if (
    funnel.integrity_status === "partial"
    || funnel.authorization_disposition === "backtrack_to_hypotheses"
  ) {
    return "is-warning";
  }
  return "is-neutral";
}

interface VerifiedActiveTopicProbeView {
  candidateId: string;
  candidateHash: string;
  primaryMetric: string;
  metricUnit: string;
  metricScale: "raw" | "proportion" | "percent" | "percentage_point";
  metricDirection: "maximize" | "minimize";
  effectCriterion: NonNullable<ResearchFunnelProjection["active_effect_criterion"]>;
  objectiveRaw: string;
  meaningfulEffect?: string;
  evidenceStage: "bounded_probe";
  deferredCandidateIds: string[];
  contractArtifactPath: string;
  contractHash: string;
}

function readVerifiedActiveTopicProbe(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): VerifiedActiveTopicProbeView | undefined {
  const contractArtifact = funnel.artifact_refs.find(
    (ref) =>
      ref.path.endsWith("/active_topic_probe_contract.json")
      || ref.path === "active_topic_probe_contract.json"
  );
  const contractHash = funnel.hashes.active_topic_probe_contract;
  if (
    funnel.collection_state !== "quality_gate_passed"
    || funnel.integrity_status !== "complete"
    || !funnel.authorization_trusted
    || funnel.authorization_disposition !== "probe_authorized"
    || !funnel.authorization_probe_allowed
    || !contractArtifact
    || !isSha256(contractHash)
    || !hasDisplayText(funnel.active_candidate_id)
    || !hasDisplayText(funnel.active_topic_id)
    || !isSha256(funnel.active_candidate_hash)
    || !hasDisplayText(funnel.active_primary_metric)
    || !hasDisplayText(funnel.active_metric_unit)
    || !isMetricScale(funnel.active_metric_scale)
    || !isEffectCriterionProjection(funnel.active_effect_criterion)
    || !hasDisplayText(funnel.active_objective_raw)
    || (funnel.active_metric_direction !== "maximize" && funnel.active_metric_direction !== "minimize")
    || funnel.active_evidence_stage !== "bounded_probe"
    || !Array.isArray(funnel.active_deferred_candidate_ids)
  ) {
    return undefined;
  }
  return {
    candidateId: funnel.active_candidate_id,
    candidateHash: funnel.active_candidate_hash,
    primaryMetric: funnel.active_primary_metric,
    metricUnit: funnel.active_metric_unit,
    metricScale: funnel.active_metric_scale,
    metricDirection: funnel.active_metric_direction,
    effectCriterion: { ...funnel.active_effect_criterion },
    objectiveRaw: funnel.active_objective_raw,
    meaningfulEffect: funnel.active_meaningful_effect,
    evidenceStage: funnel.active_evidence_stage,
    deferredCandidateIds: [...funnel.active_deferred_candidate_ids],
    contractArtifactPath: contractArtifact.path,
    contractHash
  };
}

function hasDisplayText(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isSha256(value: string | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isEffectCriterionProjection(
  value: unknown
): value is NonNullable<ResearchFunnelProjection["active_effect_criterion"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const criterion = value as Record<string, unknown>;
  return criterion.basis === "delta_vs_reference"
    && typeof criterion.magnitude === "number"
    && Number.isFinite(criterion.magnitude)
    && criterion.magnitude >= 0
    && (
      criterion.scale === "raw"
      || criterion.scale === "proportion"
      || criterion.scale === "percent"
      || criterion.scale === "percentage_point"
    )
    && typeof criterion.inclusive === "boolean";
}

function formatEffectCriterion(
  criterion: NonNullable<ResearchFunnelProjection["active_effect_criterion"]>,
  direction: "maximize" | "minimize"
): string {
  const comparator = direction === "minimize"
    ? criterion.inclusive ? "<=" : "<"
    : criterion.inclusive ? ">=" : ">";
  const target = direction === "minimize" ? -criterion.magnitude : criterion.magnitude;
  return `${comparator}${target} ${criterion.scale} ${criterion.basis}`;
}

function isMetricScale(
  value: unknown
): value is "raw" | "proportion" | "percent" | "percentage_point" {
  return value === "raw"
    || value === "proportion"
    || value === "percent"
    || value === "percentage_point";
}

function formatResearchFunnelStatus(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  switch (funnel.lifecycle_stage) {
    case "invalid_chain":
      return "Invalid artifact chain";
    case "reviewed":
      return "Reviewed, follow-up required";
    case "followup_required":
      return "Follow-up required";
    case "outcome_decided":
      return "Outcome decided";
    case "probe_authorized": {
      const executionAuthorization = readExecutionAuthorization(funnel);
      if (executionAuthorization.status === "authorized") {
        return "Execution authorized";
      }
      if (executionAuthorization.status === "invalid") {
        return "Execution chain invalid";
      }
      if (executionAuthorization.status === "blocked") {
        return "Execution blocked";
      }
      return isResearchFunnelProbeAuthorized(funnel)
        ? "Execution preflight pending"
        : "Probe blocked";
    }
    case "discovery":
      if (funnel.authorization_disposition === "backtrack_to_hypotheses") {
        return "Backtrack required";
      }
      if (funnel.integrity_status === "partial") {
        return "Discovery in progress";
      }
      return "Discovery";
  }
}

function formatProbeAuthorization(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  if (
    funnel.integrity_status === "unmeasured"
    || funnel.authorization_disposition === "unmeasured"
  ) {
    return "Unmeasured";
  }
  return isResearchFunnelProbeAuthorized(funnel) ? "Authorized" : "Blocked";
}

function isResearchFunnelProbeAuthorized(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): boolean {
  return funnel.collection_state === "quality_gate_passed"
    && funnel.authorization_trusted
    && funnel.integrity_status === "complete"
    && funnel.authorization_disposition === "probe_authorized"
    && funnel.authorization_probe_allowed;
}

function formatResearchFunnelLifecycle(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  const executionAuthorization = readExecutionAuthorization(funnel);
  if (
    funnel.lifecycle_stage === "probe_authorized"
    && executionAuthorization.status === "blocked"
  ) {
    return "Probe selected; execution blocked";
  }
  if (
    funnel.lifecycle_stage === "probe_authorized"
    && executionAuthorization.status === "pending"
  ) {
    return "Probe selected; execution preflight pending";
  }
  if (
    funnel.lifecycle_stage === "probe_authorized"
    && !isResearchFunnelProbeAuthorized(funnel)
  ) {
    return "Probe Blocked";
  }
  return formatStatusLabel(funnel.lifecycle_stage);
}

function readExecutionAuthorization(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): NonNullable<RunJobProjection["research_funnel"]>["execution_authorization"] {
  return funnel.execution_authorization ?? {
    status: "unmeasured",
    trusted: false,
    authorized: false,
    base_funnel_authorized: false,
    candidate_prior_search_authorized: false,
    estimator_authorized: false,
    required_candidate_ids: [],
    covered_candidate_ids: [],
    reason_codes: []
  };
}

function formatResearchFunnelDisposition(
  funnel: NonNullable<RunJobProjection["research_funnel"]>
): string {
  switch (funnel.authorization_disposition) {
    case "probe_authorized":
      return isResearchFunnelProbeAuthorized(funnel)
        ? "Probe authorized"
        : "Probe decision blocked";
    case "backtrack_to_hypotheses":
      return "Backtrack to hypotheses";
    case "unmeasured":
      return "Unmeasured";
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
