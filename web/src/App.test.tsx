import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { ResearchFunnelProjection, RunJobProjection, RunRecord } from "./types";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function expectVisibleText(text: string): void {
  expect(screen.getByText(text)).toBeInTheDocument();
}

describe("App", () => {
  it("renders grouped background jobs from the bootstrap payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/bootstrap")) {
          return new Response(
            JSON.stringify({
              configured: true,
              setupDefaults: {
                projectName: "AutoLabOS",
                defaultTopic: "topic",
                defaultConstraints: ["declared literature scope"],
                defaultObjectiveMetric: "metric"
              },
              session: {
                busy: false,
                logs: [],
                canCancel: false
              },
              runs: [],
              jobs: {
                generated_at: "2026-04-01T12:00:00.000Z",
                runs: [],
                top_failures: []
              },
              jobQueue: {
                running: [
                  {
                    run_id: "run-1",
                    node: "collect_papers",
                    status: "running",
                    started_at: "2026-04-01T11:55:00.000Z",
                    elapsed_seconds: 300,
                    source: "collect_background_job"
                  }
                ],
                waiting: [
                  {
                    run_id: "run-2",
                    node: "review",
                    status: "needs_approval",
                    started_at: "2026-04-01T11:50:00.000Z",
                    elapsed_seconds: 600,
                    source: "run"
                  }
                ],
                stalled: [
                  {
                    run_id: "run-3",
                    node: "run_experiments",
                    status: "running",
                    started_at: "2026-04-01T11:00:00.000Z",
                    elapsed_seconds: 3600,
                    source: "run",
                    recommended_action: "manual review",
                    recommendation_line: "Recommended action: manual review."
                  }
                ]
              }
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/jobs")) {
          return new Response(
            JSON.stringify({
              running: [
                {
                  run_id: "run-1",
                  node: "collect_papers",
                  status: "running",
                  started_at: "2026-04-01T11:55:00.000Z",
                  elapsed_seconds: 300,
                  source: "collect_background_job"
                }
              ],
              waiting: [
                {
                  run_id: "run-2",
                  node: "review",
                  status: "needs_approval",
                  started_at: "2026-04-01T11:50:00.000Z",
                  elapsed_seconds: 600,
                  source: "run"
                }
              ],
              stalled: [
                {
                  run_id: "run-3",
                  node: "run_experiments",
                  status: "running",
                  started_at: "2026-04-01T11:00:00.000Z",
                  elapsed_seconds: 3600,
                  source: "run",
                  recommended_action: "manual review",
                  recommendation_line: "Recommended action: manual review."
                }
              ]
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/exploration/status")) {
          return new Response(
            JSON.stringify({
              enabled: true,
              current_stage: "main_agenda",
              node_counts: {
                explored: 6,
                promoted: 2,
                blocked: 1
              },
              hypothesis_usage: {
                "hypothesis-1": { total: 2, promoted: 1 }
              },
              best_defensible_branch_id: "branch-abc123",
              rollback_reason: null,
              baseline_lock_status: "locked",
              evidence_completeness: 1,
              figure_audit_warnings: 2,
              severe_figure_mismatch: false
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/doctor")) {
          return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
        }
        if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
          return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        }
        if (url.includes("/api/runs/") && url.includes("/literature")) {
          return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
        }
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Background jobs")).toBeInTheDocument();
      expect(screen.getByText("Live watch")).toBeInTheDocument();
      expect(screen.getByText("Exploration engine")).toBeInTheDocument();
      expect(screen.getByText("run_status")).toBeInTheDocument();
      expect(screen.getByText("waiting")).toBeInTheDocument();
      expect(screen.getByText("Running (1)")).toBeInTheDocument();
      expect(screen.getByText("Waiting (1)")).toBeInTheDocument();
      expect(screen.getByText("Stalled (1)")).toBeInTheDocument();
      expect(screen.getByText(/Recommended action: manual review\./i)).toBeInTheDocument();
      expect(screen.getByText(/Current stage:/i)).toBeInTheDocument();
      expect(screen.getByText(/Best defensible:/i)).toBeInTheDocument();
    });

    const liveWatchCard = screen.getByText("Live watch").closest("section");
    const backgroundJobsCard = screen.getByText("Background jobs").closest("section");
    expect(liveWatchCard).not.toBeNull();
    expect(backgroundJobsCard).not.toBeNull();
    expect(within(liveWatchCard as HTMLElement).getByText("run-2")).toBeInTheDocument();
    expect(within(backgroundJobsCard as HTMLElement).getByText("run-2")).toBeInTheDocument();
    expect(within(liveWatchCard as HTMLElement).getByText("run-3")).toBeInTheDocument();
    expect(within(backgroundJobsCard as HTMLElement).getByText("run-3")).toBeInTheDocument();
  });

  it("renders onboarding without a PDF mode prompt when the workspace is not configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/bootstrap")) {
          return new Response(
            JSON.stringify({
              configured: false,
              setupDefaults: {
                projectName: "AutoLabOS",
                defaultTopic: "configured research topic",
                defaultConstraints: ["declared literature scope", "configured time window"],
                defaultObjectiveMetric: "configured evaluation metric"
              },
              session: {
                busy: false,
                logs: [],
                canCancel: false
              },
              runs: []
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
          return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        }
        if (url.includes("/api/runs/") && url.includes("/literature")) {
          return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
        }
        return new Response(JSON.stringify({ configured: false, checks: [] }), { status: 200 });
      })
    );
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Initial setup")).toBeInTheDocument();
      expect(screen.getByText("Initialize workspace")).toBeInTheDocument();
    });

    const codexChatSection = screen.getByText("Codex chat").closest("section");
    expect(codexChatSection).not.toBeNull();
    expect(screen.queryByText("OpenAI chat")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("PDF mode")).not.toBeInTheDocument();
    expect(within(codexChatSection as HTMLElement).getAllByRole("combobox")[0]).toHaveValue("gpt-5.3-codex-spark");
    expect(within(codexChatSection as HTMLElement).getAllByRole("combobox")[1]).toHaveValue("medium");
  });

  it("switches the onboarding form to the selected provider's model sections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/bootstrap")) {
          return new Response(
            JSON.stringify({
              configured: false,
              setupDefaults: {
                projectName: "AutoLabOS",
                defaultTopic: "configured research topic",
                defaultConstraints: ["declared literature scope", "configured time window"],
                defaultObjectiveMetric: "configured evaluation metric"
              },
              session: {
                busy: false,
                logs: [],
                canCancel: false
              },
              runs: []
            }),
            { status: 200 }
          );
        }
        if (url.includes("/api/ollama/models")) {
          return new Response(JSON.stringify({
            baseUrl: "http://127.0.0.1:11434",
            reachable: false,
            models: [],
            error: "connection refused"
          }), { status: 200 });
        }
        if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
          return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        }
        if (url.includes("/api/runs/") && url.includes("/literature")) {
          return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
        }
        return new Response(JSON.stringify({ configured: false, checks: [] }), { status: 200 });
      })
    );
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Initial setup")).toBeInTheDocument();
      expect(screen.getByLabelText("Project name")).toHaveValue("AutoLabOS");
      expect(screen.getByLabelText("Primary provider")).toHaveValue("codex_chatgpt_only");
    });

    fireEvent.change(screen.getByLabelText("Primary provider"), {
      target: { value: "openai_api" }
    });

    await waitFor(() => {
      expectVisibleText("OpenAI chat");
      expectVisibleText("OpenAI research backend");
      expectVisibleText("Research backend model and reasoning for API mode.");
    });

    expect(screen.queryByText("OpenAI PDF")).not.toBeInTheDocument();
    expect(screen.queryByText("Responses PDF")).not.toBeInTheDocument();

    expect(screen.queryByText("Codex chat")).not.toBeInTheDocument();
    expect(screen.queryByText("Codex research backend")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Primary provider"), {
      target: { value: "ollama" }
    });

    await waitFor(() => {
      expectVisibleText("Ollama chat");
      expectVisibleText("Ollama research backend");
      expectVisibleText("Ollama experiment");
      expectVisibleText("Ollama vision");
      expect(screen.getByDisplayValue("http://127.0.0.1:11434")).toBeInTheDocument();
    });

    expect(screen.queryByText("OpenAI chat")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("OpenAI API key")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Ollama is unreachable: connection refused/)).toBeInTheDocument();
    });
    const modelInputs = screen.getAllByPlaceholderText("Enter or select an installed model identifier");
    expect(modelInputs).toHaveLength(4);
    for (const input of modelInputs) {
      expect(input).toHaveValue("");
      expect(input).toBeRequired();
    }
  });

  it("shows Ollama settings and submits Ollama-specific fields", async () => {
    const bootstrapPayload = {
      configured: true,
      setupDefaults: {
        projectName: "AutoLabOS",
        defaultTopic: "configured research topic",
        defaultConstraints: ["declared literature scope", "configured time window"],
        defaultObjectiveMetric: "configured evaluation metric"
      },
      session: {
        busy: false,
        logs: [],
        canCancel: false
      },
      runs: [],
      configSummary: {
        projectName: "AutoLabOS",
        workflowMode: "agent_approval",
        approvalMode: "minimal",
        llmMode: "ollama",
        pdfMode: "ollama_vision",
        researchBackendModel: "local-model-b:latest",
        chatModel: "local-model-a:latest",
        experimentModel: "local-model-c:latest",
        researchBackendReasoning: undefined,
        chatReasoning: undefined,
        experimentReasoning: undefined
      },
      configForm: {
        projectName: "AutoLabOS",
        defaultTopic: "configured research topic",
        defaultConstraints: "declared literature scope, configured time window",
        defaultObjectiveMetric: "configured evaluation metric",
        llmMode: "ollama",
        codexChatModelChoice: "gpt-5.3-codex",
        codexChatReasoningEffort: "low",
        codexResearchBackendModelChoice: "gpt-5.4",
        codexResearchBackendReasoningEffort: "xhigh",
        codexExperimentModelChoice: "gpt-5.4",
        codexExperimentReasoningEffort: "xhigh",
        openAiChatModel: "gpt-5.4",
        openAiChatReasoningEffort: "low",
        openAiResearchBackendModel: "gpt-5.4",
        openAiResearchBackendReasoningEffort: "medium",
        openAiExperimentModel: "gpt-5.4",
        openAiExperimentReasoningEffort: "medium",
        ollamaBaseUrl: "http://127.0.0.1:11434",
        ollamaChatModel: "local-model-a:latest",
        ollamaResearchModel: "local-model-b:latest",
        ollamaExperimentModel: "local-model-c:latest",
        ollamaVisionModel: "local-model-b:latest",
        networkPolicy: "blocked",
        networkPurpose: ""
      }
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(bootstrapPayload), { status: 200 });
      }
      if (url.includes("/api/ollama/models")) {
        return new Response(JSON.stringify({
          baseUrl: url.includes("22434") ? "http://127.0.0.1:22434" : "http://127.0.0.1:11434",
          reachable: true,
          models: [
            "local-model-a:latest",
            "local-model-b:latest",
            "local-model-c:latest",
            "local-model-d:latest"
          ]
        }), { status: 200 });
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
      }
      if (url.includes("/api/setup")) {
        const body = JSON.parse(String(init?.body));
        expect(body.llmMode).toBe("ollama");
        expect(body.ollamaBaseUrl).toBe("http://127.0.0.1:22434");
        expect(body.ollamaChatModel).toBe("local-model-a:latest");
        expect(body.ollamaResearchModel).toBe("local-model-b:latest");
        expect(body.ollamaExperimentModel).toBe("local-model-c:latest");
        expect(body.ollamaVisionModel).toBe("local-model-b:latest");
        expect(body.openAiApiKey).toBe("");
        expect(body.networkPolicy).toBe("blocked");
        expect(body.networkPurpose).toBe("");
        return new Response(JSON.stringify({ bootstrap: bootstrapPayload }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));

    await waitFor(() => {
      expectVisibleText("Ollama chat");
      expectVisibleText("Ollama research backend");
      expectVisibleText("Ollama experiment");
      expectVisibleText("Ollama vision");
      expect(screen.getByLabelText("Ollama base URL")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("4 installed model(s) discovered.")).toBeInTheDocument();
    });

    const ollamaExperimentSection = screen.getByText("Ollama experiment").closest("section");
    expect(ollamaExperimentSection).not.toBeNull();
    expect(within(ollamaExperimentSection as HTMLElement).getByRole("combobox", { name: "Model" })).toHaveValue(
      "local-model-c:latest"
    );

    fireEvent.change(screen.getByLabelText("Ollama base URL"), {
      target: { value: "http://127.0.0.1:22434" }
    });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/setup",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
  });

  it("shows per-slot model and reasoning selectors in workspace settings and submits them", async () => {
    const bootstrapPayload = {
      configured: true,
      setupDefaults: {
        projectName: "AutoLabOS",
        defaultTopic: "configured research topic",
        defaultConstraints: ["declared literature scope", "configured time window"],
        defaultObjectiveMetric: "configured evaluation metric"
      },
      session: {
        busy: false,
        logs: [],
        canCancel: false
      },
      runs: [],
      configSummary: {
        projectName: "AutoLabOS",
        workflowMode: "agent_approval",
        approvalMode: "minimal",
        llmMode: "codex_chatgpt_only",
        pdfMode: "codex_text_image_hybrid",
        researchBackendModel: "gpt-5.4",
        chatModel: "gpt-5.3-codex",
        experimentModel: "gpt-5.4",
        researchBackendReasoning: "xhigh",
        chatReasoning: "low",
        experimentReasoning: "xhigh"
      },
      configForm: {
        projectName: "AutoLabOS",
        defaultTopic: "configured research topic",
        defaultConstraints: "declared literature scope, configured time window",
        defaultObjectiveMetric: "configured evaluation metric",
        llmMode: "codex_chatgpt_only",
        codexChatModelChoice: "gpt-5.3-codex",
        codexChatReasoningEffort: "low",
        codexResearchBackendModelChoice: "gpt-5.4",
        codexResearchBackendReasoningEffort: "xhigh",
        codexExperimentModelChoice: "gpt-5.4",
        codexExperimentReasoningEffort: "xhigh",
        openAiChatModel: "gpt-5.4",
        openAiChatReasoningEffort: "low",
        openAiResearchBackendModel: "gpt-5.4",
        openAiResearchBackendReasoningEffort: "medium",
        openAiExperimentModel: "gpt-5.4",
        openAiExperimentReasoningEffort: "medium",
        networkPolicy: "blocked",
        networkPurpose: ""
      }
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify(bootstrapPayload), { status: 200 });
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
      }
      if (url.includes("/api/setup")) {
        const body = JSON.parse(String(init?.body));
        expect(body.pdfAnalysisMode).toBeUndefined();
        expect(body.codexChatModelChoice).toBe("gpt-5.4");
        expect(body.codexChatReasoningEffort).toBe("high");
        expect(body.codexResearchBackendModelChoice).toBeDefined();
        expect(body.codexExperimentModelChoice).toBeDefined();
        expect(body.openAiChatModel).toBeDefined();
        expect(body.openAiResearchBackendModel).toBeDefined();
        expect(body.openAiExperimentModel).toBeDefined();
        expect(body.responsesPdfModel).toBeUndefined();
        expect(body.codexPdfModelChoice).toBeUndefined();
        expect(body.openAiPdfModel).toBeUndefined();
        expect(body.networkPolicy).toBe("blocked");
        expect(body.networkPurpose).toBe("");
        return new Response(JSON.stringify({ bootstrap: bootstrapPayload }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Workspace" })).toBeInTheDocument();
    });

    expectVisibleText("Research backend: gpt-5.4 · xhigh");

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));

    await waitFor(() => {
      expectVisibleText("Workspace settings");
      expectVisibleText("Model and reasoning by slot");
      expectVisibleText("Codex chat");
      expectVisibleText("Codex research backend");
      expectVisibleText("Research backend, analysis, and planning tasks.");
    });

    const codexChatSection = screen.getByText("Codex chat").closest("section");
    expect(codexChatSection).not.toBeNull();
    expect(screen.queryByText("OpenAI experiment")).not.toBeInTheDocument();
    expect(screen.queryByText("Responses PDF")).not.toBeInTheDocument();

    fireEvent.change(within(codexChatSection as HTMLElement).getAllByRole("combobox")[0], {
      target: { value: "gpt-5.4" }
    });
    fireEvent.change(within(codexChatSection as HTMLElement).getAllByRole("combobox")[1], {
      target: { value: "high" }
    });

    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/setup",
        expect.objectContaining({
          method: "POST"
        })
      );
    });
  });

  it("renders warning-aware doctor checks for declared networked runs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              busy: false,
              logs: [],
              canCancel: false
            },
            runs: []
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(
          JSON.stringify({
            configured: true,
            checks: [
              {
                name: "experiment-web-restriction",
                ok: true,
                status: "warning",
                detail: "Code execution declares a network dependency for logging; keep the run in manual or risk_ack mode and treat the result as network-assisted."
              }
            ],
            readiness: {
              blocked: false,
              llmMode: "openai_api",
              pdfAnalysisMode: "responses_api_pdf",
              approvalMode: "minimal",
              executionApprovalMode: "risk_ack",
              dependencyMode: "local",
              sessionMode: "fresh",
              candidateIsolation: "attempt_snapshot_restore",
              networkPolicy: "declared",
              networkPurpose: "logging",
              networkDeclarationPresent: true,
              networkApprovalSatisfied: true,
              warningChecks: ["experiment-web-restriction"],
              failedChecks: []
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ artifacts: [], checkpoints: [], literature: emptyLiterature("run-1") }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Doctor" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Doctor" }));

    await waitFor(() => {
      expect(screen.getByText("experiment-web-restriction")).toBeInTheDocument();
      expect(screen.getByText("WARN")).toBeInTheDocument();
      expect(screen.getByText(/network dependency for logging/i)).toBeInTheDocument();
      expect(screen.getByText("Readiness profile")).toBeInTheDocument();
      expect(screen.getByText("openai_api / responses_api_pdf")).toBeInTheDocument();
      expect(screen.getByText("attempt_snapshot_restore")).toBeInTheDocument();
    });
  });

  it("renders stronger emphasis for required network doctor checks", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              busy: false,
              logs: [],
              canCancel: false
            },
            runs: []
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(
          JSON.stringify({
            configured: true,
            checks: [
              {
                name: "experiment-web-restriction",
                ok: true,
                status: "warning",
                detail: "Code execution declares a network-critical dependency for remote_inference; reproducibility caveats and explicit operator review remain required."
              }
            ],
            readiness: {
              blocked: false,
              llmMode: "openai_api",
              pdfAnalysisMode: "responses_api_pdf",
              approvalMode: "minimal",
              executionApprovalMode: "risk_ack",
              dependencyMode: "remote_gpu",
              sessionMode: "fresh",
              candidateIsolation: "attempt_snapshot_restore",
              networkPolicy: "required",
              networkPurpose: "remote_inference",
              networkDeclarationPresent: true,
              networkApprovalSatisfied: true,
              warningChecks: ["experiment-web-restriction"],
              failedChecks: []
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ artifacts: [], checkpoints: [], literature: emptyLiterature("run-1") }), { status: 200 });
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Doctor" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Doctor" }));

    await waitFor(() => {
      expect(screen.getByText("experiment-web-restriction")).toBeInTheDocument();
      expect(screen.getByText("REQUIRED")).toBeInTheDocument();
      expect(screen.getByText(/network-critical dependency for remote_inference/i)).toBeInTheDocument();
      expect(screen.getByText(/Network is required for this run/i)).toBeInTheDocument();
    });
  });

  it("renders repository knowledge in the inspector tab", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: [],
              canCancel: false
            },
            runs: [
              {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "paused",
                currentNode: "review",
                latestSummary: "Review ready.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "review",
                  checkpointSeq: 4,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                  }
                }
              }
            ],
            jobs: {
              generated_at: "2026-03-10T10:00:00.000Z",
              runs: [
                {
                  run_id: "run-1",
                  title: "Run one",
                  current_node: "analyze_results",
                  lifecycle_status: "paused",
                  approval_mode: "minimal",
                  last_event_at: "2026-03-10T10:00:00.000Z",
                  recommended_next_action: "resume_review",
                  analysis_ready: true,
                  review_ready: false,
                  paper_ready: false
                }
              ],
              top_failures: [
                {
                  key: "analysis:transition",
                  reason: "Review has not started yet for the analyzed run.",
                  occurrence_count: 1,
                  recurrence_probability: 1,
                  remediation: "Resume review from the analyze_results recommendation."
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(
          JSON.stringify({
            entries: [
              {
                run_id: "run-1",
                title: "Run one",
                topic: "topic",
                objective_metric: "primary_score",
                latest_summary: "Review ready.",
                latest_published_section: "review",
                updated_at: "2026-03-10T10:00:00.000Z",
                public_output_root: "outputs/run-1",
                public_manifest: "outputs/run-1/manifest.json",
                knowledge_note: ".autolabos/knowledge/runs/run-1.md",
                research_question: "Does the candidate condition outperform the reference condition?",
                analysis_summary: "The candidate condition improved primary_score over the reference condition.",
                manuscript_type: "paper_scale_candidate",
                sections: [
                  {
                    name: "analysis",
                    generated_files: ["analysis/summary.md"],
                    updated_at: "2026-03-10T10:00:00.000Z"
                  },
                  {
                    name: "review",
                    generated_files: ["review/review_packet.json"],
                    updated_at: "2026-03-10T10:00:00.000Z"
                  }
                ]
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/knowledge/file?path=.autolabos%2Fknowledge%2Fruns%2Frun-1.md")) {
        return new Response(
          JSON.stringify({
            path: ".autolabos/knowledge/runs/run-1.md",
            content: "# Run one\n\n## Research Question\n\nDoes the candidate condition outperform the reference condition?\n"
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/knowledge/file?path=outputs%2Frun-1%2Fmanifest.json") || url.includes("/api/knowledge/file?path=outputs%2Fmanifest.json")) {
        return new Response(
          JSON.stringify({
            path: "outputs/run-1/manifest.json",
            content: '{\n  "version": 1\n}\n'
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/knowledge/file?path=.autolabos%2Fruns%2Frun-1%2Fliterature_index.json")) {
        return new Response(
          JSON.stringify({
            path: ".autolabos/runs/run-1/literature_index.json",
            content: '{\n  "version": 1,\n  "run_id": "run-1"\n}\n'
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-1/literature")) {
        return new Response(JSON.stringify({ literature: populatedLiterature("run-1") }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=collect_result.json")) {
        return new Response('{"status":"completed","paper_count":40}\n', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=corpus.jsonl")) {
        return new Response('{"paper_id":"p1","title":"Corpus paper"}\n', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=bibtex.bib")) {
        return new Response('@article{p1,title={Corpus paper}}\n', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=paper_summaries.jsonl")) {
        return new Response('{"paper_id":"p1","summary":"Summary row"}\n', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=evidence_store.jsonl")) {
        return new Response('{"paper_id":"p1","quote":"Evidence row"}\n', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              title: "Run one",
              topic: "topic",
              constraints: ["declared literature scope"],
              objectiveMetric: "primary_score",
              status: "paused",
              currentNode: "review",
              latestSummary: "Review ready.",
              updatedAt: "2026-03-10T10:00:00.000Z",
              graph: {
                currentNode: "review",
                checkpointSeq: 4,
                retryCounters: {},
                rollbackCounters: {},
                nodeStates: {
                  collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                  write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Knowledge" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));

    await waitFor(() => {
      expect(screen.getByText("Does the candidate condition outperform the reference condition?")).toBeInTheDocument();
      expect(screen.getAllByText("The candidate condition improved primary_score over the reference condition.").length).toBeGreaterThan(0);
      expect(screen.getByText("paper_scale_candidate")).toBeInTheDocument();
      expect(screen.getByText("outputs/run-1/manifest.json")).toBeInTheDocument();
      expect(screen.getByText("40 papers")).toBeInTheDocument();
      expect(screen.getByText("32 with PDF / 8 missing")).toBeInTheDocument();
      expect(screen.getByText("35 with BibTeX / 12 enriched")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview note" }));

    await waitFor(() => {
      expect(screen.getAllByText(".autolabos/knowledge/runs/run-1.md").length).toBeGreaterThan(0);
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/api/knowledge/file?path=.autolabos%2Fknowledge%2Fruns%2Frun-1.md")
        )
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Preview literature index" }));

    await waitFor(() => {
      expect(screen.getByText(".autolabos/runs/run-1/literature_index.json")).toBeInTheDocument();
      expect(screen.getAllByText(/"run_id": "run-1"/i).length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Open collect result" }));

    await waitFor(() => {
      expect(screen.getByText('{"status":"completed","paper_count":40}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=collect_result.json"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));

    fireEvent.click(screen.getByRole("button", { name: "Open corpus" }));

    await waitFor(() => {
      expect(screen.getByText('{"paper_id":"p1","title":"Corpus paper"}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=corpus.jsonl"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Open bibtex" }));

    await waitFor(() => {
      expect(screen.getByText("@article{p1,title={Corpus paper}}")).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=bibtex.bib"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Open summaries" }));

    await waitFor(() => {
      expect(screen.getByText('{"paper_id":"p1","summary":"Summary row"}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=paper_summaries.jsonl"))).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Knowledge" }));
    fireEvent.click(screen.getByRole("button", { name: "Open evidence" }));

    await waitFor(() => {
      expect(screen.getByText('{"paper_id":"p1","quote":"Evidence row"}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=evidence_store.jsonl"))).toBe(true);
    });
  });

  it("renders result analysis insight actions and runs the suggested command", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: [],
              canCancel: false,
              activeRunInsight: {
                title: "Result analysis",
                lines: [
                  "Objective: met - primary_score reached the configured target.",
                  "Recommendation: advance -> review (88%)",
                  "Next: Approve the transition into review."
                ],
                actions: [{ label: "Run recommendation", command: "/approve" }],
                references: [
                  {
                    kind: "comparison",
                    label: "Comparison: Candidate condition vs reference condition",
                    path: "result_analysis.json",
                    summary: "The candidate condition improved primary_score over the reference condition by 0.05.",
                    facts: [
                      { label: "Metric", value: "primary_score" },
                      { label: "Delta", value: "+0.05" },
                      { label: "Support", value: "yes" }
                    ],
                    details: [
                      "Hypothesis support: supported by this comparison.",
                      "primary_score: candidate 0.81 vs reference 0.76 (+0.05)."
                    ]
                  },
                  {
                    kind: "statistics",
                    label: "Statistics: primary_score",
                    path: "result_analysis.json",
                    summary: "The candidate condition delivered a positive effect estimate of +0.05 primary_score versus the reference condition.",
                    facts: [
                      { label: "Metric", value: "primary_score" },
                      { label: "Delta", value: "+0.05" },
                      { label: "Confidence", value: "95%" }
                    ],
                    details: [
                      "Effect direction: positive for primary_score.",
                      "Sampling profile: 3 total, 3 executed."
                    ]
                  },
                  {
                    kind: "figure",
                    label: "Figure: Performance overview",
                    path: "figures/performance.svg",
                    summary: "Primary visualization for the recommendation.",
                    facts: [
                      { label: "Matched metric", value: "primary_score" },
                      { label: "Runs", value: "3" }
                    ],
                    details: [
                      "Metrics charted: primary_score, secondary_score.",
                      "Top observed metric: primary_score=0.81."
                    ]
                  },
                  {
                    kind: "report",
                    label: "Analysis report",
                    path: "result_analysis.json",
                    summary: "Full structured report with grounded analysis details.",
                    facts: [
                      { label: "Mean", value: "0.81" },
                      { label: "Matched metric", value: "primary_score" },
                      { label: "Objective", value: "met" }
                    ],
                    details: [
                      "The candidate condition cleared the objective threshold with limited run-to-run variance.",
                      "Limitation: Only one confirmatory configuration was executed."
                    ]
                  }
                ]
              }
            },
            runs: [
              {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "paused",
                currentNode: "analyze_results",
                latestSummary: "Analysis complete.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "analyze_results",
                  checkpointSeq: 3,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                  },
                  pendingTransition: {
                    action: "advance",
                    targetNode: "review",
                    reason: "The objective is met and the run can move into review before paper writing.",
                    confidence: 0.88,
                    autoExecutable: true,
                    evidence: ["primary_score reached the configured target."],
                    suggestedCommands: ["/approve"],
                    generatedAt: "2026-03-10T10:00:00.000Z"
                  }
                }
              }
            ],
            jobs: {
              generated_at: "2026-03-10T10:00:00.000Z",
              runs: [
                {
                  run_id: "run-1",
                  title: "Run one",
                  current_node: "analyze_results",
                  lifecycle_status: "paused",
                  approval_mode: "minimal",
                  last_event_at: "2026-03-10T10:00:00.000Z",
                  recommended_next_action: "resume_review",
                  analysis_ready: true,
                  review_ready: false,
                  paper_ready: false,
                  blocker_summary: "Review has not started yet; inspect the review packet inputs before approving the transition."
                }
              ],
              top_failures: [
                {
                  key: "review-gap",
                  reason: "Review is still pending after analysis completed.",
                  recurrence_probability: 0.67,
                  remediation: "Resume review and inspect the review packet before moving forward."
                }
              ]
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return new Response(
          JSON.stringify({
            artifacts: [
              {
                path: "run_completeness_checklist.json",
                kind: "json",
                size: 384,
                modifiedAt: "2026-03-10T10:00:00.000Z",
                previewable: true
              },
              {
                path: "figures/performance.svg",
                kind: "image",
                size: 128,
                modifiedAt: "2026-03-10T10:00:00.000Z",
                previewable: true
              },
              {
                path: "result_analysis.json",
                kind: "json",
                size: 512,
                modifiedAt: "2026-03-10T10:00:00.000Z",
                previewable: true
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              title: "Run one",
              topic: "topic",
              constraints: ["declared literature scope"],
              objectiveMetric: "primary_score",
              status: "paused",
              currentNode: "analyze_results",
              latestSummary: "Analysis complete.",
              updatedAt: "2026-03-10T10:00:00.000Z",
              graph: {
                currentNode: "analyze_results",
                checkpointSeq: 3,
                retryCounters: {},
                rollbackCounters: {},
                nodeStates: {
                  collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  review: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" },
                  write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                },
                pendingTransition: {
                  action: "advance",
                  targetNode: "review",
                  reason: "The objective is met and the run can move into review before paper writing.",
                  confidence: 0.88,
                  autoExecutable: true,
                  evidence: ["primary_score reached the configured target."],
                  suggestedCommands: ["/approve"],
                  generatedAt: "2026-03-10T10:00:00.000Z"
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/session/input")) {
        expect(JSON.parse(String(init?.body))).toEqual({ text: "/approve" });
        return new Response(
          JSON.stringify({
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: ["Approved transition."],
              canCancel: false,
                  activeRunInsight: {
                    title: "Result analysis",
                    lines: ["Objective: met - primary_score reached the configured target."],
                    actions: [{ label: "Run recommendation", command: "/approve" }],
                    references: [
                      {
                        kind: "comparison",
                        label: "Comparison: Candidate condition vs reference condition",
                        path: "result_analysis.json",
                        summary: "The candidate condition improved primary_score over the reference condition by 0.05.",
                        facts: [
                          { label: "Metric", value: "primary_score" },
                          { label: "Delta", value: "+0.05" },
                          { label: "Support", value: "yes" }
                        ],
                        details: [
                          "Hypothesis support: supported by this comparison.",
                          "primary_score: candidate 0.81 vs reference 0.76 (+0.05)."
                        ]
                      },
                      {
                        kind: "statistics",
                        label: "Statistics: primary_score",
                        path: "result_analysis.json",
                        summary: "The candidate condition delivered a positive effect estimate of +0.05 primary_score versus the reference condition.",
                        facts: [
                          { label: "Metric", value: "primary_score" },
                          { label: "Delta", value: "+0.05" },
                          { label: "Confidence", value: "95%" }
                        ],
                        details: [
                          "Effect direction: positive for primary_score.",
                          "Sampling profile: 3 total, 3 executed."
                        ]
                      },
                      {
                        kind: "figure",
                        label: "Figure: Performance overview",
                        path: "figures/performance.svg",
                        summary: "Primary visualization for the recommendation.",
                        facts: [
                          { label: "Matched metric", value: "primary_score" },
                          { label: "Runs", value: "3" }
                        ],
                        details: [
                          "Metrics charted: primary_score, secondary_score.",
                          "Top observed metric: primary_score=0.81."
                        ]
                      },
                      {
                        kind: "report",
                        label: "Analysis report",
                        path: "result_analysis.json",
                        summary: "Full structured report with grounded analysis details.",
                        facts: [
                          { label: "Mean", value: "0.81" },
                          { label: "Matched metric", value: "primary_score" },
                          { label: "Objective", value: "met" }
                        ],
                        details: [
                          "The candidate condition cleared the objective threshold with limited run-to-run variance.",
                          "Limitation: Only one confirmatory configuration was executed."
                        ]
                      }
                    ]
                  }
                }
              }),
              { status: 200 }
            );
          }
      if (url.includes("/api/runs/run-1/artifact?path=result_analysis.json")) {
        return new Response('{"analysis_version":1}', { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifact?path=run_completeness_checklist.json")) {
        return new Response('{"summary":"3/3 required completeness checks present"}', { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Result analysis")).toBeInTheDocument();
      expect(screen.getByText("Recommendation: advance -> review (88%)")).toBeInTheDocument();
      expect(screen.getByText("Comparison")).toBeInTheDocument();
      expect(screen.getByText("Statistics")).toBeInTheDocument();
      expect(screen.getByText("The candidate condition improved primary_score over the reference condition by 0.05.")).toBeInTheDocument();
      expect(screen.getAllByText("Metric primary_score").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Delta +0.05").length).toBeGreaterThan(0);
      expect(screen.getByText("Confidence 95%")).toBeInTheDocument();
      expect(screen.getByText("Full structured report with grounded analysis details.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /analysis report/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /open checklist/i })).toBeInTheDocument();
      expect(screen.getByText("Top failures")).toBeInTheDocument();
      expect(screen.getByText("Next: Resume review")).toBeInTheDocument();
      expect(screen.getByText("A/R/P: yes/no/no")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /open checklist/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === "/api/runs/run-1/artifact?path=run_completeness_checklist.json")
      ).toBe(true);
    });

    fireEvent.click(screen.getByRole("button", { name: /comparison: candidate condition vs reference condition/i }));

    await waitFor(() => {
      expect(screen.getByText("Hypothesis support: supported by this comparison.")).toBeInTheDocument();
      expect(screen.getByText("primary_score: candidate 0.81 vs reference 0.76 (+0.05).")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /open artifact for comparison: candidate condition vs reference condition/i })).toBeInTheDocument();
    });

    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: /run recommendation/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session/input",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "/approve" })
        })
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /open artifact for comparison: candidate condition vs reference condition/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === "/api/runs/run-1/artifact?path=result_analysis.json")
      ).toBe(true);
    });
  });

  it("renders the manuscript quality summary with separated issue groups and artifact links", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: [],
              canCancel: false,
              activeRunInsight: {
                title: "Manuscript quality",
                lines: [
                  "Status: Stopped.",
                  "Reason: Policy hard stop.",
                  "Review reliability: grounded.",
                  "Triggered by: appendix_hygiene."
                ],
                manuscriptQuality: {
                  status: "stopped",
                  stage: "post_repair_1",
                  reasonCategory: "policy_hard_stop",
                  displayReasonLabel: "Policy hard stop",
                  reviewReliability: "grounded",
                  triggeredBy: ["appendix_hygiene"],
                  repairAttempts: {
                    attempted: 1,
                    allowedMax: 2,
                    remaining: 0,
                    improvementDetected: false
                  },
                  issueCounts: {
                    manuscript: 1,
                    hardStopPolicy: 1,
                    backstopOnly: 1,
                    readinessRisks: 1,
                    scientificBlockers: 1,
                    submissionBlockers: 1,
                    reviewerMissedPolicy: 1,
                    reviewerCoveredBackstop: 1
                  },
                  issueGroups: {
                    manuscript: [
                      {
                        code: "appendix_hygiene",
                        section: "Appendix",
                        severity: "fail",
                        message: "Appendix still contains internal workflow language.",
                        source: "review"
                      }
                    ],
                    hardStopPolicy: [
                      {
                        code: "appendix_internal_text",
                        section: "Appendix",
                        severity: "fail",
                        message: "Deterministic hard-stop policy finding remained uncovered in Appendix.",
                        source: "style_lint"
                      }
                    ],
                    backstopOnly: [
                      {
                        code: "duplicate_sentence_pattern",
                        section: "Discussion",
                        severity: "warning",
                        message: "Deterministic backstop finding remains recorded for Discussion.",
                        source: "style_lint"
                      }
                    ],
                    readiness: [
                      {
                        code: "paper_scale_paper_scale_candidate",
                        section: "Paper scale",
                        severity: "warning",
                        message: "The post-draft critique still classifies the run as paper_scale_candidate, not paper_ready.",
                        source: "paper_readiness"
                      }
                    ],
                    scientific: [
                      {
                        code: "missing_baseline",
                        section: "Results",
                        severity: "fail",
                        message: "Baseline comparison is still missing.",
                        source: "scientific_validation"
                      }
                    ],
                    submission: [
                      {
                        code: "citation",
                        section: "Conclusion",
                        severity: "fail",
                        message: "A comparative claim in the conclusion is uncited.",
                        source: "submission_validation"
                      }
                    ]
                  },
                  artifactRefs: [
                    { label: "Manuscript quality gate", path: "paper/manuscript_quality_gate.json" },
                    { label: "Manuscript quality failure", path: "paper/manuscript_quality_failure.json" },
                    { label: "Readiness risks", path: "paper/readiness_risks.json" },
                    { label: "Manuscript review", path: "paper/manuscript_review.json" }
                  ]
                }
              }
            },
            runs: [
              {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "failed",
                currentNode: "write_paper",
                latestSummary: "write_paper stopped at the manuscript quality gate.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "write_paper",
                  checkpointSeq: 7,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "failed", updatedAt: "2026-03-10T10:00:00.000Z" }
                  }
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              title: "Run one",
              topic: "topic",
              constraints: ["declared literature scope"],
              objectiveMetric: "primary_score",
              status: "failed",
              currentNode: "write_paper",
              latestSummary: "write_paper stopped at the manuscript quality gate.",
              updatedAt: "2026-03-10T10:00:00.000Z",
              graph: {
                currentNode: "write_paper",
                checkpointSeq: 7,
                retryCounters: {},
                rollbackCounters: {},
                nodeStates: {
                  collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  review: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  write_paper: { status: "failed", updatedAt: "2026-03-10T10:00:00.000Z" }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Manuscript quality")).toBeInTheDocument();
      expect(screen.getByText("Stopped")).toBeInTheDocument();
      expect(screen.getByText("Policy hard stop")).toBeInTheDocument();
      expect(screen.getByText("Repairable manuscript issues")).toBeInTheDocument();
      expect(screen.getByText("Hard-stop policy findings")).toBeInTheDocument();
      expect(screen.getByText("Paper readiness risks")).toBeInTheDocument();
      expect(screen.getByText("Scientific blockers")).toBeInTheDocument();
      expect(screen.getByText("Submission blockers")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manuscript quality gate" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Manuscript quality failure" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Readiness risks" })).toBeInTheDocument();
    });
  });

  it("renders review-stage readiness risks in the selected-run insight panel", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: [],
              canCancel: false,
              activeRunInsight: {
                title: "Review packet",
                lines: [
                  "Review packet refreshed.",
                  "Paper readiness risks: blocked 1, warning 0, state blocked_for_paper_scale."
                ],
                readinessRisks: {
                  stage: "review",
                  readinessState: "blocked_for_paper_scale",
                  paperReady: false,
                  riskCounts: {
                    total: 1,
                    blocked: 1,
                    warning: 0
                  },
                  risks: [
                    {
                      code: "review_minimum_gate_blocked_for_paper_scale",
                      section: "Paper scale",
                      severity: "fail",
                      message: "Minimum gate: 3 check(s) failed — ceiling: blocked_for_paper_scale.",
                      source: "review_readiness"
                    }
                  ],
                  artifactRefs: [{ label: "Review readiness risks", path: "review/readiness_risks.json" }]
                }
              }
            },
            runs: [
              {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "paused",
                currentNode: "review",
                latestSummary: "Review packet prepared.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "review",
                  checkpointSeq: 4,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                  }
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              title: "Run one",
              topic: "topic",
              constraints: ["declared literature scope"],
              objectiveMetric: "primary_score",
              status: "paused",
              currentNode: "review",
              latestSummary: "Review packet prepared.",
              updatedAt: "2026-03-10T10:00:00.000Z",
              graph: {
                currentNode: "review",
                checkpointSeq: 4,
                retryCounters: {},
                rollbackCounters: {},
                nodeStates: {
                  collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                  write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-1/artifact?path=review%2Freadiness_risks.json")) {
        return new Response(
          JSON.stringify({
            generated_at: "2026-03-10T10:00:00.000Z",
            paper_ready: false,
            readiness_state: "blocked_for_paper_scale",
            risk_count: 1,
            blocked_count: 1,
            warning_count: 0,
            risks: [
              {
                risk_code: "review_minimum_gate_blocked_for_paper_scale",
                severity: "blocked",
                category: "paper_scale",
                status: "blocked",
                message: "Minimum gate: 3 check(s) failed — ceiling: blocked_for_paper_scale.",
                triggered_by: ["minimum_gate"],
                affected_claim_ids: [],
                affected_citation_ids: [],
                recommended_action: "Backtrack and raise the review minimum gate before drafting.",
                recheck_condition: "Minimum gate passes with the required evidence floor."
              }
            ],
            summary_lines: ["Readiness risks: blocked=1, warning=0, readiness_state=blocked_for_paper_scale."]
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Review packet")).toBeInTheDocument();
      expect(screen.getByText("Paper readiness risks")).toBeInTheDocument();
      expect(screen.getByText("Readiness State")).toBeInTheDocument();
      expect(screen.getByText("blocked_for_paper_scale")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Review readiness risks" })).toBeInTheDocument();
    });
  });

  it("renders a structured review packet preview and runs the refresh command", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["declared literature scope", "configured time window"],
              defaultObjectiveMetric: "configured evaluation metric"
            },
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: [],
              canCancel: false
            },
            runs: [
              {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "paused",
                currentNode: "review",
                latestSummary: "Review packet prepared.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "review",
                  checkpointSeq: 4,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                  }
                }
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return new Response(
          JSON.stringify({
            artifacts: [
              {
                path: "review/review_packet.json",
                kind: "json",
                size: 1024,
                modifiedAt: "2026-03-10T10:00:00.000Z",
                previewable: true
              },
              {
                path: "review/checklist.md",
                kind: "text",
                size: 512,
                modifiedAt: "2026-03-10T10:00:00.000Z",
                previewable: true
              }
            ]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return new Response(
          JSON.stringify({
            run: {
              id: "run-1",
              title: "Run one",
              topic: "topic",
              constraints: ["declared literature scope"],
              objectiveMetric: "primary_score",
              status: "paused",
              currentNode: "review",
              latestSummary: "Review packet prepared.",
              updatedAt: "2026-03-10T10:00:00.000Z",
              graph: {
                currentNode: "review",
                checkpointSeq: 4,
                retryCounters: {},
                rollbackCounters: {},
                nodeStates: {
                  collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                  review: { status: "needs_approval", updatedAt: "2026-03-10T10:00:00.000Z" },
                  write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                }
              }
            }
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-1/artifact?path=review%2Freview_packet.json")) {
        return new Response(
          JSON.stringify(
            {
              generated_at: "2026-03-10T10:00:00.000Z",
              readiness: {
                status: "blocking",
                ready_checks: 3,
                warning_checks: 2,
                blocking_checks: 1,
                manual_checks: 1
              },
              objective_status: "met",
              objective_summary: "Objective metric met: primary_score=0.91 >= 0.9.",
              recommendation: {
                action: "advance",
                target: "review",
                confidence_pct: 88,
                reason: "The run can proceed to manual review before paper writing.",
                evidence: ["primary_score reached the configured target."]
              },
              checks: [
                {
                  id: "evidence_bundle",
                  label: "Evidence bundle",
                  status: "blocking",
                  detail: "Missing required paper inputs: evidence_store.jsonl."
                },
                {
                  id: "paper_narrative",
                  label: "Paper narrative inputs",
                  status: "warning",
                  detail: "Synthesis or grounded paper claims are incomplete."
                },
                {
                  id: "human_signoff",
                  label: "Human sign-off",
                  status: "manual",
                  detail: "Confirm the claims, evidence quality, and next action before approving write_paper."
                }
              ],
              suggested_actions: ["/agent apply", "/agent jump analyze_results"]
            },
            null,
            2
          ),
          { status: 200 }
        );
      }
      if (url.includes("/api/session/input")) {
        expect(JSON.parse(String(init?.body))).toEqual({ text: "/agent review" });
        return new Response(
          JSON.stringify({
            session: {
              activeRunId: "run-1",
              busy: false,
              logs: ["Review packet refreshed."],
              canCancel: false
            }
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Selected run")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Artifacts" }));
    fireEvent.click(screen.getByRole("button", { name: /review\/review_packet\.json/i }));

    await waitFor(() => {
      expect(screen.getByText("Review readiness")).toBeInTheDocument();
      expect(screen.getAllByText("Blocking").length).toBeGreaterThan(0);
      expect(screen.getByRole("button", { name: /refresh review/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /refresh review/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session/input",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ text: "/agent review" })
        })
      );
    });
  });

  it("shows a live activity banner immediately while a command request is in flight", async () => {
    let resolveSessionInput: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              configured: true,
              setupDefaults: {
                projectName: "AutoLabOS",
                defaultTopic: "configured research topic",
                defaultConstraints: ["declared literature scope", "configured time window"],
                defaultObjectiveMetric: "configured evaluation metric"
              },
              session: {
                activeRunId: "run-1",
                busy: false,
                logs: [],
                canCancel: false
              },
              runs: [
                {
                  id: "run-1",
                  title: "Run one",
                  topic: "topic",
                  constraints: ["declared literature scope"],
                  objectiveMetric: "primary_score",
                  status: "paused",
                  currentNode: "analyze_results",
                  latestSummary: "Analysis complete.",
                  updatedAt: "2026-03-10T10:00:00.000Z",
                  graph: {
                    currentNode: "analyze_results",
                    checkpointSeq: 3,
                    retryCounters: {},
                    rollbackCounters: {},
                    nodeStates: {
                      collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                      review: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" },
                      write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                    }
                  }
                }
              ]
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("/api/doctor")) {
        return Promise.resolve(new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 }));
      }
      if (url.includes("/api/knowledge") && !url.includes("/api/knowledge/file")) {
        return Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return Promise.resolve(new Response(JSON.stringify({ literature: emptyLiterature("run-1") }), { status: 200 }));
      }
      if (url.includes("/api/runs/run-1/artifacts")) {
        return Promise.resolve(new Response(JSON.stringify({ artifacts: [] }), { status: 200 }));
      }
      if (url.includes("/api/runs/run-1/checkpoints")) {
        return Promise.resolve(new Response(JSON.stringify({ checkpoints: [] }), { status: 200 }));
      }
      if (url.includes("/api/runs/run-1") && !url.includes("/actions")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              run: {
                id: "run-1",
                title: "Run one",
                topic: "topic",
                constraints: ["declared literature scope"],
                objectiveMetric: "primary_score",
                status: "paused",
                currentNode: "analyze_results",
                latestSummary: "Analysis complete.",
                updatedAt: "2026-03-10T10:00:00.000Z",
                graph: {
                  currentNode: "analyze_results",
                  checkpointSeq: 3,
                  retryCounters: {},
                  rollbackCounters: {},
                  nodeStates: {
                    collect_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_papers: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    generate_hypotheses: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    design_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    implement_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    run_experiments: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    analyze_results: { status: "completed", updatedAt: "2026-03-10T10:00:00.000Z" },
                    review: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" },
                    write_paper: { status: "pending", updatedAt: "2026-03-10T10:00:00.000Z" }
                  }
                }
              }
            }),
            { status: 200 }
          )
        );
      }
      if (url.includes("/api/session/input")) {
        expect(JSON.parse(String(init?.body))).toEqual({ text: "/agent status" });
        return new Promise<Response>((resolve) => {
          resolveSessionInput = resolve;
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("Selected run")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "/agent status" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
      expect(screen.getByText("Runtime activity")).toBeInTheDocument();
      expect(screen.getAllByText("Running /agent status").length).toBeGreaterThan(0);
      expect(screen.getByText("Run one · Analyze Results")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Running..." })).toBeInTheDocument();
    });

    resolveSessionInput?.(
      new Response(
        JSON.stringify({
          session: {
            activeRunId: "run-1",
            busy: false,
            logs: ["Status checked."],
            canCancel: false
          }
        }),
        { status: 200 }
      )
    );

    await waitFor(() => {
      expect(screen.queryByText("Runtime activity")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    });
  });

  it("keeps an incomplete brief as a draft and shows why research start is locked", async () => {
    const partialBrief = [
      "# Research Brief",
      "",
      "## Topic",
      "Evaluate a candidate condition under a bounded protocol."
    ].join("\n");
    let createdRun:
      | {
          id: string;
          title: string;
          topic: string;
          constraints: string[];
          objectiveMetric: string;
          status: string;
          currentNode: string;
          latestSummary?: string;
          updatedAt: string;
          graph: {
            currentNode: string;
            checkpointSeq: number;
            retryCounters: Record<string, number>;
            rollbackCounters: Record<string, number>;
            nodeStates: Record<string, { status: string; updatedAt: string }>;
          };
        }
      | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(
          JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "default research topic",
              defaultConstraints: ["bounded runtime"],
              defaultObjectiveMetric: "primary score"
            },
            session: {
              activeRunId: createdRun?.id,
              busy: false,
              logs: [],
              canCancel: false
            },
            runs: createdRun ? [createdRun] : []
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/") && url.includes("/literature")) {
        return new Response(JSON.stringify({ literature: emptyLiterature(createdRun?.id || "run-brief-1") }), { status: 200 });
      }
      if (url === "/api/runs") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          brief: partialBrief,
          autoStart: true
        });
        createdRun = {
          id: "run-brief-1",
          title: "Run brief",
          topic: "Evaluate a candidate condition under a bounded protocol.",
          constraints: ["bounded runtime"],
          objectiveMetric: "primary score",
          status: "pending",
          currentNode: "collect_papers",
          updatedAt: "2026-03-11T10:00:00.000Z",
          graph: {
            currentNode: "collect_papers",
            checkpointSeq: 0,
            retryCounters: {},
            rollbackCounters: {},
            nodeStates: {
              collect_papers: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              analyze_papers: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              generate_hypotheses: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              design_experiments: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              implement_experiments: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              run_experiments: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              analyze_results: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              review: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" },
              write_paper: { status: "pending", updatedAt: "2026-03-11T10:00:00.000Z" }
            }
          }
        };
        return new Response(
          JSON.stringify({
            run: createdRun,
            session: {
              activeRunId: createdRun.id,
              busy: false,
              logs: ["Created draft run."],
              canCancel: false
            },
            briefStartGate: {
              requested: true,
              canStart: false,
              blocked: true,
              effectiveAutoStart: false,
              missingFields: ["Objective Metric", "Constraints", "Baseline / Comparator"],
              validationErrors: ["Required brief sections are incomplete."],
              validationWarnings: []
            },
            runs: [createdRun]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/api/runs/run-brief-1/artifacts")) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-brief-1/checkpoints")) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url.includes("/api/runs/run-brief-1") && !url.includes("/actions")) {
        return new Response(JSON.stringify({ run: createdRun }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "EventSource",
      class {
        addEventListener() {}
        close() {}
      } as unknown as typeof EventSource
    );

    render(<App />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New run" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.getByLabelText("Topic")).toBeRequired();
    expect(screen.getByLabelText("Constraints")).toBeRequired();
    expect(screen.getByLabelText("Objective")).toBeRequired();
    fireEvent.change(screen.getByLabelText("Research brief"), {
      target: {
        value: partialBrief
      }
    });
    expect(screen.getByLabelText("Topic")).not.toBeRequired();
    expect(screen.getByLabelText("Constraints")).not.toBeRequired();
    expect(screen.getByLabelText("Objective")).not.toBeRequired();
    fireEvent.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs",
        expect.objectContaining({
          method: "POST"
        })
      );
    });

    expect(screen.getAllByText("Run brief").length).toBeGreaterThan(0);
    expect(screen.getByText("Research start locked")).toBeInTheDocument();
    const missingFields = screen.getByLabelText("Missing or incomplete brief fields");
    expect(within(missingFields).getByText("Objective Metric")).toBeInTheDocument();
    expect(within(missingFields).getByText("Constraints")).toBeInTheDocument();
    expect(within(missingFields).getByText("Baseline / Comparator")).toBeInTheDocument();
    expect(screen.getByLabelText("Research brief")).toHaveValue(partialBrief);
    expect(screen.queryByText("collect_papers started")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Research brief"), {
      target: { value: `${partialBrief}\n\n## Objective Metric\nPrimary metric: primary score.` }
    });
    expect(screen.queryByText("Research start locked")).not.toBeInTheDocument();
  });

  it("renders an authorized bounded probe without replacing the run scope", async () => {
    const contractHash = "a".repeat(64);
    renderAppWithResearchFunnel({
      gap_evidence_audit: {
        status: "verified",
        construction_mode: "reviewed_semantic_synthesis",
        synthesis_status: "completed",
        analysis_coverage: {
          selected_paper_count: 12,
          completed_paper_count: 12,
          failed_paper_ids: [],
          complete: true
        },
        total_evidence_count: 8,
        scientific_evidence_count: 6,
        grounded_scientific_evidence_count: 5,
        synthesis_eligible_evidence_count: 4,
        synthesis_excluded_evidence_count: 4,
        accepted_cluster_count: 2,
        malformed_evidence_row_count: 0,
        source_scope_counts: {
          abstract: 1,
          full_text_excerpt: 7,
          full_document: 0,
          unknown: 0
        },
        grounding_status_counts: {
          grounded_span: 5,
          ungrounded_span: 3,
          fallback: 0,
          unknown: 0
        }
      },
      candidate_count: 6,
      cluster_count: 3,
      diagnostics_trusted: true,
      collection_state: "quality_gate_passed",
      authorization_trusted: true,
      portfolio_candidates: [
        {
          rank: 1,
          candidate_id: "candidate-65c21f",
          topic_id: "topic-4e21bd",
          statement: "Evaluate the declared candidate under the bounded protocol.",
          trusted: true,
          review_status: "kept",
          probe_status: "shortlisted",
          probe_eligible: true,
          scores: {
            novelty: 4,
            feasibility: 5,
            testability: 5,
            cost: 4,
            expected_gain: 3
          },
          closest_prior_paper_ids: ["paper-prior"],
          closest_prior_full_text_paper_ids: ["paper-prior"],
          prior_absorption_comparisons: [
            { prior_paper_id: "paper-prior", disposition: "non_overlapping" }
          ],
          prior_absorption_reason_codes: [],
          closest_prior_non_overlap: "The declared evaluation protocol is not covered.",
          reviewer_absorption_objection: "The nearest prior may already cover the mechanism.",
          comparator: "declared reference",
          dataset_task_bench: "bounded evaluation set",
          primary_metric: "primary_score",
          local_budget: "one local execution window",
          kill_signal: "Reject when the paired effect misses the declared floor.",
          contribution_claim: "A bounded protocol-level contribution.",
          minimum_publishable_evidence: "Repeated paired comparisons with uncertainty.",
          review_summary: "Retain only after direct-prior verification.",
          topic_memory_disposition: "clear",
          topic_memory_maximum_lineage_similarity: 0.2,
          blocked_gate_codes: []
        }
      ],
      probe_candidate_count: 2,
      probe_candidate_ids: ["candidate-65c21f", "candidate-902abd"],
      probe_candidate_statements: [
        "Evaluate the declared candidate under the bounded protocol.",
        "Evaluate the declared alternative under the same bounded protocol."
      ],
      active_candidate_id: "candidate-65c21f",
      active_topic_id: "topic-4e21bd",
      active_candidate_hash: "b".repeat(64),
      active_primary_metric: "primary_score",
      active_metric_unit: "proportion",
      active_metric_scale: "proportion",
      active_metric_direction: "maximize",
      active_effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.05,
        scale: "proportion",
        inclusive: true
      },
      active_objective_raw: "declared-objective-binding",
      active_meaningful_effect: "At least 0.05 over the declared comparator.",
      active_evidence_stage: "bounded_probe",
      active_deferred_candidate_ids: ["candidate-902abd"],
      topic_memory: {
        status: "verified",
        trusted: true,
        ledger_sha256: "9".repeat(64),
        record_count: 3,
        blocked_candidate_count: 2,
        reentry_required_count: 1,
        reentry_allowed_count: 1,
        audit_artifact_ref: {
          label: "Topic memory audit",
          path: "hypothesis_generation/topic_memory_audit.json"
        },
        update_artifact_ref: {
          label: "Topic memory update",
          path: "analysis/topic_memory_update.json"
        }
      },
      candidate_prior_search: {
        status: "complete",
        trusted: true,
        action: "already_searched",
        completed_rounds: 1,
        max_rounds: 2,
        current_receipt_status: "valid",
        candidate_count: 1,
        selected_candidate_count: 0,
        broad_lane_attempt_count: 3,
        recent_lane_attempt_count: 3,
        fetched_count: 12,
        selected_paper_count: 2,
        covered_candidate_ids: ["candidate-65c21f"],
        reason_codes: [],
        artifact_refs: []
      },
      estimator_feasibility: {
        status: "pass",
        trusted: true,
        execution_authorized: true,
        reason_codes: [],
        artifact_refs: []
      },
      effective_execution_authorized: true,
      execution_authorization: {
        status: "authorized",
        trusted: true,
        authorized: true,
        base_funnel_authorized: true,
        candidate_prior_search_authorized: true,
        estimator_authorized: true,
        required_candidate_ids: ["candidate-65c21f"],
        covered_candidate_ids: ["candidate-65c21f"],
        reason_codes: []
      },
      lifecycle_stage: "probe_authorized",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: true,
      reason_codes: [],
      hashes: {
        gap_map: "gap-hash",
        topic_portfolio: "portfolio-hash",
        topic_decision: "decision-hash",
        active_topic_probe_contract: contractHash
      },
      artifact_refs: [
        {
          label: "Active topic probe contract",
          path: "design_experiments_panel/active_topic_probe_contract.json"
        }
      ],
      integrity_status: "complete"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-active");
    expect(funnel).not.toHaveClass("workbench-card", "sub-panel");
    expect(funnel.querySelector(".workbench-card, .sub-panel")).toBeNull();
    expect(funnel.querySelector(".status-pill")).toHaveTextContent("Execution authorized");
    expect(within(funnel).getAllByText("Probe authorized")).toHaveLength(1);
    expect(within(funnel).getByText("Run scope")).toBeInTheDocument();
    expect(within(funnel).getByText("Configured research scope")).toBeInTheDocument();
    expect(within(funnel).getByText("Bounded probe candidates")).toBeInTheDocument();
    expect(within(funnel).getAllByText("Evaluate the declared candidate under the bounded protocol.")).toHaveLength(2);
    expect(within(funnel).getByText("Evaluate the declared alternative under the same bounded protocol.")).toBeInTheDocument();
    const candidatePortfolio = within(funnel).getByLabelText("Topic candidate audit portfolio");
    expect(candidatePortfolio).toHaveTextContent("Candidate 1");
    expect(candidatePortfolio).toHaveTextContent("paper-prior: Non Overlapping");
    expect(candidatePortfolio).toHaveTextContent("The nearest prior may already cover the mechanism.");
    expect(candidatePortfolio).toHaveTextContent("Reject when the paired effect misses the declared floor.");
    expect(candidatePortfolio).toHaveTextContent("Repeated paired comparisons with uncertainty.");
    expect(Array.from(funnel.querySelectorAll(".research-funnel-metrics > div > dd")).map((entry) => entry.textContent)).toEqual([
      "topic_discovery",
      "Probe Authorized",
      "Complete",
      "Quality Gate Passed",
      "Probe authorized",
      "Unmeasured",
      "Unmeasured",
      "6",
      "3",
      "Complete · trusted",
      "1/2 · receipt Valid",
      "Pass · trusted",
      "Authorized · trusted",
      "Verified · trusted",
      "3 records · 2 blocked · 1 reentry required · 1 allowed",
      "Verified",
      "5/6",
      "4/8",
      "2",
      "12/12",
      "2",
      "Authorized",
      "Trusted"
    ]);
    expect(within(funnel).getByRole("note", { name: "Bounded probe evidence boundary" })).toHaveTextContent(
      "paper_evidence_allowed=false"
    );
    const topicMemory = within(funnel).getByLabelText("Topic memory provenance");
    expect(topicMemory).toHaveTextContent("9".repeat(64));
    expect(topicMemory).toHaveTextContent("hypothesis_generation/topic_memory_audit.json");
    expect(topicMemory).toHaveTextContent("analysis/topic_memory_update.json");
    const activeProbe = within(funnel).getByRole("region", { name: "Verified active bounded probe" });
    expect(within(activeProbe).getByText("Bounded probe only; not paper evidence")).toBeInTheDocument();
    expect(within(activeProbe).getByText("candidate-65c21f")).toBeInTheDocument();
    expect(within(activeProbe).getByText("primary_score")).toBeInTheDocument();
    expect(within(activeProbe).getAllByText("proportion")).toHaveLength(2);
    expect(within(activeProbe).getByText("maximize")).toBeInTheDocument();
    expect(within(activeProbe).getByText(">=0.05 proportion delta_vs_reference")).toBeInTheDocument();
    expect(within(activeProbe).getByText("declared-objective-binding")).toBeInTheDocument();
    expect(within(activeProbe).getByText("candidate-902abd")).toBeInTheDocument();
    expect(within(activeProbe).getByText("At least 0.05 over the declared comparator.")).toBeInTheDocument();
    expect(within(activeProbe).getByText("bounded_probe")).toBeInTheDocument();
    expect(within(activeProbe).getByText("design_experiments_panel/active_topic_probe_contract.json")).toBeInTheDocument();
    expect(within(activeProbe).getByText(contractHash)).toBeInTheDocument();
    expect(within(funnel).queryByText(/final topic/i)).not.toBeInTheDocument();
  });

  it("keeps pre-probe selection visible while prioritizing a trusted estimator block", async () => {
    renderAppWithResearchFunnel({
      candidate_count: 5,
      cluster_count: 3,
      diagnostics_trusted: true,
      collection_state: "quality_gate_passed",
      authorization_trusted: true,
      lifecycle_stage: "probe_authorized",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: true,
      integrity_status: "complete",
      estimator_feasibility: {
        status: "blocked",
        trusted: true,
        execution_authorized: false,
        estimand_type: "paired_mean_difference",
        estimator_family: "paired_mean_difference",
        independent_cluster_count: 12,
        primary_denominator: 12,
        attainable_resolution: 0.01,
        planned_minimum_detectable_effect: 0.1,
        reason_codes: ["too_few_clusters"],
        artifact_refs: [{
          label: "Estimator feasibility report",
          path: "design_experiments_panel/estimator_feasibility_report.json"
        }]
      },
      effective_execution_authorized: false,
      execution_authorization: {
        status: "blocked",
        trusted: true,
        authorized: false,
        base_funnel_authorized: true,
        candidate_prior_search_authorized: true,
        estimator_authorized: false,
        required_candidate_ids: ["candidate-active"],
        covered_candidate_ids: ["candidate-active"],
        reason_codes: ["effective_execution_estimator_not_passed:blocked"]
      }
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel.querySelector(".status-pill")).toHaveTextContent("Execution blocked");
    expect(within(funnel).getByText("Probe selected; execution blocked")).toBeInTheDocument();
    expect(within(funnel).getByText("Estimator feasibility").closest("div")).toHaveTextContent(
      "Blocked · trusted"
    );
    expect(within(funnel).getByText("Experiment execution").closest("div")).toHaveTextContent(
      "Blocked"
    );
    expect(within(funnel).getByText("Estimator contract").closest("div")).toHaveTextContent(
      "paired_mean_difference · paired_mean_difference · clusters=12 · denominator=12"
    );
    expect(funnel).toHaveClass("is-warning");
  });

  it("keeps reviewed post-probe state above the historical authorization state", async () => {
    renderAppWithResearchFunnel({
      candidate_count: 3,
      cluster_count: 2,
      diagnostics_trusted: true,
      collection_state: "quality_gate_passed",
      authorization_trusted: true,
      lifecycle_stage: "reviewed",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: true,
      outcome_disposition: "promote_to_confirmatory",
      outcome_next_action: "start_confirmatory_run",
      outcome_gate: {
        status: "decided",
        trusted: true,
        reason_codes: [],
        content_sha256: "1".repeat(64),
        artifact_ref: {
          label: "Topic probe outcome gate",
          path: "analysis/topic_probe_outcome_gate.json"
        }
      },
      followup_handoff: {
        status: "ready",
        trusted: true,
        recommended_followup_mode: "hypothesis_test",
        evidence_stage: "confirmatory",
        content_sha256: "2".repeat(64),
        artifact_ref: {
          label: "Topic probe follow-up handoff",
          path: "review/topic_probe_followup_handoff.json"
        }
      },
      review_gate: {
        status: "followup_required",
        trusted: true,
        paper_drafting_allowed: false,
        reason_codes: ["confirmatory_followup_required"],
        content_sha256: "3".repeat(64),
        artifact_ref: {
          label: "Topic probe review gate",
          path: "review/topic_probe_gate.json"
        }
      },
      integrity_status: "complete"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel.querySelector(".status-pill")).toHaveTextContent("Reviewed, follow-up required");
    expect(funnel.querySelector(".status-pill")).not.toHaveTextContent("Probe authorized");
    expect(within(funnel).getByText("Promote To Confirmatory")).toBeInTheDocument();
    expect(within(funnel).getByText("Start Confirmatory Run")).toBeInTheDocument();
    const lifecycle = within(funnel).getByLabelText("Topic probe persisted lifecycle");
    expect(within(lifecycle).getByText("decided")).toBeInTheDocument();
    expect(within(lifecycle).getByText("ready")).toBeInTheDocument();
    expect(within(lifecycle).getByText("followup_required")).toBeInTheDocument();
    expect(within(funnel).getByRole("note", { name: "Bounded probe evidence boundary" })).toHaveTextContent(
      "paper_evidence_allowed=false"
    );
  });

  it("renders a structured active probe without optional meaningful-effect prose", async () => {
    renderAppWithResearchFunnel({
      candidate_count: 5,
      cluster_count: 3,
      diagnostics_trusted: true,
      collection_state: "quality_gate_passed",
      authorization_trusted: true,
      probe_candidate_count: 1,
      probe_candidate_ids: ["candidate-active"],
      probe_candidate_statements: ["Evaluate the declared candidate under a bounded protocol."],
      active_candidate_id: "candidate-active",
      active_topic_id: "topic-active",
      active_candidate_hash: "c".repeat(64),
      active_primary_metric: "primary_score",
      active_metric_unit: "unitless",
      active_metric_scale: "raw",
      active_metric_direction: "minimize",
      active_effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 2,
        scale: "raw",
        inclusive: false
      },
      active_objective_raw: "declared-objective-binding",
      active_evidence_stage: "bounded_probe",
      active_deferred_candidate_ids: ["candidate-deferred"],
      lifecycle_stage: "probe_authorized",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: true,
      hashes: { active_topic_probe_contract: "d".repeat(64) },
      artifact_refs: [{
        label: "Active topic probe contract",
        path: "design_experiments_panel/active_topic_probe_contract.json"
      }],
      integrity_status: "complete"
    });

    const activeProbe = await screen.findByRole("region", { name: "Verified active bounded probe" });
    expect(within(activeProbe).getByText("<-2 raw delta_vs_reference")).toBeInTheDocument();
    expect(within(activeProbe).getByText("candidate-deferred")).toBeInTheDocument();
    expect(within(activeProbe).queryByText("Effect note")).not.toBeInTheDocument();
  });

  it("shows an artifact-free topic discovery run as unmeasured, not blocked", async () => {
    renderAppWithResearchFunnel({});

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-neutral");
    expect(within(funnel).getAllByText("Unmeasured").length).toBeGreaterThan(0);
    expect(within(funnel).queryByText("Probe blocked")).not.toBeInTheDocument();
    expect(within(funnel).queryByText("Blocked")).not.toBeInTheDocument();
  });

  it("does not authorize an untrusted funnel even when probe_allowed is stale true", async () => {
    renderAppWithResearchFunnel({
      authorization_trusted: false,
      lifecycle_stage: "probe_authorized",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: true,
      integrity_status: "complete"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-warning");
    expect(within(funnel).getByText("Probe blocked")).toBeInTheDocument();
    expect(within(funnel).getByText("Blocked")).toBeInTheDocument();
    expect(within(funnel).queryByRole("region", { name: "Verified active bounded probe" })).not.toBeInTheDocument();
  });

  it("shows a collection failure instead of stale probe authorization", async () => {
    renderAppWithResearchFunnel({
      collection_state: "quality_gate_failed",
      collection_node_attempt: 2,
      collection_node_max_attempts: 3,
      collection_quality_failure_reasons: [
        "Only one query family met the declared quality floor."
      ],
      lifecycle_stage: "probe_authorized",
      authorization_disposition: "probe_authorized",
      authorization_trusted: true,
      authorization_probe_allowed: true,
      integrity_status: "complete"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-warning");
    expect(within(funnel).getByText("Quality Gate Failed · attempt 2/3")).toBeInTheDocument();
    expect(within(funnel).getByText(/Quality gate · Only one query family/iu)).toBeInTheDocument();
    expect(within(funnel).getByText("Probe blocked")).toBeInTheDocument();
    expect(within(funnel).getByText("Probe Blocked")).toBeInTheDocument();
    expect(within(funnel).getByText("Probe decision blocked")).toBeInTheDocument();
    expect(within(funnel).queryByText("Probe authorized")).not.toBeInTheDocument();
    expect(within(funnel).queryByRole("region", { name: "Verified active bounded probe" })).not.toBeInTheDocument();
  });

  it.each([
    {
      failureClass: "query_quality_failure" as const,
      active: true,
      semanticReviewStatus: "complete" as const,
      reason: "Too few direct-support papers passed the query-family floor.",
      issueLabel: "Query quality",
      queryHintVisible: true
    },
    {
      failureClass: "semantic_review_operational_failure" as const,
      active: false,
      semanticReviewStatus: "operational_failure" as const,
      reason: "Semantic review failed operationally: reviewer unavailable.",
      issueLabel: "Reviewer operational failure",
      queryHintVisible: false
    },
    {
      failureClass: "semantic_review_incomplete" as const,
      active: false,
      semanticReviewStatus: "partial" as const,
      reason: "Semantic review was incomplete: pair coverage mismatch.",
      issueLabel: "Reviewer incomplete",
      queryHintVisible: false
    }
  ])("renders $failureClass collection status without reviewer-only query hints", async ({
    failureClass,
    active,
    semanticReviewStatus,
    reason,
    issueLabel,
    queryHintVisible
  }) => {
    renderAppWithResearchFunnel({
      collection_state: "quality_gate_failed",
      collection_quality_failure_reasons: [reason],
      collection_reformulation_hint: ({
        evidence_status: "query_hint_only",
        paper_evidence_allowed: false,
        active,
        failure_class: failureClass,
        feedback_applied: active,
        semantic_review_status: semanticReviewStatus,
        shared_anchor_terms: ["generic", "evaluation"],
        candidate_titles: ["Bounded query feedback title"],
        axes: [{ axis_terms: ["held", "out"] }]
      } as unknown as NonNullable<ResearchFunnelProjection["collection_reformulation_hint"]>),
      reason_codes: [failureClass]
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(within(funnel).getByText(new RegExp(`^${issueLabel}`, "iu"))).toBeInTheDocument();
    if (queryHintVisible) {
      expect(within(funnel).getByText("Query reformulation")).toBeInTheDocument();
      expect(within(funnel).getByText(/held out · Bounded query feedback title/iu)).toBeInTheDocument();
    } else {
      expect(within(funnel).queryByText("Query reformulation")).not.toBeInTheDocument();
      expect(within(funnel).queryByText(/Bounded query feedback title/iu)).not.toBeInTheDocument();
    }
  });

  it("caps collection retry display at the configured maximum", async () => {
    renderAppWithResearchFunnel({
      collection_state: "collecting",
      collection_node_attempt: 8,
      collection_node_max_attempts: 3,
      reason_codes: ["collect_artifact_generation_mismatch"]
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(within(funnel).getByText("Collecting · attempt 3/3")).toBeInTheDocument();
    expect(within(funnel).queryByText(/8\/3/u)).not.toBeInTheDocument();
    expect(within(funnel).getByText(/Generation mismatch/iu)).toBeInTheDocument();
  });

  it("renders baseline evidence readiness separately from workflow readiness", async () => {
    renderAppWithResearchFunnel({}, {
      status: "available",
      evidence_ready: true,
      trusted: true,
      comparison_count: 1,
      primary_comparison_id: "declared-comparison",
      warnings: [],
      artifact_ref: {
        label: "Baseline comparison",
        path: "baseline_comparison.json"
      }
    });

    expect(await screen.findByText("Workflow readiness")).toBeInTheDocument();
    expect(screen.getByText("Evidence readiness")).toBeInTheDocument();
    expect(screen.getByText("Comparison ready")).toBeInTheDocument();
    expect(screen.getByText("Primary comparison")).toBeInTheDocument();
    expect(screen.getByText("declared-comparison")).toBeInTheDocument();
  });

  it("renders evidence adequacy trust, paper permission, reasons, and artifact refs separately", async () => {
    renderAppWithResearchFunnel(
      {},
      {
        status: "available",
        evidence_ready: true,
        trusted: true,
        comparison_count: 1,
        primary_comparison_id: "baseline-primary",
        warnings: []
      },
      [],
      undefined,
      {
        status: "unknown",
        trusted: true,
        integrity_valid: true,
        paper_evidence_allowed: false,
        contract_present: true,
        receipt_present: true,
        assessment_present: true,
        review_reassessment_present: true,
        primary_comparison_id: "adequacy-primary",
        overall_status: "unknown",
        reason_codes: ["evidence_adequacy_uncertainty_unknown"],
        artifact_refs: [
          {
            kind: "assessment",
            label: "Evidence adequacy assessment",
            path: "evidence_adequacy_assessment.json"
          },
          {
            kind: "review_reassessment",
            label: "Review evidence reassessment",
            path: "review/evidence_adequacy_reassessment.json"
          }
        ]
      }
    );

    expect(await screen.findByText("Evidence readiness")).toBeInTheDocument();
    expect(screen.getByText("Comparison ready")).toBeInTheDocument();
    expect(screen.getByText("Evidence adequacy")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByText("Trusted yes · Integrity valid")).toBeInTheDocument();
    expect(screen.getByText("Paper evidence")).toBeInTheDocument();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Adequacy comparison")).toBeInTheDocument();
    expect(screen.getByText("adequacy-primary")).toBeInTheDocument();
    expect(screen.getByText("Adequacy reasons")).toBeInTheDocument();
    expect(screen.getByText("evidence_adequacy_uncertainty_unknown")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Evidence adequacy assessment" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Review evidence reassessment" })).toBeInTheDocument();
  });

  it("renders review assurance trust, paper eligibility, reasons, and artifact refs", async () => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      undefined,
      {
        status: "invalid",
        trusted: false,
        paper_ready_eligible: false,
        input_manifest_valid: false,
        gate_report_valid: true,
        assurance_valid: false,
        handoff_valid: false,
        model_review_bundle_valid: false,
        required_for_paper_ready: true,
        reason_codes: ["review_input_changed:result_analysis.json"],
        artifact_refs: [{
          kind: "input_manifest",
          label: "Review input manifest",
          path: "review/review_input_manifest.json"
        }]
      }
    );

    const assuranceLabel = await screen.findByText("Review assurance");
    const assuranceCard = assuranceLabel.closest("article");
    expect(assuranceCard).not.toBeNull();
    expect(within(assuranceCard!).getByText("Invalid")).toBeInTheDocument();
    expect(within(assuranceCard!).getByText("Paper blocked · Manifest invalid · Gate valid · Handoff invalid")).toBeInTheDocument();
    expect(screen.getByText("review_input_changed:result_analysis.json")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Review input manifest" })).toBeInTheDocument();
  });

  it("distinguishes review not started from invalid assurance", async () => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      undefined,
      {
        status: "not_started",
        trusted: false,
        paper_ready_eligible: false,
        input_manifest_valid: false,
        gate_report_valid: false,
        assurance_valid: false,
        handoff_valid: false,
        model_review_bundle_valid: false,
        required_for_paper_ready: false,
        reason_codes: [],
        artifact_refs: []
      }
    );

    const assuranceLabel = await screen.findByText("Review assurance");
    const assuranceCard = assuranceLabel.closest("article");
    expect(assuranceCard).not.toBeNull();
    expect(within(assuranceCard!).getByText("Not started")).toBeInTheDocument();
    expect(within(assuranceCard!).getByText("Review has not started.")).toBeInTheDocument();
  });

  it("keeps the latest applied backtrack reason visible from the compact run index", async () => {
    renderAppWithResearchFunnel({}, undefined, [], {
      action: "backtrack_to_hypotheses",
      sourceNode: "design_experiments",
      fromNode: "design_experiments",
      toNode: "generate_hypotheses",
      reason: "The reviewer gate found an unresolved comparison mismatch.",
      confidence: 0.92,
      autoExecutable: true,
      appliedAt: "2026-01-01T00:00:00.000Z"
    });

    const notice = await screen.findByRole("status", { name: "Last applied backtrack" });
    expect(within(notice).getByText("design_experiments")).toBeInTheDocument();
    expect(within(notice).getByText("generate_hypotheses")).toBeInTheDocument();
    expect(within(notice).getByText(/unresolved comparison mismatch/iu)).toBeInTheDocument();
  });

  it("shows complete persisted diagnostics when partial funnel evidence blocks a probe", async () => {
    renderAppWithResearchFunnel({
      candidate_count: 6,
      probe_candidate_count: 1,
      probe_candidate_ids: ["candidate-65c21f"],
      probe_candidate_statements: ["Evaluate the declared candidate under the bounded protocol."],
      cluster_count: 2,
      lifecycle_stage: "discovery",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: false,
      reason_codes: [
        "baseline_evidence_missing",
        "coverage_below_floor",
        "claim_map_incomplete",
        "fourth_reason_hidden"
      ],
      gates: [{
        scope: "topic_portfolio",
        code: "cluster_coverage_below_floor",
        status: "block",
        message: "The portfolio does not cover enough independent evidence clusters.",
        trusted: true
      }],
      dissent: [{
        source: "design_panel",
        candidate_id: "candidate-plan",
        reviewer_id: "statistical_reviewer",
        reviewer_label: "Statistical reviewer",
        hard_block: true,
        summary: "The comparison lacks a prespecified uncertainty check.",
        findings: ["Add an uncertainty-aware decision rule."],
        trusted: true
      }],
      literature_queries: [{
        query: "controlled evaluation reliability",
        source: "deterministic_query",
        source_reason: "planner_timeout_fallback",
        reason: "brief_topic",
        fallback: true,
        filters_relaxed: false,
        allocated_limit: 20,
        fetched: 12
      }],
      query_fallback_used: true,
      query_fallback_reasons: ["planner_timeout_fallback"],
      hashes: {
        gap_map: "gap-hash"
      },
      artifact_refs: [],
      integrity_status: "partial"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-warning");
    expect(within(funnel).getByText("Discovery in progress")).toBeInTheDocument();
    expect(within(funnel).getByText("Partial")).toBeInTheDocument();
    expect(within(funnel).getByText("Blocked")).toHaveClass("status-warning");
    expect(within(funnel).getByText("baseline_evidence_missing")).toBeInTheDocument();
    expect(within(funnel).getByText("coverage_below_floor")).toBeInTheDocument();
    expect(within(funnel).getByText("claim_map_incomplete")).toBeInTheDocument();
    expect(within(funnel).getByText("fourth_reason_hidden")).toBeInTheDocument();
    expect(within(funnel).getByText("cluster_coverage_below_floor")).toBeInTheDocument();
    expect(within(funnel).getByText("The portfolio does not cover enough independent evidence clusters.")).toBeInTheDocument();
    expect(within(funnel).getByText("Statistical reviewer")).toBeInTheDocument();
    expect(within(funnel).getByText("The comparison lacks a prespecified uncertainty check.")).toBeInTheDocument();
    expect(within(funnel).getByText("deterministic_query")).toBeInTheDocument();
    expect(within(funnel).getByText("Literature query provenance").parentElement).toHaveTextContent(
      "planner_timeout_fallback"
    );
  });

  it("uses the strongest warning tone for a funnel integrity mismatch", async () => {
    const untrustedContractHash = "f".repeat(64);
    renderAppWithResearchFunnel({
      candidate_count: 4,
      probe_candidate_count: 1,
      probe_candidate_ids: ["candidate-65c21f"],
      probe_candidate_statements: [],
      active_candidate_id: "candidate-untrusted",
      active_topic_id: "topic-untrusted",
      active_candidate_hash: "e".repeat(64),
      active_primary_metric: "primary_score",
      active_metric_unit: "proportion",
      active_metric_scale: "proportion",
      active_metric_direction: "maximize",
      active_effect_criterion: {
        basis: "delta_vs_reference",
        magnitude: 0.01,
        scale: "proportion",
        inclusive: false
      },
      active_objective_raw: "untrusted-objective-binding",
      active_meaningful_effect: "Any observed change.",
      active_evidence_stage: "bounded_probe",
      active_deferred_candidate_ids: [],
      lifecycle_stage: "invalid_chain",
      authorization_disposition: "probe_authorized",
      authorization_probe_allowed: false,
      invalid_chain_blockers: ["topic_decision_hash_mismatch"],
      reason_codes: ["topic_decision_hash_mismatch"],
      hashes: {
        gap_map: "gap-hash",
        topic_decision: "unexpected-decision-hash",
        active_topic_probe_contract: untrustedContractHash
      },
      artifact_refs: [
        {
          label: "Active topic probe contract",
          path: "design_experiments_panel/active_topic_probe_contract.json"
        }
      ],
      integrity_status: "mismatch"
    });

    const funnel = await screen.findByRole("region", { name: "Research topic funnel" });
    expect(funnel).toHaveClass("is-danger");
    expect(within(funnel).getByText("Invalid artifact chain")).toBeInTheDocument();
    expect(within(funnel).getAllByText("topic_decision_hash_mismatch")).toHaveLength(2);
    expect(within(funnel).queryByText("Bounded probe candidates")).not.toBeInTheDocument();
    expect(within(funnel).queryByRole("region", { name: "Verified active bounded probe" })).not.toBeInTheDocument();
    expect(within(funnel).queryByText("candidate-untrusted")).not.toBeInTheDocument();
    expect(within(funnel).queryByText(untrustedContractHash)).not.toBeInTheDocument();
  });

  it("keeps inspected and active runs separate until the operator activates the context", async () => {
    const runs = [makeWebRun("run-1", "Active run"), makeWebRun("run-2", "Inspected run")];
    let activeRunId = "run-1";
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "topic",
            defaultConstraints: [],
            defaultObjectiveMetric: "metric"
          },
          session: { activeRunId, busy: false, logs: [], canCancel: false },
          activeRunId,
          runs,
          jobs: { generated_at: "2026-07-25T00:00:00.000Z", runs: [], top_failures: [] },
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 });
      }
      if (url === "/api/session/input") {
        expect(JSON.parse(String(init?.body))).toEqual({ text: "/run run-2" });
        activeRunId = "run-2";
        return new Response(JSON.stringify({
          session: { activeRunId, busy: false, logs: ["Selected run-2."], canCancel: false }
        }), { status: 200 });
      }
      if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      const detail = runs.find((run) => url === `/api/runs/${run.id}`);
      if (detail) return new Response(JSON.stringify({ run: detail }), { status: 200 });
      const artifactRun = runs.find((run) => url === `/api/runs/${run.id}/artifacts`);
      if (artifactRun) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      const checkpointRun = runs.find((run) => url === `/api/runs/${run.id}/checkpoints`);
      if (checkpointRun) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      const literatureRun = runs.find((run) => url === `/api/runs/${run.id}/literature`);
      if (literatureRun) return new Response(JSON.stringify({ literature: emptyLiterature(literatureRun.id) }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    await waitFor(() => expect(screen.getByText("Actions target this run")).toBeInTheDocument());
    const [retryButton] = await screen.findAllByRole("button", { name: "Retry" });
    fireEvent.click(retryButton!);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(
      /Action: Retry current node[\s\S]*Run: Active run[\s\S]*Run ID: run-1[\s\S]*Node: Review/u
    ));
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/actions/") && init?.method === "POST")).toHaveLength(0);

    fireEvent.change(screen.getByRole("combobox", { name: "Inspect run" }), { target: { value: "run-2" } });

    await waitFor(() => {
      expect(screen.getByText("Inspection only")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Activate inspected run" })).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Activate inspected run" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session/input",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "/run run-2" }) })
      );
      expect(screen.getByText("Actions target this run")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    });
  });

  it("ignores a late run response after the operator inspects another run", async () => {
    const runs = [makeWebRun("run-1", "Delayed run"), makeWebRun("run-2", "Current inspection")];
    let resolveDelayedRun: ((response: Response) => void) | undefined;
    const delayedRun = new Promise<Response>((resolve) => {
      resolveDelayedRun = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "topic",
            defaultConstraints: [],
            defaultObjectiveMetric: "metric"
          },
          session: { activeRunId: "run-1", busy: false, logs: [], canCancel: false },
          activeRunId: "run-1",
          runs,
          jobs: { generated_at: "2026-07-25T00:00:00.000Z", runs: [], top_failures: [] },
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 });
      }
      if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      if (url === "/api/runs/run-1") return delayedRun;
      if (url === "/api/runs/run-2") return new Response(JSON.stringify({ run: runs[1] }), { status: 200 });
      const artifactRun = runs.find((run) => url === `/api/runs/${run.id}/artifacts`);
      if (artifactRun) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      const checkpointRun = runs.find((run) => url === `/api/runs/${run.id}/checkpoints`);
      if (checkpointRun) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      const literatureRun = runs.find((run) => url === `/api/runs/${run.id}/literature`);
      if (literatureRun) return new Response(JSON.stringify({ literature: emptyLiterature(literatureRun.id) }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    const inspectRun = await screen.findByRole("combobox", { name: "Inspect run" });
    fireEvent.change(inspectRun, { target: { value: "run-2" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Current inspection" })).toBeInTheDocument());

    resolveDelayedRun?.(new Response(JSON.stringify({ run: runs[0] }), { status: 200 }));
    await Promise.resolve();

    expect(screen.getByRole("heading", { name: "Current inspection" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Delayed run" })).not.toBeInTheDocument();
  });

  it("ignores an older bootstrap response that arrives after a newer refresh", async () => {
    const initialRun = makeWebRun("run-initial", "Initial state");
    const staleRun = makeWebRun("run-stale", "Stale bootstrap state");
    const freshRun = makeWebRun("run-fresh", "Fresh bootstrap state");
    const runs = [initialRun, staleRun, freshRun];
    let bootstrapListener: (() => void) | undefined;
    let resolveStaleBootstrap: ((response: Response) => void) | undefined;
    const staleBootstrap = new Promise<Response>((resolve) => {
      resolveStaleBootstrap = resolve;
    });
    const bootstrapPayload = (run: ReturnType<typeof makeWebRun>) => ({
      configured: true,
      setupDefaults: {
        projectName: "AutoLabOS",
        defaultTopic: "topic",
        defaultConstraints: [],
        defaultObjectiveMetric: "metric"
      },
      session: { activeRunId: run.id, busy: false, logs: [], canCancel: false },
      activeRunId: run.id,
      runs: [run],
      jobs: { generated_at: "2026-01-01T00:00:00.000Z", runs: [], top_failures: [] },
      jobQueue: { running: [], waiting: [], stalled: [] }
    });
    let bootstrapCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        bootstrapCalls += 1;
        if (bootstrapCalls === 1) {
          return new Response(JSON.stringify(bootstrapPayload(initialRun)), { status: 200 });
        }
        if (bootstrapCalls === 2) {
          return staleBootstrap;
        }
        return new Response(JSON.stringify(bootstrapPayload(freshRun)), { status: 200 });
      }
      if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      const detail = runs.find((run) => url === `/api/runs/${run.id}`);
      if (detail) return new Response(JSON.stringify({ run: detail }), { status: 200 });
      const artifactRun = runs.find((run) => url === `/api/runs/${run.id}/artifacts`);
      if (artifactRun) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      const checkpointRun = runs.find((run) => url === `/api/runs/${run.id}/checkpoints`);
      if (checkpointRun) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      const literatureRun = runs.find((run) => url === `/api/runs/${run.id}/literature`);
      if (literatureRun) return new Response(JSON.stringify({ literature: emptyLiterature(literatureRun.id) }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      addEventListener(type: string, listener: () => void) {
        if (type === "bootstrap") bootstrapListener = listener;
      }
      close() {}
    } as unknown as typeof EventSource);
    render(<App />);

    await screen.findByRole("heading", { name: "Initial state" });
    bootstrapListener?.();
    bootstrapListener?.();
    await screen.findByRole("heading", { name: "Fresh bootstrap state" });

    resolveStaleBootstrap?.(
      new Response(JSON.stringify(bootstrapPayload(staleRun)), { status: 200 })
    );
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Fresh bootstrap state" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Stale bootstrap state" })).not.toBeInTheDocument();
    });
  });
});

function renderAppWithResearchFunnel(
  overrides: Partial<ResearchFunnelProjection>,
  evidenceReadiness?: RunJobProjection["evidence_readiness"],
  transitionHistory: NonNullable<RunRecord["graph"]["transitionHistory"]> = [],
  lastAppliedTransition?: NonNullable<RunRecord["graph"]["lastAppliedTransition"]>,
  evidenceAdequacy?: RunJobProjection["evidence_adequacy"],
  reviewAssurance?: RunJobProjection["review_assurance"]
): void {
  const funnel: ResearchFunnelProjection = {
    research_mode: "topic_discovery",
    lifecycle_stage: "discovery",
    bounded_probe_paper_evidence_allowed: false,
    collection_state: "unmeasured",
    collection_quality_failure_reasons: [],
    gap_evidence_audit: {
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
    },
    candidate_count: 0,
    cluster_count: 0,
    candidate_prior_search: {
      status: "unmeasured",
      trusted: false,
      completed_rounds: 0,
      max_rounds: 0,
      current_receipt_status: "unmeasured",
      candidate_count: 0,
      selected_candidate_count: 0,
      broad_lane_attempt_count: 0,
      recent_lane_attempt_count: 0,
      fetched_count: 0,
      selected_paper_count: 0,
      covered_candidate_ids: [],
      reason_codes: [],
      artifact_refs: []
    },
    estimator_feasibility: {
      status: "unmeasured",
      trusted: false,
      execution_authorized: false,
      reason_codes: [],
      artifact_refs: []
    },
    topic_memory: {
      status: "unmeasured",
      trusted: false,
      record_count: 0,
      blocked_candidate_count: 0,
      reentry_required_count: 0,
      reentry_allowed_count: 0
    },
    diagnostics_trusted: false,
    authorization_trusted: false,
    probe_candidate_count: 0,
    probe_candidate_ids: [],
    probe_candidate_statements: [],
    authorization_disposition: "unmeasured",
    authorization_probe_allowed: false,
    effective_execution_authorized: false,
    execution_authorization: {
      status: "unmeasured",
      trusted: false,
      authorized: false,
      base_funnel_authorized: false,
      candidate_prior_search_authorized: false,
      estimator_authorized: false,
      required_candidate_ids: [],
      covered_candidate_ids: [],
      reason_codes: []
    },
    outcome_gate: {
      status: "unmeasured",
      trusted: false,
      reason_codes: []
    },
    followup_handoff: {
      status: "unmeasured",
      trusted: false
    },
    review_gate: {
      status: "unmeasured",
      trusted: false,
      paper_drafting_allowed: false,
      reason_codes: []
    },
    invalid_chain_blockers: [],
    reason_codes: [],
    gates: [],
    dissent: [],
    literature_queries: [],
    query_fallback_used: false,
    query_fallback_reasons: [],
    hashes: {},
    artifact_refs: [],
    integrity_status: "unmeasured",
    ...overrides
  };
  const baseRun = makeWebRun("funnel-run", "Research funnel run");
  const run = {
    ...baseRun,
    graph: {
      ...baseRun.graph,
      transitionHistory,
      ...(lastAppliedTransition ? { lastAppliedTransition } : {})
    },
    topic: "Configured research scope"
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/bootstrap") {
      return new Response(JSON.stringify({
        configured: true,
        setupDefaults: {
          projectName: "AutoLabOS",
          defaultTopic: "topic",
          defaultConstraints: [],
          defaultObjectiveMetric: "metric"
        },
        session: { activeRunId: run.id, busy: false, logs: [], canCancel: false },
        activeRunId: run.id,
        runs: [run],
        jobs: {
          generated_at: "2026-07-26T00:00:00.000Z",
          runs: [{
            run_id: run.id,
            title: run.title,
            current_node: "review",
            lifecycle_status: "paused",
            approval_mode: "hybrid",
            last_event_at: run.updatedAt,
            recommended_next_action: "waiting_for_input",
            analysis_ready: true,
            review_ready: false,
            paper_ready: false,
            research_funnel: funnel,
            evidence_readiness: evidenceReadiness,
            evidence_adequacy: evidenceAdequacy,
            review_assurance: reviewAssurance
          }],
          top_failures: []
        },
        jobQueue: { running: [], waiting: [], stalled: [] }
      }), { status: 200 });
    }
    if (url === "/api/jobs") {
      return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
    }
    if (url.startsWith("/api/exploration/status")) {
      return new Response(JSON.stringify({ enabled: false }), { status: 200 });
    }
    if (url === "/api/doctor") {
      return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
    }
    if (url === "/api/knowledge") {
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }
    if (url === `/api/runs/${run.id}/artifacts`) {
      return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
    }
    if (url === `/api/runs/${run.id}/checkpoints`) {
      return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
    }
    if (url === `/api/runs/${run.id}/literature`) {
      return new Response(JSON.stringify({ literature: emptyLiterature(run.id) }), { status: 200 });
    }
    if (url === `/api/runs/${run.id}`) {
      return new Response(JSON.stringify({ run }), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "EventSource",
    class {
      addEventListener() {}
      close() {}
    } as unknown as typeof EventSource
  );
  render(<App />);
}

function makeWebRun(id: string, title: string) {
  const updatedAt = "2026-07-25T00:00:00.000Z";
  const nodeIds = [
    "collect_papers", "analyze_papers", "generate_hypotheses", "design_experiments",
    "implement_experiments", "run_experiments", "analyze_results", "figure_audit", "review", "write_paper"
  ];
  return {
    id,
    title,
    topic: "topic",
    constraints: [],
    objectiveMetric: "metric",
    status: "paused",
    currentNode: "review",
    latestSummary: "Review requires an operator decision.",
    updatedAt,
    graph: {
      currentNode: "review",
      checkpointSeq: 8,
      retryCounters: {},
      rollbackCounters: {},
      nodeStates: Object.fromEntries(nodeIds.map((node) => [node, {
        status: node === "review" ? "needs_approval" : node === "write_paper" ? "pending" : "completed",
        updatedAt
      }]))
    }
  };
}

function emptyLiterature(runId: string) {
  return {
    version: 1,
    run_id: runId,
    updated_at: "2026-03-10T10:00:00.000Z",
    corpus: {
      paper_count: 0,
      papers_with_pdf: 0,
      missing_pdf_count: 0,
      papers_with_bibtex: 0,
      enriched_bibtex_count: 0,
      top_venues: []
    },
    citations: {
      total: 0,
      average: 0
    },
    enrichment: {
      pdf_recovered: 0,
      bibtex_enriched: 0
    },
    analysis: {
      summary_count: 0,
      evidence_count: 0,
      covered_paper_count: 0,
      full_text_summary_count: 0,
      abstract_summary_count: 0
    },
    artifacts: {
      literature_index_path: `.autolabos/runs/${runId}/literature_index.json`,
      corpus_path: `.autolabos/runs/${runId}/corpus.jsonl`,
      bibtex_path: `.autolabos/runs/${runId}/bibtex.bib`,
      collect_result_path: `.autolabos/runs/${runId}/collect_result.json`,
      summaries_path: `.autolabos/runs/${runId}/paper_summaries.jsonl`,
      evidence_path: `.autolabos/runs/${runId}/evidence_store.jsonl`
    },
    warnings: []
  };
}

function populatedLiterature(runId: string) {
  return {
    ...emptyLiterature(runId),
    corpus: {
      paper_count: 40,
      papers_with_pdf: 32,
      missing_pdf_count: 8,
      papers_with_bibtex: 35,
      enriched_bibtex_count: 12,
      top_venues: ["NeurIPS (8)", "ICLR (5)", "ACL (4)"],
      year_range: {
        min: 2021,
        max: 2026
      }
    },
    citations: {
      total: 800,
      average: 20,
      top_paper: {
        title: "Top cited paper",
        citation_count: 180
      }
    },
    enrichment: {
      bibtex_mode: "hybrid",
      pdf_recovered: 7,
      bibtex_enriched: 12,
      status: "completed"
    },
    analysis: {
      summary_count: 18,
      evidence_count: 126,
      covered_paper_count: 18,
      full_text_summary_count: 14,
      abstract_summary_count: 4
    },
    warnings: ["8 collected paper(s) are still missing PDF links."]
  };
}
