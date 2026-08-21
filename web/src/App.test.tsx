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

async function openCommandPanel(): Promise<HTMLElement> {
  const triggers = await screen.findAllByRole("button", { name: /^Open command panel/ });
  const trigger = triggers.find((candidate) => candidate.hasAttribute("aria-keyshortcuts")) ?? triggers[0]!;
  trigger.focus();
  fireEvent.click(trigger);
  return await screen.findByRole("dialog");
}

async function openDetails(destination = "Run details"): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: "Details" });
  expect(trigger).not.toHaveAttribute("aria-haspopup");
  trigger.focus();
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute("aria-expanded", "true");
  const destinations = await screen.findByRole("navigation", { name: "Run details destinations" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  fireEvent.click(within(destinations).getByRole("button", { name: destination }));
  return await screen.findByRole("dialog");
}

async function openLiveActivity(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: /^Open live activity\./ });
  trigger.focus();
  fireEvent.click(trigger);
  return await screen.findByRole("complementary", { name: "Live activity" });
}

async function selectInspectorTab(label: string): Promise<HTMLElement> {
  const dialog = screen.queryByRole("dialog") ?? await openCommandPanel();
  fireEvent.click(within(dialog).getByRole("tab", { name: label }));
  return dialog;
}

async function openResearchFunnel(): Promise<HTMLElement> {
  const dialog = await openDetails("Run details");
  return await within(dialog).findByRole("region", { name: "Research topic funnel" });
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
                    run_id: "run-stalled-validation-3",
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
                  run_id: "run-stalled-validation-3",
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

    const activityDrawer = await openLiveActivity();
    fireEvent.click(within(activityDrawer).getByText("Operations"));

    await waitFor(() => {
      expect(within(activityDrawer).getByText("Background jobs")).toBeInTheDocument();
      expect(within(activityDrawer).getByText("Live watch")).toBeInTheDocument();
      expect(within(activityDrawer).getByText("Exploration engine")).toBeInTheDocument();
      expect(within(activityDrawer).getByRole("table", { name: "Live watch jobs" })).toBeInTheDocument();
      expect(within(activityDrawer).getByText("Running (1)")).toBeInTheDocument();
      expect(within(activityDrawer).getByText("Waiting (1)")).toBeInTheDocument();
      expect(within(activityDrawer).getByText("Stalled (1)")).toBeInTheDocument();
      expect(within(activityDrawer).getAllByText(/Recommended action: manual review\./i).length).toBeGreaterThanOrEqual(2);
      expect(within(activityDrawer).getByText(/Current stage:/i)).toBeInTheDocument();
      expect(within(activityDrawer).getByText(/Best defensible:/i)).toBeInTheDocument();
    });

    const liveWatchCard = within(activityDrawer).getByText("Live watch").closest("section");
    const backgroundJobsCard = within(activityDrawer).getByText("Background jobs").closest("section");
    expect(liveWatchCard).not.toBeNull();
    expect(backgroundJobsCard).not.toBeNull();
    const liveWatchTable = within(liveWatchCard as HTMLElement).getByRole("table", { name: "Live watch jobs" });
    expect(within(liveWatchTable).getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "Run",
      "Current node",
      "Node status",
      "Queue",
      "Elapsed",
      "Recommended action"
    ]);
    expect(within(liveWatchTable).getByRole("row", { name: /run-2 Review Needs approval Waiting 10m No recommendation/i })).toBeInTheDocument();
    const stalledRow = within(liveWatchTable).getByRole("row", {
      name: /run-stalled-validation-3 Run experiments Running Stalled 1h Recommended action: manual review\./i
    });
    expect(stalledRow).toHaveClass("is-warning");
    expect(within(liveWatchTable).getByText("run-stalled-validation-3")).toBeInTheDocument();
    expect(within(backgroundJobsCard as HTMLElement).getByText("run-2")).toBeInTheDocument();
    expect(within(backgroundJobsCard as HTMLElement).getByText("run-stalled-validation-3")).toBeInTheDocument();
  });

  it("keeps Operations and activity links in the mobile modal tab order and wraps at the boundary", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === "(max-width: 1320px)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true)
    } as unknown as MediaQueryList)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
            session: { busy: false, logs: [], canCancel: false },
            runs: [],
            jobs: { generated_at: "2026-08-09T00:00:00.000Z", runs: [], top_failures: [] },
            jobQueue: { running: [], waiting: [], stalled: [] }
          }), { status: 200 });
        }
        if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
        if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
        if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    const trigger = await screen.findByRole("button", { name: /^Open live activity\./ });
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = await screen.findByRole("dialog", { name: "Live activity" });
    const close = within(drawer).getByRole("button", { name: "Close live activity" });
    const operations = within(drawer).getByText("Operations");
    const viewLogs = within(drawer).getByRole("button", { name: "View logs" });
    const viewArtifacts = within(drawer).getByRole("button", { name: "View artifacts" });
    await waitFor(() => expect(close).toHaveFocus());
    expect(operations.tagName).toBe("SUMMARY");

    const focusable = Array.from(drawer.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "summary",
      "[tabindex]:not([tabindex='-1'])"
    ].join(","))).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    expect(focusable).toEqual([close, operations, viewLogs, viewArtifacts]);

    viewArtifacts.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(viewArtifacts).toHaveFocus();
  });

  it("exposes Inspector views as keyboard-navigable tabs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/bootstrap")) {
          return new Response(JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "topic",
              defaultConstraints: [],
              defaultObjectiveMetric: "metric"
            },
            session: { busy: false, logs: [], canCancel: false },
            runs: [],
            jobs: { generated_at: "2026-04-01T12:00:00.000Z", runs: [], top_failures: [] },
            jobQueue: { running: [], waiting: [], stalled: [] }
          }), { status: 200 });
        }
        if (url.includes("/api/doctor")) {
          return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
        }
        if (url.includes("/api/knowledge")) {
          return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        }
        if (url.includes("/api/jobs")) {
          return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
        }
        if (url.includes("/api/exploration/status")) {
          return new Response(JSON.stringify({ enabled: false }), { status: 200 });
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

    const commandTrigger = (await screen.findAllByRole("button", { name: /^Open command panel/ }))
      .find((candidate) => candidate.hasAttribute("aria-keyshortcuts"))!;
    const dialog = await openCommandPanel();
    const tablist = within(dialog).getByRole("tablist", { name: "Inspector views" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs).toHaveLength(8);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Run details",
      "Live logs",
      "Artifacts",
      "Checkpoints",
      "Knowledge",
      "Metadata",
      "Workspace",
      "Doctor"
    ]);
    const logsTab = within(tablist).getByRole("tab", { name: "Live logs" });
    expect(logsTab).toHaveAttribute("aria-selected", "true");
    expect(logsTab).toHaveAttribute("tabindex", "0");
    expect(tabs.filter((tab) => tab.getAttribute("tabindex") === "0")).toHaveLength(1);
    const logsPanel = within(dialog).getByRole("tabpanel", { name: "Live logs" });
    expect(logsTab).toHaveAttribute("aria-controls", logsPanel.id);
    expect(logsPanel).toHaveAttribute("aria-labelledby", logsTab.id);

    logsTab.focus();
    fireEvent.keyDown(logsTab, { key: "ArrowRight" });
    const artifactsTab = within(tablist).getByRole("tab", { name: "Artifacts" });
    expect(artifactsTab).toHaveFocus();
    expect(artifactsTab).toHaveAttribute("aria-selected", "true");
    expect(within(dialog).getByRole("tabpanel", { name: "Artifacts" })).toBeInTheDocument();

    fireEvent.keyDown(artifactsTab, { key: "End" });
    const doctorTab = within(tablist).getByRole("tab", { name: "Doctor" });
    expect(doctorTab).toHaveFocus();
    expect(doctorTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(doctorTab, { key: "ArrowRight" });
    const detailsTab = within(tablist).getByRole("tab", { name: "Run details" });
    expect(detailsTab).toHaveFocus();
    expect(detailsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(detailsTab, { key: "End" });
    fireEvent.keyDown(doctorTab, { key: "Home" });
    expect(detailsTab).toHaveFocus();
    expect(detailsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(commandTrigger).toHaveFocus();
    });

    const reopenedDialog = await openCommandPanel();
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "Close run details" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(commandTrigger).toHaveFocus();
    });
  });

  it("opens Run details through a disclosure and restores focus when the modal closes", async () => {
    renderAppWithResearchFunnel({});

    const detailsTrigger = await screen.findByRole("button", { name: "Details" });
    expect(detailsTrigger).not.toHaveAttribute("aria-haspopup");
    detailsTrigger.focus();
    fireEvent.click(detailsTrigger);

    const destinations = await screen.findByRole("navigation", { name: "Run details destinations" });
    expect(detailsTrigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(within(destinations).getAllByRole("button")).toHaveLength(8);
    fireEvent.click(within(destinations).getByRole("button", { name: "Run details" }));

    const dialog = await screen.findByRole("dialog", { name: "Run details" });
    const heading = within(dialog).getByRole("heading", { name: "Run details" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(within(dialog).getByRole("tablist", { name: "Inspector views" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("tab")).toHaveLength(8);
    expect(within(dialog).getByRole("heading", { name: "Evidence, gates, and next moves" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: "Prompt" })).not.toBeInTheDocument();

    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>([
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])"
    ].join(","))).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    expect(focusable.length).toBeGreaterThan(1);
    const firstFocusable = focusable[0]!;
    const lastFocusable = focusable[focusable.length - 1]!;

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastFocusable).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(firstFocusable).toHaveFocus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    expect(within(dialog).getByRole("tab", { name: "Live logs" })).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(detailsTrigger).toHaveFocus();
    });

    const reopenedDialog = await openDetails("Run details");
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "Close run details" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(detailsTrigger).toHaveFocus();
    });
  });

  it("returns focus to the New run invoker when the composer is closed", async () => {
    renderAppWithResearchFunnel({});

    const newRunTrigger = await screen.findByRole("button", { name: "New run" });
    newRunTrigger.focus();
    fireEvent.click(newRunTrigger);

    const workspaceHeading = await screen.findByRole("heading", { name: "Create research run" });
    const workspace = workspaceHeading.closest("section");
    expect(workspace).not.toBeNull();
    await waitFor(() => expect(workspace).toHaveFocus());
    fireEvent.click(within(workspace!).getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Create research run" })).not.toBeInTheDocument();
      expect(newRunTrigger).toHaveFocus();
      expect(newRunTrigger).toHaveAccessibleName("New run");
    });
  });

  it("returns focus to the persistent New run control when the empty-state invoker is replaced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/bootstrap") {
          return new Response(JSON.stringify({
            configured: true,
            setupDefaults: {
              projectName: "AutoLabOS",
              defaultTopic: "configured research topic",
              defaultConstraints: ["bounded runtime"],
              defaultObjectiveMetric: "primary score"
            },
            session: { busy: false, logs: [], canCancel: false },
            runs: [],
            jobs: { generated_at: "2026-04-01T12:00:00.000Z", runs: [], top_failures: [] },
            jobQueue: { running: [], waiting: [], stalled: [] }
          }), { status: 200 });
        }
        if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
        if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
        if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
        throw new Error(`Unexpected fetch: ${url}`);
      })
    );
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    const emptyStateTrigger = await screen.findByRole("button", { name: "Create research run" });
    emptyStateTrigger.focus();
    fireEvent.click(emptyStateTrigger);

    const workspace = await screen.findByRole("region", { name: "Create research run" });
    await waitFor(() => expect(workspace).toHaveFocus());
    fireEvent.click(within(workspace).getByRole("button", { name: "Close" }));

    const persistentTrigger = await screen.findByRole("button", { name: "New run" });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Create research run" })).not.toBeInTheDocument();
      expect(persistentTrigger).toHaveFocus();
    });
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
    expect(within(codexChatSection as HTMLElement).getAllByRole("combobox")[0]).toHaveValue("gpt-5.6-terra");
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

    await selectInspectorTab("Workspace");

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

    await selectInspectorTab("Workspace");

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

    await selectInspectorTab("Doctor");

    await waitFor(() => {
      expect(screen.getByText("experiment-web-restriction")).toBeInTheDocument();
      expect(screen.getByText("WARN")).toBeInTheDocument();
      expect(screen.getByText(/network dependency for logging/i)).toBeInTheDocument();
      expect(screen.getByText("Readiness profile")).toBeInTheDocument();
      expect(screen.getByText("openai_api / responses_api_pdf")).toBeInTheDocument();
      expect(screen.getByText("attempt_snapshot_restore")).toBeInTheDocument();
    });
  });

  it("runs the live Codex doctor check only after an explicit click", async () => {
    const privateProviderOutput = "PRIVATE_PROVIDER_OUTPUT_MUST_NOT_RENDER";
    let resolveProbe!: (response: Response) => void;
    const pendingProbe = new Promise<Response>((resolve) => {
      resolveProbe = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return Promise.resolve(new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "configured research topic",
            defaultConstraints: ["declared literature scope"],
            defaultObjectiveMetric: "configured evaluation metric"
          },
          configSummary: {
            projectName: "AutoLabOS",
            workflowMode: "agent_approval",
            approvalMode: "minimal",
            llmMode: "codex_chatgpt_only",
            pdfMode: "codex_text_image_hybrid",
            researchBackendModel: "configured-research-model",
            chatModel: "configured-chat-model",
            experimentModel: "configured-experiment-model"
          },
          session: { busy: false, logs: [], canCancel: false },
          runs: [],
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 }));
      }
      if (url === "/api/doctor") {
        return Promise.resolve(new Response(JSON.stringify({
          configured: true,
          checks: [{
            name: "workspace-layout",
            ok: true,
            status: "ok",
            detail: "Workspace layout is ready."
          }]
        }), { status: 200 }));
      }
      if (url === "/api/doctor/provider-probe") {
        return pendingProbe;
      }
      if (url === "/api/knowledge") {
        return Promise.resolve(new Response(JSON.stringify({ entries: [] }), { status: 200 }));
      }
      if (url === "/api/jobs") {
        return Promise.resolve(new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 }));
      }
      if (url.startsWith("/api/exploration/status")) {
        return Promise.resolve(new Response(JSON.stringify({ enabled: false }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
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
      expect(screen.getByRole("button", { name: /^Open command panel/ })).toBeInTheDocument();
      expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/doctor")).toHaveLength(1);
    });
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/doctor/provider-probe")).toHaveLength(0);

    await selectInspectorTab("Doctor");

    const liveCheckButton = await screen.findByRole("button", { name: "Run live Codex chat check" });
    expect(screen.getByText(/one fixed non-user prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/may use provider quota/i)).toBeInTheDocument();
    expect(screen.getByText(/provider output is not stored/i)).toBeInTheDocument();
    expect(liveCheckButton).toBeEnabled();

    fireEvent.click(liveCheckButton);

    await waitFor(() => {
      const probeCalls = fetchMock.mock.calls.filter(([input]) => String(input) === "/api/doctor/provider-probe");
      expect(probeCalls).toHaveLength(1);
      expect(probeCalls[0]?.[1]).toEqual(expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ confirm: true })
      }));
      expect(JSON.parse(String(probeCalls[0]?.[1]?.body))).toEqual({ confirm: true });
      expect(liveCheckButton).toBeDisabled();
    });

    resolveProbe(new Response(JSON.stringify({
      configured: true,
      checks: [{
        name: "codex-chat-provider-compatibility",
        ok: true,
        status: "ok",
        detail: "Configured Codex chat provider accepted the fixed compatibility probe."
      }],
      providerOutput: privateProviderOutput
    }), { status: 200 }));

    await waitFor(() => {
      expect(screen.getByText("codex-chat-provider-compatibility")).toBeInTheDocument();
      expect(screen.getByText(/accepted the fixed compatibility probe/i)).toBeInTheDocument();
      expect(liveCheckButton).toBeEnabled();
    });
    expect(screen.queryByText("workspace-layout")).not.toBeInTheDocument();
    expect(screen.queryByText(privateProviderOutput)).not.toBeInTheDocument();
  });

  it("hides the live provider doctor action outside Codex modes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "configured research topic",
            defaultConstraints: ["declared literature scope"],
            defaultObjectiveMetric: "configured evaluation metric"
          },
          configSummary: {
            projectName: "AutoLabOS",
            workflowMode: "agent_approval",
            approvalMode: "minimal",
            llmMode: "openai_api",
            pdfMode: "responses_api_pdf",
            researchBackendModel: "configured-research-model",
            chatModel: "configured-chat-model",
            experimentModel: "configured-experiment-model"
          },
          session: { busy: false, logs: [], canCancel: false },
          runs: [],
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 });
      }
      if (url === "/api/doctor") {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url === "/api/knowledge") {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === "/api/jobs") {
        return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      }
      if (url.startsWith("/api/exploration/status")) {
        return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
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

    await selectInspectorTab("Doctor");

    expect(screen.queryByRole("button", { name: "Run live Codex chat check" })).not.toBeInTheDocument();
    expect(screen.queryByText("Live Codex chat compatibility")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/doctor/provider-probe")).toHaveLength(0);
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

    await selectInspectorTab("Doctor");

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

    await selectInspectorTab("Knowledge");

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

    await selectInspectorTab("Knowledge");

    fireEvent.click(screen.getByRole("button", { name: "Open corpus" }));

    await waitFor(() => {
      expect(screen.getByText('{"paper_id":"p1","title":"Corpus paper"}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=corpus.jsonl"))).toBe(true);
    });

    await selectInspectorTab("Knowledge");
    fireEvent.click(screen.getByRole("button", { name: "Open bibtex" }));

    await waitFor(() => {
      expect(screen.getByText("@article{p1,title={Corpus paper}}")).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=bibtex.bib"))).toBe(true);
    });

    await selectInspectorTab("Knowledge");
    fireEvent.click(screen.getByRole("button", { name: "Open summaries" }));

    await waitFor(() => {
      expect(screen.getByText('{"paper_id":"p1","summary":"Summary row"}')).toBeInTheDocument();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/api/runs/run-1/artifact?path=paper_summaries.jsonl"))).toBe(true);
    });

    await selectInspectorTab("Knowledge");
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
    await openDetails("Run details");

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

    await selectInspectorTab("Run details");
    fireEvent.click(screen.getByRole("button", { name: /open checklist/i }));

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) => String(url) === "/api/runs/run-1/artifact?path=run_completeness_checklist.json")
      ).toBe(true);
    });

    const activityDrawer = await openLiveActivity();
    fireEvent.click(within(activityDrawer).getByText("Operations"));
    expect(within(activityDrawer).getByText("Top failures")).toBeInTheDocument();
    expect(within(activityDrawer).getByText(/Review is still pending after analysis completed\./)).toBeInTheDocument();
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
    await openDetails("Run details");

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
    await openDetails("Run details");

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

    await openDetails("Artifacts");
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
    await openCommandPanel();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "/agent status" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
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

  it("advances the Web guided brief from shared coverage and keeps ambiguity pending", async () => {
    let answerCount = 0;
    const generatedBrief = "# Research Brief\n\n## Topic\nBounded declared comparison";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "default topic",
            defaultConstraints: ["bounded runtime"],
            defaultObjectiveMetric: "primary score"
          },
          session: { busy: false, logs: [], canCancel: false },
          runs: []
        }), { status: 200 });
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === "/api/guided-brief-interviews") {
        expect(JSON.parse(String(init?.body))).toEqual({
          language: "en",
          researchMode: "hypothesis_test"
        });
        return new Response(JSON.stringify({
          interview: {
            id: "guided-web-fixture",
            language: "en",
            researchMode: "hypothesis_test",
            introLines: ["Starting guided Research Brief interview."],
            status: "active",
            prompt: {
              kind: "field",
              field: "topic",
              question: "Topic — include other declared decisions too.",
              required: true,
              defaultValue: ""
            },
            coverage: { answered: 0, required: 15, remainingFields: ["topic"] },
            answeredFields: [],
            turnCount: 0,
            lastAcceptedFields: []
          }
        }), { status: 201 });
      }
      if (url === "/api/guided-brief-interviews/guided-web-fixture/answers") {
        answerCount += 1;
        const answer = JSON.parse(String(init?.body)).answer;
        if (answerCount === 1) {
          expect(answer).toContain("primary_score");
          return new Response(JSON.stringify({
            interview: {
              id: "guided-web-fixture",
              language: "en",
              researchMode: "hypothesis_test",
              introLines: [],
              status: "active",
              prompt: {
                kind: "field",
                field: "researchQuestion",
                question: "Research question",
                required: true,
                defaultValue: ""
              },
              coverage: { answered: 6, required: 15, remainingFields: ["researchQuestion"] },
              answeredFields: ["topic", "primaryMetric", "meaningfulImprovement", "constraints", "baselineComparator", "datasetTaskBench"],
              turnCount: 1,
              lastAcceptedFields: ["topic", "primaryMetric", "meaningfulImprovement", "constraints", "baselineComparator", "datasetTaskBench"],
              lastResolutionSource: "model"
            }
          }), { status: 200 });
        }
        if (answerCount === 2) {
          expect(answer).toBe("I am not sure yet.");
          return new Response(JSON.stringify({
            interview: {
              id: "guided-web-fixture",
              language: "en",
              researchMode: "hypothesis_test",
              introLines: [],
              status: "active",
              prompt: {
                kind: "field",
                field: "researchQuestion",
                question: "Please clarify the current research question and its verification path.",
                required: true,
                defaultValue: ""
              },
              coverage: { answered: 6, required: 15, remainingFields: ["researchQuestion"] },
              answeredFields: ["topic", "primaryMetric", "meaningfulImprovement", "constraints", "baselineComparator", "datasetTaskBench"],
              turnCount: 2,
              lastAcceptedFields: [],
              lastResolutionSource: "guarded_fallback",
              lastFallbackReason: "explicit_uncertainty"
            }
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          interview: {
            id: "guided-web-fixture",
            language: "en",
            researchMode: "hypothesis_test",
            introLines: [],
            status: "complete",
            prompt: { kind: "complete", question: "", required: false, defaultValue: "" },
            coverage: { answered: 15, required: 15, remainingFields: [] },
            answeredFields: [],
            turnCount: 3,
            lastAcceptedFields: ["researchQuestion"],
            lastResolutionSource: "labeled_input",
            generatedBrief
          }
        }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      close() {}
    } as unknown as typeof EventSource);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create research run" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create research run" }));
    const newRunWorkspace = screen.getByRole("region", { name: "Create research run" });
    expect(within(screen.getByRole("main")).getByRole("region", { name: "Create research run" })).toBe(newRunWorkspace);
    await waitFor(() => expect(newRunWorkspace).toHaveFocus());
    fireEvent.change(screen.getByLabelText("인터뷰 언어"), { target: { value: "en" } });
    fireEvent.click(screen.getByRole("button", { name: "Start interview" }));

    await waitFor(() => {
      expect(screen.getByText("Starting guided Research Brief interview.")).toBeInTheDocument();
      expect(screen.getByText("Topic — include other declared decisions too.")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Required brief coverage")).toHaveValue(0);
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "Compare declared conditions using primary_score and a public validation set." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue interview" }));

    await waitFor(() => expect(screen.getByText("Research question")).toBeInTheDocument());
    expect(screen.getByLabelText("Required brief coverage")).toHaveValue(6);
    expect(screen.getByText("Primary Metric")).toBeInTheDocument();
    expect(screen.getByText("Accepted via bounded interpretation")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your answer"), { target: { value: "I am not sure yet." } });
    fireEvent.click(screen.getByRole("button", { name: "Continue interview" }));

    await waitFor(() => {
      expect(screen.getByText("Please clarify the current research question and its verification path.")).toBeInTheDocument();
      expect(screen.getByText("Interpretation fallback")).toBeInTheDocument();
      expect(screen.getByText("The answer marked this field as uncertain, so model interpretation was not attempted.")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Required brief coverage")).toHaveValue(6);
    expect(screen.queryByRole("button", { name: "Create and start research" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Your answer"), {
      target: { value: "Research question: Does the candidate improve primary_score?" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue interview" }));

    await waitFor(() => expect(screen.getByText("Governed brief complete")).toBeInTheDocument());
    expect(screen.getByLabelText("Generated Research Brief")).toHaveValue(generatedBrief);
    expect(screen.getByRole("button", { name: "Create and start research" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/runs")).toBe(false);
  });

  it("keeps the default Korean guided interview controls aligned with the Korean question", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "",
            defaultConstraints: [],
            defaultObjectiveMetric: ""
          },
          session: { busy: false, logs: [], canCancel: false },
          runs: []
        }), { status: 200 });
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === "/api/guided-brief-interviews") {
        expect(JSON.parse(String(init?.body))).toEqual({
          language: "ko",
          researchMode: "hypothesis_test"
        });
        return new Response(JSON.stringify({
          interview: {
            id: "guided-web-korean",
            language: "ko",
            researchMode: "hypothesis_test",
            introLines: [
              "가이드형 Research Brief 인터뷰를 시작합니다.",
              "목록성 항목은 세미콜론으로 구분할 수 있습니다."
            ],
            status: "active",
            prompt: {
              kind: "field",
              field: "topic",
              question: "주제 — 이미 정한 지표와 비교 대상도 함께 설명해 주세요.",
              required: true,
              defaultValue: ""
            },
            coverage: { answered: 0, required: 15, remainingFields: ["topic"] },
            answeredFields: [],
            turnCount: 0,
            lastAcceptedFields: []
          }
        }), { status: 201 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      close() {}
    } as unknown as typeof EventSource);

    render(<App />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Create research run" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create research run" }));

    expect(screen.getByRole("button", { name: "가이드 인터뷰" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("인터뷰 언어")).toHaveValue("ko");
    fireEvent.click(screen.getByRole("button", { name: "인터뷰 시작" }));

    await waitFor(() => {
      expect(screen.getByText("가이드형 Research Brief 인터뷰를 시작합니다.")).toBeInTheDocument();
      expect(screen.getByText("목록성 항목은 세미콜론으로 구분할 수 있습니다.")).toBeInTheDocument();
      expect(screen.getByText("주제 — 이미 정한 지표와 비교 대상도 함께 설명해 주세요.")).toBeInTheDocument();
    });
    expect(screen.getByLabelText("필수 브리프 항목 진행률")).toHaveValue(0);
    expect(screen.getByLabelText("답변")).toHaveAttribute("placeholder", "현재 질문에 답해 주세요. 이미 정한 다른 항목도 함께 적을 수 있습니다.");
    expect(screen.getByRole("button", { name: "다음 질문으로" })).toBeDisabled();
    expect(screen.queryByLabelText("Your answer")).not.toBeInTheDocument();
  });

  it("keeps an incomplete pasted brief in the composer without creating a duplicate-prone draft run", async () => {
    const partialBrief = [
      "# Research Brief",
      "",
      "## Topic",
      "Evaluate a candidate condition under a bounded protocol."
    ].join("\n");
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
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === "/api/runs") {
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          brief: partialBrief,
          autoStart: true
        });
        return new Response(
          JSON.stringify({
            created: false,
            startOutcome: "blocked",
            session: {
              busy: false,
              logs: [],
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
            runs: []
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
      expect(screen.getByRole("button", { name: "New run" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New run" }));
    expect(screen.getByRole("button", { name: "가이드 인터뷰" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByLabelText("Research Brief")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "완성된 브리프 붙여넣기" }));
    expect(screen.getByLabelText("Research Brief")).toBeRequired();
    expect(screen.getByText("관리형 브리프 가져오기")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Research Brief"), {
      target: {
        value: partialBrief
      }
    });
    expect(screen.getByRole("button", { name: "Run 생성 후 연구 시작" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run 생성 후 연구 시작" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs",
        expect.objectContaining({
          method: "POST"
        })
      );
    });

    expect(screen.queryByText("Run brief")).not.toBeInTheDocument();
    expect(screen.getByText("연구 시작 잠금")).toBeInTheDocument();
    const missingFields = screen.getByLabelText("누락되었거나 불완전한 브리프 항목");
    expect(within(missingFields).getByText("Objective Metric")).toBeInTheDocument();
    expect(within(missingFields).getByText("Constraints")).toBeInTheDocument();
    expect(within(missingFields).getByText("Baseline / Comparator")).toBeInTheDocument();
    expect(screen.getByLabelText("Research Brief")).toHaveValue(partialBrief);
    expect(screen.queryByText("collect_papers started")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/runs")).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Research Brief"), {
      target: { value: `${partialBrief}\n\n## Objective Metric\nPrimary metric: primary score.` }
    });
    expect(screen.queryByText("연구 시작 잠금")).not.toBeInTheDocument();
  });

  it("selects a created run and closes the composer when auto-start is deferred", async () => {
    const completeBrief = "# Research Brief\n\n## Topic\nA complete governed brief fixture.";
    const createdRun = makeWebRun("run-deferred", "Deferred research run");
    let runCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/bootstrap")) {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "default research topic",
            defaultConstraints: ["bounded runtime"],
            defaultObjectiveMetric: "primary score"
          },
          session: {
            activeRunId: runCreated ? "run-already-active" : undefined,
            busy: runCreated,
            logs: [],
            canCancel: runCreated
          },
          runs: runCreated ? [createdRun] : []
        }), { status: 200 });
      }
      if (url.includes("/api/doctor")) {
        return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      }
      if (url.includes("/api/knowledge")) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url === "/api/runs") {
        expect(JSON.parse(String(init?.body))).toEqual({
          brief: completeBrief,
          autoStart: true
        });
        runCreated = true;
        return new Response(JSON.stringify({
          created: true,
          startOutcome: "deferred",
          run: createdRun,
          session: {
            activeRunId: "run-already-active",
            busy: true,
            logs: [],
            canCancel: true
          },
          runs: [createdRun],
          briefStartGate: {
            requested: true,
            canStart: true,
            blocked: false,
            effectiveAutoStart: true,
            missingFields: [],
            validationErrors: [],
            validationWarnings: []
          }
        }), { status: 200 });
      }
      if (url === `/api/runs/${createdRun.id}`) {
        return new Response(JSON.stringify({ run: createdRun }), { status: 200 });
      }
      if (url === `/api/runs/${createdRun.id}/artifacts`) {
        return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      }
      if (url === `/api/runs/${createdRun.id}/checkpoints`) {
        return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      }
      if (url === `/api/runs/${createdRun.id}/literature`) {
        return new Response(JSON.stringify({ literature: emptyLiterature(createdRun.id) }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class {
      addEventListener() {}
      close() {}
    } as unknown as typeof EventSource);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Create research run" }));
    fireEvent.click(screen.getByRole("button", { name: "완성된 브리프 붙여넣기" }));
    fireEvent.change(screen.getByLabelText("Research Brief"), { target: { value: completeBrief } });
    fireEvent.click(screen.getByRole("button", { name: "Run 생성 후 연구 시작" }));

    await waitFor(() => {
      expect(screen.getByText("Run은 생성되었지만 다른 작업이 진행 중이라 연구 시작은 보류되었습니다. 생성된 Run을 선택했으니 현재 작업이 끝난 뒤 시작해 주세요.")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Research Brief")).not.toBeInTheDocument();
    expect(screen.getAllByText("Deferred research run").length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/runs")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByText("Run은 생성되었지만 다른 작업이 진행 중이라 연구 시작은 보류되었습니다. 생성된 Run을 선택했으니 현재 작업이 끝난 뒤 시작해 주세요.")).not.toBeInTheDocument();
  });

  it("returns focus to the New run invoker after a successful create-only submission", async () => {
    const completeBrief = "# Research Brief\n\n## Topic\nA focus-return creation fixture.";
    const createdRun = makeWebRun("run-created-focus", "Created focus run");
    let runCreated = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/bootstrap") {
        return new Response(JSON.stringify({
          configured: true,
          setupDefaults: {
            projectName: "AutoLabOS",
            defaultTopic: "default research topic",
            defaultConstraints: ["bounded runtime"],
            defaultObjectiveMetric: "primary score"
          },
          session: {
            activeRunId: runCreated ? createdRun.id : undefined,
            busy: false,
            logs: [],
            canCancel: false
          },
          activeRunId: runCreated ? createdRun.id : undefined,
          runs: runCreated ? [createdRun] : [],
          jobs: { generated_at: createdRun.updatedAt, runs: [], top_failures: [] },
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 });
      }
      if (url === "/api/runs") {
        expect(JSON.parse(String(init?.body))).toEqual({
          brief: completeBrief,
          autoStart: false
        });
        runCreated = true;
        return new Response(JSON.stringify({
          created: true,
          startOutcome: "not_requested",
          run: createdRun,
          session: {
            activeRunId: createdRun.id,
            busy: false,
            logs: [],
            canCancel: false
          },
          runs: [createdRun],
          briefStartGate: {
            requested: false,
            canStart: true,
            blocked: false,
            effectiveAutoStart: false,
            missingFields: [],
            validationErrors: [],
            validationWarnings: []
          }
        }), { status: 200 });
      }
      if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      if (url === `/api/runs/${createdRun.id}`) return new Response(JSON.stringify({ run: createdRun }), { status: 200 });
      if (url === `/api/runs/${createdRun.id}/artifacts`) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      if (url === `/api/runs/${createdRun.id}/checkpoints`) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      if (url === `/api/runs/${createdRun.id}/literature`) {
        return new Response(JSON.stringify({ literature: emptyLiterature(createdRun.id) }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    const newRunTrigger = await screen.findByRole("button", { name: "New run" });
    newRunTrigger.focus();
    fireEvent.click(newRunTrigger);
    fireEvent.click(screen.getByRole("button", { name: "완성된 브리프 붙여넣기" }));
    fireEvent.change(screen.getByLabelText("Research Brief"), { target: { value: completeBrief } });
    fireEvent.click(screen.getByLabelText("Run을 만든 뒤 연구를 바로 시작"));
    fireEvent.click(screen.getByRole("button", { name: "Run만 생성" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ brief: completeBrief, autoStart: false }) })
      );
      expect(screen.queryByLabelText("Research Brief")).not.toBeInTheDocument();
      expect(newRunTrigger).toHaveAccessibleName("New run");
      expect(newRunTrigger).toHaveFocus();
    });
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

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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
      venue_viability: {
        status: "trusted",
        trusted: true,
        candidate_viability: "continue",
        current_evidence_ceiling: "screening_only",
        top_tier_readiness: "unresolved",
        confirmatory_candidacy: "supported",
        declared_comparator_effect_gate: "passed",
        top_tier_ready: false,
        acceptance_likelihood_assessed: false,
        reason_codes: [
          "confirmatory_gate_satisfied",
          "bounded_probe_is_screening_only"
        ],
        required_upgrades: [
          "confirmatory_evidence_required",
          "current_venue_fit_review_required"
        ],
        artifact_ref: {
          label: "Venue viability",
          path: "analysis/venue_viability_report.json"
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

    const funnel = await openResearchFunnel();
    expect(funnel.querySelector(".status-pill")).toHaveTextContent("Reviewed, follow-up required");
    expect(funnel.querySelector(".status-pill")).not.toHaveTextContent("Probe authorized");
    expect(within(funnel).getByText("Promote To Confirmatory")).toBeInTheDocument();
    expect(within(funnel).getByText("Start Confirmatory Run")).toBeInTheDocument();
    expect(within(funnel).getByText("Candidate viability").closest("div")).toHaveTextContent(
      "Continue"
    );
    expect(within(funnel).getByText("Venue assessment").closest("div")).toHaveTextContent(
      "Trusted (trusted)"
    );
    expect(within(funnel).getByText("Confirmatory candidacy").closest("div")).toHaveTextContent(
      "Supported"
    );
    expect(within(funnel).getByText("Current evidence ceiling").closest("div")).toHaveTextContent(
      "Screening Only"
    );
    expect(within(funnel).getByText("Top-tier readiness").closest("div")).toHaveTextContent(
      "Unresolved (not ready; acceptance not assessed)"
    );
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

    const funnel = await openResearchFunnel();
    const activeProbe = within(funnel).getByRole("region", { name: "Verified active bounded probe" });
    expect(within(activeProbe).getByText("<-2 raw delta_vs_reference")).toBeInTheDocument();
    expect(within(activeProbe).getByText("candidate-deferred")).toBeInTheDocument();
    expect(within(activeProbe).queryByText("Effect note")).not.toBeInTheDocument();
  });

  it("shows an artifact-free topic discovery run as unmeasured, not blocked", async () => {
    renderAppWithResearchFunnel({});

    const paperEvidence = (await screen.findByText("Paper evidence")).closest("article");
    expect(paperEvidence).not.toBeNull();
    expect(within(paperEvidence!).getByText("Unmeasured")).toBeInTheDocument();
    expect(paperEvidence).toHaveClass("tone-neutral");
    expect(within(paperEvidence!).queryByText("Blocked")).not.toBeInTheDocument();

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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

    const overview = within(await openDetails("Run details")).getByRole("tabpanel", { name: "Run details" });
    expect(within(overview).getByText("Workflow readiness")).toBeInTheDocument();
    expect(within(overview).getByText("Evidence readiness")).toBeInTheDocument();
    expect(within(overview).getByText("Comparison ready")).toBeInTheDocument();
    expect(within(overview).getByText("Primary comparison")).toBeInTheDocument();
    expect(within(overview).getByText("declared-comparison")).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Blocking evidence" })).toBeInTheDocument();
    const overview = within(await openDetails("Run details")).getByRole("tabpanel", { name: "Run details" });
    expect(within(overview).getByText("Evidence readiness")).toBeInTheDocument();
    expect(within(overview).getByText("Comparison ready")).toBeInTheDocument();
    expect(within(overview).getByText("Evidence adequacy")).toBeInTheDocument();
    expect(within(overview).getByText("Unknown")).toBeInTheDocument();
    expect(within(overview).getByText("Trusted yes · Integrity valid")).toBeInTheDocument();
    expect(within(overview).getByText("Paper evidence")).toBeInTheDocument();
    expect(within(overview).getByText("Blocked")).toBeInTheDocument();
    expect(within(overview).getByText("Adequacy comparison")).toBeInTheDocument();
    expect(within(overview).getByText("adequacy-primary")).toBeInTheDocument();
    expect(within(overview).getByText("Adequacy reasons")).toBeInTheDocument();
    expect(within(overview).getByText("Uncertainty unknown")).toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "Open Evidence adequacy assessment" })).toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "Open Review evidence reassessment" })).toBeInTheDocument();
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

    expect(await screen.findByRole("heading", { name: "Blocking evidence" })).toBeInTheDocument();
    const overview = within(await openDetails("Run details")).getByRole("tabpanel", { name: "Run details" });
    const assuranceLabel = within(overview).getByText("Review assurance");
    const assuranceCard = assuranceLabel.closest("article");
    expect(assuranceCard).not.toBeNull();
    expect(within(assuranceCard!).getByText("Invalid")).toBeInTheDocument();
    expect(within(assuranceCard!).getByText("Paper blocked · Manifest invalid · Gate valid · Handoff invalid")).toBeInTheDocument();
    expect(within(overview).getByText("review_input_changed:result_analysis.json")).toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "Open Review input manifest" })).toBeInTheDocument();
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

  it("renders blocked research-process checks and their evidence", async () => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      {
        version: 1,
        status: "blocked",
        trusted: false,
        paper_ready_eligible: false,
        required_check_count: 3,
        passed_required_check_count: 2,
        blocker_count: 1,
        reason_codes: ["plan_execution_binding_mismatch"],
        checks: [{
          id: "plan_execution_alignment",
          status: "fail",
          required: true,
          reason_codes: ["plan_execution_binding_mismatch"],
          artifact_refs: [{ label: "Run manifest", path: "run_manifest.json" }]
        }],
        policy_note: "Artifact-backed process integrity."
      }
    );

    const overview = within(await openDetails("Run details")).getByRole("tabpanel", { name: "Run details" });
    const label = within(overview).getByText("Research process");
    const card = label.closest("article");
    expect(card).not.toBeNull();
    expect(within(card!).getByText("blocked · 2/3")).toBeInTheDocument();
    const checks = within(overview).getByRole("list", { name: "Research process checks requiring action" });
    expect(within(checks).getByText("plan_execution_alignment")).toBeInTheDocument();
    expect(within(checks).getByText("Fail")).toBeInTheDocument();
    expect(within(overview).getByRole("button", { name: "Open Run manifest" })).toBeInTheDocument();
  });

  it.each([
    { status: "not_started" as const, label: "Not started" },
    { status: "missing" as const, label: "Missing" }
  ])("presents required $status review assurance as attention rather than blocking", async ({ status, label }) => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      undefined,
      {
        status,
        trusted: false,
        paper_ready_eligible: false,
        input_manifest_valid: false,
        gate_report_valid: false,
        assurance_valid: false,
        handoff_valid: false,
        model_review_bundle_valid: false,
        required_for_paper_ready: true,
        reason_codes: [],
        artifact_refs: []
      }
    );

    expect(await screen.findByRole("heading", { name: "Evidence requiring attention" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocking evidence" })).not.toBeInTheDocument();
    const assuranceRow = screen.getByText("Review assurance").closest("article");
    expect(assuranceRow).not.toBeNull();
    expect(assuranceRow).toHaveClass("tone-warning");
    expect(within(assuranceRow!).getByText(label)).toBeInTheDocument();
  });

  it("presents valid review assurance as a passing evidence check", async () => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      undefined,
      {
        status: "valid",
        trusted: true,
        paper_ready_eligible: true,
        input_manifest_valid: true,
        gate_report_valid: true,
        assurance_valid: true,
        handoff_valid: true,
        model_review_bundle_valid: true,
        required_for_paper_ready: true,
        reason_codes: [],
        artifact_refs: []
      }
    );

    expect(await screen.findByRole("heading", { name: "Evidence checks" })).toBeInTheDocument();
    const assuranceRow = screen.getByText("Review assurance").closest("article");
    expect(assuranceRow).not.toBeNull();
    expect(assuranceRow).toHaveClass("tone-success");
    expect(within(assuranceRow!).getByText("Verified")).toBeInTheDocument();
  });

  it.each([
    { status: "unmeasured" as const, label: "Unmeasured", detail: "Evidence adequacy has not been measured yet." },
    { status: "awaiting_execution" as const, label: "Awaiting execution", detail: "Evidence adequacy will be evaluated after execution receipts are available." }
  ])("keeps $status early evidence projections neutral", async ({ status, label, detail }) => {
    renderAppWithResearchFunnel(
      {},
      undefined,
      [],
      undefined,
      {
        status,
        trusted: false,
        integrity_valid: false,
        paper_evidence_allowed: false,
        contract_present: false,
        receipt_present: false,
        assessment_present: false,
        review_reassessment_present: false,
        reason_codes: [],
        artifact_refs: []
      },
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

    expect(await screen.findByRole("heading", { name: "Evidence checks" })).toBeInTheDocument();
    const rows = screen.getAllByRole("article").filter((article) => article.classList.contains("evidence-row"));
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.classList.contains("tone-neutral"))).toBe(true);
    const adequacyRow = screen.getByText("Evidence adequacy").closest("article");
    const paperEvidenceRow = screen.getByText("Paper evidence").closest("article");
    const assuranceRow = screen.getByText("Review assurance").closest("article");
    expect(adequacyRow).not.toBeNull();
    expect(paperEvidenceRow).not.toBeNull();
    expect(assuranceRow).not.toBeNull();
    expect(within(adequacyRow!).getByText(label)).toBeInTheDocument();
    expect(within(adequacyRow!).getByText(detail)).toBeInTheDocument();
    expect(within(paperEvidenceRow!).getByText(label)).toBeInTheDocument();
    expect(within(assuranceRow!).getByText("Not started")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Blocking evidence" })).not.toBeInTheDocument();
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

    const overview = within(await openDetails("Run details")).getByRole("tabpanel", { name: "Run details" });
    const notice = within(overview).getByRole("status", { name: "Last applied backtrack" });
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

    const funnel = await openResearchFunnel();
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

    const funnel = await openResearchFunnel();
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

    const initialDock = await screen.findByRole("region", { name: "Next action" });
    const approveButton = within(initialDock).getByRole("button", { name: "Approve current node" });
    fireEvent.click(approveButton);
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringMatching(
      /Action: Approve current node[\s\S]*Run: Active run[\s\S]*Run ID: run-1[\s\S]*Node: Review/u
    ));
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url).includes("/actions/") && init?.method === "POST")).toHaveLength(0);

    const runPicker = screen.getByRole("button", { name: /^Inspect run\./ });
    expect(runPicker).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(runPicker);
    const runPickerPopover = document.getElementById("run-picker-options");
    expect(runPickerPopover).not.toBeNull();
    expect(within(runPickerPopover!).getByRole("button", { name: /Active run/ })).toHaveAttribute("aria-current", "true");
    const runSearch = screen.getByRole("searchbox", { name: "Search runs" });
    fireEvent.change(runSearch, { target: { value: "Inspected" } });
    expect(within(runPickerPopover!).queryByRole("button", { name: /Active run/ })).not.toBeInTheDocument();
    const inspectedRunOption = within(runPickerPopover!).getByRole("button", { name: /Inspected run/ });
    expect(inspectedRunOption).not.toHaveAttribute("aria-current");
    fireEvent.click(inspectedRunOption);

    await waitFor(() => {
      expect(runPicker).toHaveFocus();
      expect(runPicker).toHaveAccessibleName("Inspect run. Current: Inspected run");
      expect(screen.getByText("Inspection only")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Approve current node" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Activate inspected run" })).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Activate inspected run" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/session/input",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ text: "/run run-2" }) })
      );
      expect(screen.getByRole("button", { name: "Approve current node" })).toBeEnabled();
    });
  });

  it("isolates active-run intervention state from an inspected inactive run and closes the run picker for the command shortcut", async () => {
    const activeRun = makeWebRun("run-active", "Active intervention run");
    const inspectedRun = makeWebRun("run-inspected", "Inactive inspected run");
    const activeOnlyQuestion = "ACTIVE_RUN_ONLY_QUESTION: Which recovery route should execute?";
    const activeOnlyCommand = "/agent apply active-only-plan";
    const activeOnlyLog = "ACTIVE_RUN_ONLY_LOG: private runtime output";
    const activeOnlyBusyLabel = "ACTIVE_RUN_ONLY_BUSY_LABEL";
    const runs = [activeRun, inspectedRun];
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
          session: {
            activeRunId: activeRun.id,
            busy: false,
            busyLabel: activeOnlyBusyLabel,
            logs: [activeOnlyLog],
            canCancel: false,
            humanIntervention: {
              runId: activeRun.id,
              requestId: "active-request",
              sourceNode: "analyze_results",
              kind: "objective_metric_clarification",
              title: "Active-run clarification",
              question: activeOnlyQuestion,
              context: ["This context belongs only to the active run."],
              inputMode: "free_text",
              choices: [],
              conversationTurnCount: 0
            },
            pendingPlan: {
              sourceInput: "active run plan",
              displayCommands: [activeOnlyCommand, "/agent jump review"],
              stepIndex: 0,
              totalSteps: 2
            }
          },
          activeRunId: activeRun.id,
          runs,
          jobs: { generated_at: activeRun.updatedAt, runs: [], top_failures: [] },
          jobQueue: { running: [], waiting: [], stalled: [] }
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

    const runPicker = await screen.findByRole("button", { name: /^Inspect run\./ });
    runPicker.focus();
    fireEvent.click(runPicker);
    const runSearch = screen.getByRole("searchbox", { name: "Search runs" });
    await waitFor(() => expect(runSearch).toHaveFocus());

    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const shortcutDialog = await screen.findByRole("dialog", { name: "Live logs" });
    await waitFor(() => {
      expect(screen.queryByRole("searchbox", { name: "Search runs" })).not.toBeInTheDocument();
      expect(runPicker).toHaveAttribute("aria-expanded", "false");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(shortcutDialog).not.toBeInTheDocument();
      expect(runPicker).toHaveFocus();
    });

    fireEvent.click(runPicker);
    const runPickerPopover = document.getElementById("run-picker-options");
    expect(runPickerPopover).not.toBeNull();
    expect(within(runPickerPopover!).getByRole("button", { name: /Active intervention run/ })).toHaveAttribute("aria-current", "true");
    const inactiveOption = within(runPickerPopover!).getByRole("button", { name: /Inactive inspected run/ });
    expect(inactiveOption).not.toHaveAttribute("aria-current");
    fireEvent.click(inactiveOption);
    await waitFor(() => {
      expect(runPicker).toHaveAccessibleName("Inspect run. Current: Inactive inspected run");
      expect(runPicker).toHaveTextContent("Inactive inspected run");
      expect(runPicker).toHaveFocus();
      expect(screen.getByText("Inspection only")).toBeInTheDocument();
    });

    expect(screen.queryByRole("region", { name: "Human input required" })).not.toBeInTheDocument();
    expect(screen.queryByText(activeOnlyQuestion)).not.toBeInTheDocument();
    expect(screen.queryByText(activeOnlyCommand)).not.toBeInTheDocument();
    expect(screen.queryByText("Pending plan")).not.toBeInTheDocument();
    const inactiveDock = screen.getByRole("region", { name: "Next action" });
    expect(within(inactiveDock).getByRole("button", { name: "Activate inspected run" })).toBeEnabled();
    expect(within(inactiveDock).queryByRole("button", { name: "Open command panel" })).not.toBeInTheDocument();

    const logsDialog = await openDetails("Live logs");
    const prompt = within(logsDialog).getByRole("textbox", { name: "Prompt" });
    expect(prompt).toBeDisabled();
    expect(prompt).toHaveAttribute("placeholder", "collect papers using the run's declared literature scope");
    expect(within(logsDialog).getByRole("button", { name: "Send" })).toBeDisabled();
    expect(within(logsDialog).queryByRole("textbox", { name: "Answer" })).not.toBeInTheDocument();
    expect(within(logsDialog).queryByRole("button", { name: "Submit answer" })).not.toBeInTheDocument();
    expect(within(logsDialog).queryByText(activeOnlyQuestion)).not.toBeInTheDocument();
    expect(within(logsDialog).queryByText(activeOnlyCommand)).not.toBeInTheDocument();
    expect(within(logsDialog).queryByText(activeOnlyLog)).not.toBeInTheDocument();
    expect(within(logsDialog).queryByText(activeOnlyBusyLabel)).not.toBeInTheDocument();
    expect(within(logsDialog).getByText(/Live logs belong to the active command target/)).toBeInTheDocument();
    expect(within(logsDialog).getByText("Inactive")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const activityTrigger = screen.getByRole("button", { name: /^Open live activity\./ });
    activityTrigger.focus();
    fireEvent.click(activityTrigger);
    expect(await screen.findByRole("complementary", { name: "Live activity" })).toBeInTheDocument();

    fireEvent.click(runPicker);
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search runs" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "k", ctrlKey: true });
    const activityToDetails = await screen.findByRole("dialog", { name: "Live logs" });
    await waitFor(() => {
      expect(screen.queryByRole("complementary", { name: "Live activity" })).not.toBeInTheDocument();
      expect(screen.queryByRole("searchbox", { name: "Search runs" })).not.toBeInTheDocument();
      expect(runPicker).toHaveAttribute("aria-expanded", "false");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(activityToDetails).not.toBeInTheDocument();
      expect(screen.queryByRole("searchbox", { name: "Search runs" })).not.toBeInTheDocument();
      expect(runPicker).toHaveAttribute("aria-expanded", "false");
      expect(runPicker).toHaveFocus();
    });

    activityTrigger.focus();
    fireEvent.click(activityTrigger);
    expect(await screen.findByRole("complementary", { name: "Live activity" })).toBeInTheDocument();
    const commandTrigger = screen.getByRole("button", { name: "Open command panel" });
    commandTrigger.focus();
    fireEvent.click(commandTrigger);
    const commandDialog = await screen.findByRole("dialog", { name: "Live logs" });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Live activity" })).not.toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(commandDialog).not.toBeInTheDocument();
      expect(commandTrigger).toHaveFocus();
    });
  });

  it.each([
    { label: "healthy pending", runStatus: "paused", nodeStatus: "pending", transitionAction: null, expectedAction: "Run current node", busy: false, canCancel: false },
    { label: "failed", runStatus: "failed", nodeStatus: "failed", transitionAction: null, expectedAction: "Retry current node", busy: false, canCancel: false },
    { label: "approval", runStatus: "paused", nodeStatus: "needs_approval", transitionAction: null, expectedAction: "Approve current node", busy: false, canCancel: false },
    { label: "approval with transition", runStatus: "paused", nodeStatus: "needs_approval", transitionAction: "retry_same", expectedAction: "Approve current node", busy: false, canCancel: false },
    { label: "auto transition", runStatus: "paused", nodeStatus: "pending", transitionAction: "retry_same", expectedAction: "Apply recommendation", busy: false, canCancel: false },
    { label: "completed node with advance transition", runStatus: "paused", nodeStatus: "completed", transitionAction: "advance", expectedAction: "Apply recommendation", busy: false, canCancel: false },
    { label: "delegated handoff", runStatus: "paused", nodeStatus: "needs_approval", transitionAction: "delegate_successor", expectedAction: null, busy: false, canCancel: false },
    { label: "human pause", runStatus: "paused", nodeStatus: "pending", transitionAction: "pause_for_human", expectedAction: null, busy: false, canCancel: false },
    { label: "healthy running", runStatus: "running", nodeStatus: "running", transitionAction: null, expectedAction: null, busy: false, canCancel: false },
    { label: "cancellable active task", runStatus: "running", nodeStatus: "running", transitionAction: null, expectedAction: "Cancel active task", busy: true, canCancel: true },
    { label: "completed", runStatus: "completed", nodeStatus: "completed", transitionAction: null, expectedAction: null, busy: false, canCancel: false }
  ])("shows one state-appropriate hero action for $label", async ({
    label,
    runStatus,
    nodeStatus,
    transitionAction,
    expectedAction,
    busy,
    canCancel
  }) => {
    const run = makeWebRun("run-action-state", "Action state run") as unknown as RunRecord;
    run.status = runStatus;
    run.graph.nodeStates.review.status = nodeStatus;
    if (transitionAction) {
      run.graph.pendingTransition = {
        action: transitionAction,
        targetNode: "analyze_results",
        reason: "A governed transition requires explicit handling.",
        confidence: 0.9,
        autoExecutable: transitionAction !== "pause_for_human",
        evidence: ["validation-evidence"],
        suggestedCommands: [],
        generatedAt: run.updatedAt
      };
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
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
            session: { activeRunId: run.id, busy, busyLabel: busy ? "Running governed node" : undefined, logs: [], canCancel },
            activeRunId: run.id,
            runs: [run],
            jobs: { generated_at: run.updatedAt, runs: [], top_failures: [] },
            jobQueue: { running: [], waiting: [], stalled: [] }
          }), { status: 200 });
        }
        if (url === `/api/runs/${run.id}`) return new Response(JSON.stringify({ run }), { status: 200 });
        if (url === `/api/runs/${run.id}/artifacts`) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
        if (url === `/api/runs/${run.id}/checkpoints`) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
        if (url === `/api/runs/${run.id}/literature`) return new Response(JSON.stringify({ literature: emptyLiterature(run.id) }), { status: 200 });
        if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
        if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
        if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
        if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
        return new Response(JSON.stringify({}), { status: 200 });
      })
    );
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Review decision" })).toBeInTheDocument();
    const docks = screen.getAllByRole("region", { name: "Next action" });
    expect(docks).toHaveLength(1);
    const dock = docks[0]!;
    const actions = within(dock).queryAllByRole("button");
    if (expectedAction) {
      expect(actions).toHaveLength(1);
      expect(within(dock).getByRole("button", { name: expectedAction })).toBeEnabled();
      expect(screen.getAllByRole("button", { name: expectedAction })).toHaveLength(1);
    } else {
      expect(actions).toHaveLength(0);
    }

    const workflow = screen.getByRole("navigation", { name: "Workflow steps" });
    const steps = within(workflow).getAllByRole("listitem");
    expect(steps).toHaveLength(10);
    const currentSteps = steps.filter((step) => step.getAttribute("aria-current") === "step");
    expect(currentSteps).toHaveLength(1);
    expect(currentSteps[0]).toHaveTextContent("Review");

    if (label === "approval with transition") {
      const dialog = await openDetails("Run details");
      expect(within(dialog).queryByRole("button", { name: /Apply recommendation/ })).not.toBeInTheDocument();
      expect(within(dialog).queryByRole("button", { name: /Start overnight preset/ })).not.toBeInTheDocument();
    }
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

    const inspectRun = await screen.findByRole("button", { name: /^Inspect run\./ });
    fireEvent.click(inspectRun);
    const runPickerPopover = document.getElementById("run-picker-options");
    expect(runPickerPopover).not.toBeNull();
    expect(within(runPickerPopover!).getByRole("button", { name: /Delayed run/ })).toHaveAttribute("aria-current", "true");
    const currentInspectionOption = within(runPickerPopover!).getByRole("button", { name: /Current inspection/ });
    expect(currentInspectionOption).not.toHaveAttribute("aria-current");
    fireEvent.click(currentInspectionOption);
    await waitFor(() => {
      expect(inspectRun).toHaveAccessibleName("Inspect run. Current: Current inspection");
      expect(inspectRun).toHaveFocus();
    });

    resolveDelayedRun?.(new Response(JSON.stringify({ run: runs[0] }), { status: 200 }));
    await Promise.resolve();

    expect(inspectRun).toHaveTextContent("Current inspection");
    expect(inspectRun).not.toHaveTextContent("Delayed run");
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

    const inspectRun = await screen.findByRole("button", { name: /^Inspect run\./ });
    await waitFor(() => expect(inspectRun).toHaveAccessibleName("Inspect run. Current: Initial state"));
    bootstrapListener?.();
    bootstrapListener?.();
    await waitFor(() => expect(inspectRun).toHaveAccessibleName("Inspect run. Current: Fresh bootstrap state"));

    resolveStaleBootstrap?.(
      new Response(JSON.stringify(bootstrapPayload(staleRun)), { status: 200 })
    );
    await waitFor(() => {
      expect(inspectRun).toHaveTextContent("Fresh bootstrap state");
      expect(inspectRun).not.toHaveTextContent("Stale bootstrap state");
    });
  });

  it("renders a restored human question with bounded recovery choices and an answer composer", async () => {
    const run = makeWebRun("run-human", "Adaptive dialogue run");
    const question = "Which metric or recovery path should govern the next step?";
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
          session: {
            activeRunId: run.id,
            busy: false,
            logs: [],
            canCancel: false,
            humanIntervention: {
              runId: run.id,
              requestId: "request-1",
              sourceNode: "analyze_results",
              kind: "objective_metric_clarification",
              title: "Clarify the objective metric",
              question,
              context: ["The comparison contract may need revision."],
              inputMode: "free_text",
              choices: [
                {
                  id: "revise_design",
                  label: "Return to experiment design",
                  description: "Revise the metric contract before analyzing again."
                }
              ],
              conversationTurnCount: 1
            }
          },
          activeRunId: run.id,
          runs: [run],
          jobs: { generated_at: "2026-08-09T00:00:00.000Z", runs: [], top_failures: [] },
          jobQueue: { running: [], waiting: [], stalled: [] }
        }), { status: 200 });
      }
      if (url === "/api/jobs") return new Response(JSON.stringify({ running: [], waiting: [], stalled: [] }), { status: 200 });
      if (url.startsWith("/api/exploration/status")) return new Response(JSON.stringify({ enabled: false }), { status: 200 });
      if (url === "/api/doctor") return new Response(JSON.stringify({ configured: true, checks: [] }), { status: 200 });
      if (url === "/api/knowledge") return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      if (url === `/api/runs/${run.id}`) return new Response(JSON.stringify({ run }), { status: 200 });
      if (url === `/api/runs/${run.id}/artifacts`) return new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
      if (url === `/api/runs/${run.id}/checkpoints`) return new Response(JSON.stringify({ checkpoints: [] }), { status: 200 });
      if (url === `/api/runs/${run.id}/literature`) return new Response(JSON.stringify({ literature: emptyLiterature(run.id) }), { status: 200 });
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { addEventListener() {} close() {} } as unknown as typeof EventSource);
    render(<App />);

    const card = await screen.findByRole("region", { name: "Human input required" });
    expect(within(card).getByText(question)).toBeInTheDocument();
    await waitFor(() => {
      expect(within(card).getByRole("button", { name: "Return to experiment design" })).toBeEnabled();
    });
    expect(within(card).getByText("Follow-up turn 2")).toBeInTheDocument();

    const dock = screen.getByRole("region", { name: "Next action" });
    const commandTrigger = within(dock).getByRole("button", { name: "Open command panel" });
    commandTrigger.focus();
    fireEvent.click(commandTrigger);
    const dialog = await screen.findByRole("dialog", { name: "Live logs" });
    expect(within(dialog).getByRole("textbox", { name: "Answer" })).toHaveAttribute("placeholder", question);
    expect(within(dialog).getByRole("button", { name: "Submit answer" })).toBeEnabled();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(commandTrigger).toHaveFocus();
    });
  });
});

function renderAppWithResearchFunnel(
  overrides: Partial<ResearchFunnelProjection>,
  evidenceReadiness?: RunJobProjection["evidence_readiness"],
  transitionHistory: NonNullable<RunRecord["graph"]["transitionHistory"]> = [],
  lastAppliedTransition?: NonNullable<RunRecord["graph"]["lastAppliedTransition"]>,
  evidenceAdequacy?: RunJobProjection["evidence_adequacy"],
  reviewAssurance?: RunJobProjection["review_assurance"],
  researchProcess?: RunJobProjection["research_process"]
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
    ...overrides,
    venue_viability: overrides.venue_viability ?? {
      status: "unmeasured",
      trusted: false,
      top_tier_ready: false,
      acceptance_likelihood_assessed: false,
      reason_codes: [],
      required_upgrades: []
    },
    portfolio_candidates: overrides.portfolio_candidates ?? []
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
            review_assurance: reviewAssurance,
            research_process: researchProcess
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
