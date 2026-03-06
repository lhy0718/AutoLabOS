import process from "node:process";
import readline from "node:readline";
import path from "node:path";
import { promises as fs } from "node:fs";

import { AGENT_ORDER, AgentId, AppConfig, GraphNodeId, RunRecord, SuggestionItem } from "../types.js";
import { RunStore } from "../core/runs/runStore.js";
import { TitleGenerator } from "../core/runs/titleGenerator.js";
import { CodexCliClient, CodexReasoningEffort } from "../integrations/codex/codexCliClient.js";
import {
  buildCodexModelSelectionChoices,
  getReasoningEffortChoicesForModel,
  normalizeReasoningEffortForModel
} from "../integrations/codex/modelCatalog.js";
import { buildSuggestions } from "./commandPalette/suggest.js";
import { parseSlashCommand } from "../core/commands/parseSlash.js";
import { buildNaturalAssistantResponseWithLlm } from "../core/commands/naturalLlmAssistant.js";
import { runDoctor } from "../core/doctor.js";
import { resolveRunByQuery } from "../core/runs/runResolver.js";
import { askLine } from "../utils/prompt.js";
import { ensureDir } from "../utils/fs.js";
import { AgentOrchestrator } from "../core/agents/agentOrchestrator.js";
import { RunContextMemory } from "../core/memory/runContextMemory.js";
import { getAppVersion } from "./version.js";
import { buildFrame } from "./renderFrame.js";
import { supportsColor } from "./theme.js";
import {
  deleteBackward,
  deleteToLineStart,
  deletePreviousWord,
  insertAtCursor,
  moveCursorLineEnd,
  moveCursorLineStart,
  moveCursorWordLeft,
  moveCursorWordRight
} from "./inputEditing.js";
import {
  COLLECT_USAGE,
  CollectCommandRequest,
  parseCollectArgs
} from "../core/commands/collectOptions.js";

interface TerminalAppDeps {
  config: AppConfig;
  runStore: RunStore;
  titleGenerator: TitleGenerator;
  codex: CodexCliClient;
  orchestrator: AgentOrchestrator;
  initialRunId?: string;
  onQuit: () => void;
  saveConfig: (nextConfig: AppConfig) => Promise<void>;
}

interface ActiveNaturalRequest {
  input: string;
  steeringHints: string[];
  abortController: AbortController;
}

interface ActiveSelectionMenu {
  title: string;
  options: string[];
  selectedIndex: number;
  resolve: (value: string | undefined) => void;
}

interface RunHistoryFile {
  version: 1;
  items: string[];
}

interface CorpusInsights {
  totalPapers: number;
  missingPdfCount: number;
  topCitation?: {
    title: string;
    citationCount: number;
  };
  titles: string[];
}

interface CorpusInsightsCacheEntry {
  mtimeMs: number;
  size: number;
  insights: CorpusInsights;
}

export class TerminalApp {
  private readonly config: AppConfig;
  private readonly runStore: RunStore;
  private readonly titleGenerator: TitleGenerator;
  private readonly codex: CodexCliClient;
  private readonly orchestrator: AgentOrchestrator;
  private readonly onQuit: () => void;
  private readonly saveConfigFn: (nextConfig: AppConfig) => Promise<void>;
  private readonly appVersion = getAppVersion();
  private readonly colorEnabled = supportsColor();

  private input = "";
  private cursorIndex = 0;
  private commandHistory: string[] = [];
  private historyCursor = -1;
  private historyDraft = "";
  private historyLoadedRunId?: string;
  private logs: string[] = [];
  private suggestions: SuggestionItem[] = [];
  private selectedSuggestion = 0;
  private runIndex: RunRecord[] = [];
  private activeRunId?: string;
  private busy = false;
  private thinking = false;
  private thinkingFrame = 0;
  private thinkingTimer?: NodeJS.Timeout;
  private queuedInputs: string[] = [];
  private activeSelectionMenu?: ActiveSelectionMenu;
  private drainingQueuedInputs = false;
  private activeNaturalRequest?: ActiveNaturalRequest;
  private steeringBufferDuringThinking: string[] = [];
  private activeBusyAbortController?: AbortController;
  private activeBusyLabel?: string;
  private readonly corpusInsightsCache = new Map<string, CorpusInsightsCacheEntry>();
  private stopped = false;
  private resolver?: () => void;
  private pendingNaturalCommand?: {
    command: string;
    sourceInput: string;
    createdAt: string;
  };

  private readonly keypressHandler = (str: string, key: readline.Key) => {
    void this.handleKeypress(str, key);
  };

  constructor(deps: TerminalAppDeps) {
    this.config = deps.config;
    this.runStore = deps.runStore;
    this.titleGenerator = deps.titleGenerator;
    this.codex = deps.codex;
    this.orchestrator = deps.orchestrator;
    this.activeRunId = deps.initialRunId;
    this.onQuit = deps.onQuit;
    this.saveConfigFn = deps.saveConfig;
  }

  async start(): Promise<void> {
    await this.refreshRunIndex();
    if (this.activeRunId) {
      await this.loadHistoryForRun(this.activeRunId);
    }
    this.pushLog("Slash command palette is ready. Type /help to see commands.");
    this.attachKeyboard();
    this.render();

    await new Promise<void>((resolve) => {
      this.resolver = resolve;
    });
  }

  private attachKeyboard(): void {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", this.keypressHandler);
  }

  private detachKeyboard(): void {
    process.stdin.off("keypress", this.keypressHandler);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  private async handleKeypress(str: string, key: readline.Key): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      await this.shutdown();
      return;
    }

    if (this.activeSelectionMenu) {
      if (key.name === "up") {
        this.moveSelectionMenu(-1);
        return;
      }
      if (key.name === "down") {
        this.moveSelectionMenu(1);
        return;
      }
      if (key.name === "return") {
        this.commitSelectionMenu();
        return;
      }
      if (key.name === "escape") {
        this.cancelSelectionMenu();
        return;
      }
      return;
    }

    if (key.name === "return") {
      await this.handleEnter();
      return;
    }

    if (isWordDeleteShortcut(str, key)) {
      this.exitHistoryBrowsing();
      const next = deletePreviousWord(this.input, this.cursorIndex);
      this.input = next.input;
      this.cursorIndex = next.cursor;
      this.updateSuggestions();
      this.render();
      return;
    }

    if (isLineDeleteShortcut(str, key)) {
      this.exitHistoryBrowsing();
      const next = deleteToLineStart(this.input, this.cursorIndex);
      this.input = next.input;
      this.cursorIndex = next.cursor;
      this.updateSuggestions();
      this.render();
      return;
    }

    if (key.name === "backspace") {
      this.exitHistoryBrowsing();
      const next = deleteBackward(this.input, this.cursorIndex);
      this.input = next.input;
      this.cursorIndex = next.cursor;
      this.updateSuggestions();
      this.render();
      return;
    }

    if (isWordMoveLeftShortcut(str, key)) {
      this.cursorIndex = moveCursorWordLeft(this.input, this.cursorIndex);
      this.render();
      return;
    }

    if (isWordMoveRightShortcut(str, key)) {
      this.cursorIndex = moveCursorWordRight(this.input, this.cursorIndex);
      this.render();
      return;
    }

    if (isLineMoveLeftShortcut(str, key)) {
      this.cursorIndex = moveCursorLineStart();
      this.render();
      return;
    }

    if (isLineMoveRightShortcut(str, key)) {
      this.cursorIndex = moveCursorLineEnd(this.input);
      this.updateSuggestions();
      this.render();
      return;
    }

    if (key.name === "left") {
      this.cursorIndex = Math.max(0, this.cursorIndex - 1);
      this.render();
      return;
    }

    if (key.name === "right") {
      const len = Array.from(this.input).length;
      this.cursorIndex = Math.min(len, this.cursorIndex + 1);
      this.updateSuggestions();
      this.render();
      return;
    }

    if (key.name === "tab") {
      this.autocompleteSelectedSuggestion();
      this.render();
      return;
    }

    if (key.name === "up") {
      if (this.historyCursor !== -1) {
        if (this.recallPreviousHistory()) {
          this.render();
        }
      } else if (this.suggestions.length > 0) {
        this.exitHistoryBrowsing();
        this.selectedSuggestion =
          (this.selectedSuggestion - 1 + this.suggestions.length) % this.suggestions.length;
        this.previewSelectedSuggestion();
        this.render();
      } else if (this.recallPreviousHistory()) {
        this.render();
      }
      return;
    }

    if (key.name === "down") {
      if (this.historyCursor !== -1) {
        if (this.recallNextHistory()) {
          this.render();
        }
      } else if (this.suggestions.length > 0) {
        this.exitHistoryBrowsing();
        this.selectedSuggestion = (this.selectedSuggestion + 1) % this.suggestions.length;
        this.previewSelectedSuggestion();
        this.render();
      } else if (this.recallNextHistory()) {
        this.render();
      }
      return;
    }

    if (key.name === "escape") {
      if (this.busy) {
        this.cancelCurrentBusyOperation();
        return;
      }
      this.suggestions = [];
      this.selectedSuggestion = 0;
      this.render();
      return;
    }

    if (str && !key.ctrl && !key.meta) {
      this.exitHistoryBrowsing();
      const next = insertAtCursor(this.input, this.cursorIndex, str);
      this.input = next.input;
      this.cursorIndex = next.cursor;
      this.updateSuggestions();
      this.render();
    }
  }

  private updateSuggestions(): void {
    if (!isSlashPrefixed(this.input)) {
      this.suggestions = [];
      this.selectedSuggestion = 0;
      return;
    }

    this.suggestions = buildSuggestions({
      input: normalizeSlashPrefix(this.input),
      runs: this.runIndex.map((run) => ({
        id: run.id,
        title: run.title,
        currentNode: run.currentNode,
        status: run.status,
        updatedAt: run.updatedAt
      }))
    });

    if (this.selectedSuggestion >= this.suggestions.length) {
      this.selectedSuggestion = 0;
    }
  }

  private autocompleteSelectedSuggestion(): void {
    if (this.suggestions.length === 0) {
      return;
    }
    this.exitHistoryBrowsing();
    const suggestion = this.suggestions[this.selectedSuggestion];
    this.input = suggestion.applyValue;
    this.cursorIndex = Array.from(this.input).length;
    this.updateSuggestions();
  }

  private previewSelectedSuggestion(): void {
    if (this.suggestions.length === 0) {
      return;
    }
    const selected = this.suggestions[this.selectedSuggestion];
    this.input = selected.applyValue;
    this.cursorIndex = Array.from(this.input).length;
  }

  private moveSelectionMenu(step: number): void {
    const menu = this.activeSelectionMenu;
    if (!menu || menu.options.length === 0) {
      return;
    }
    menu.selectedIndex = (menu.selectedIndex + step + menu.options.length) % menu.options.length;
    this.render();
  }

  private commitSelectionMenu(): void {
    const menu = this.activeSelectionMenu;
    if (!menu) {
      return;
    }
    const value = menu.options[menu.selectedIndex];
    const resolve = menu.resolve;
    this.activeSelectionMenu = undefined;
    resolve(value);
    this.render();
  }

  private cancelSelectionMenu(): void {
    const menu = this.activeSelectionMenu;
    if (!menu) {
      return;
    }
    const resolve = menu.resolve;
    this.activeSelectionMenu = undefined;
    resolve(undefined);
    this.render();
  }

  private async handleEnter(): Promise<void> {
    const text = normalizeSlashPrefix(this.input).trim();
    this.input = "";
    this.cursorIndex = 0;
    this.suggestions = [];
    this.selectedSuggestion = 0;
    this.render();

    if (!text) {
      return;
    }

    if (!(this.pendingNaturalCommand && !isSlashPrefixed(text) && isConfirmationInput(text))) {
      await this.recordHistory(text);
    }

    if (this.busy) {
      if (this.activeNaturalRequest) {
        const steering = normalizeSteeringInput(text);
        if (!steering) {
          return;
        }
        this.applySteeringInput(steering);
        return;
      }
      this.queuedInputs.push(text);
      this.pushLog(`Queued turn: ${oneLine(text)}`);
      this.render();
      return;
    }

    await this.executeInput(text);
  }

  private async executeInput(text: string): Promise<void> {
    if (!text) {
      return;
    }

    if (this.pendingNaturalCommand && !isSlashPrefixed(text)) {
      await this.handlePendingNaturalConfirmation(text);
      return;
    }

    if (!isSlashPrefixed(text)) {
      await this.handleNaturalInput(text);
      return;
    }

    if (this.pendingNaturalCommand) {
      const pending = this.pendingNaturalCommand.command;
      this.pendingNaturalCommand = undefined;
      this.pushLog(`Pending natural action cleared: ${pending}`);
    }

    const parsed = parseSlashCommand(text);
    if (!parsed) {
      this.pushLog("Unable to parse command. Use /help.");
      this.render();
      return;
    }

    await this.runBusyAction(
      async (abortSignal) => {
        await this.executeParsedSlash(parsed.command, parsed.args, abortSignal);
      },
      `/${parsed.command}`
    );
  }

  private async handleNaturalInput(text: string): Promise<void> {
    await this.runBusyAction(async (busyAbortSignal) => {
      await this.refreshRunIndex();
      this.pushLog(`Natural query: ${oneLine(text)}`);

      const fastHandled = await this.handleFastNaturalIntent(text, busyAbortSignal);
      if (fastHandled) {
        return;
      }

      let steeringHints: string[] = [];

      while (true) {
        this.steeringBufferDuringThinking = [];
        const abortController = new AbortController();
        const forwardAbort = () => abortController.abort();
        if (busyAbortSignal.aborted) {
          abortController.abort();
        } else {
          busyAbortSignal.addEventListener("abort", forwardAbort, { once: true });
        }
        this.activeNaturalRequest = {
          input: text,
          steeringHints: [...steeringHints],
          abortController
        };

        this.startThinking();
        this.render();

        let response: Awaited<ReturnType<typeof buildNaturalAssistantResponseWithLlm>> | undefined;
        try {
          response = await buildNaturalAssistantResponseWithLlm({
            input: text,
            runs: this.runIndex,
            activeRunId: this.activeRunId,
            logs: this.logs,
            codex: this.codex,
            workspaceRoot: process.cwd(),
            steeringHints,
            abortSignal: abortController.signal,
            onProgress: (line) => {
              this.pushLog(oneLine(line));
              this.advanceThinkingFrame();
              this.render();
            }
          });
        } catch (error) {
          if (this.isSteeringAbort(error)) {
            const buffered = this.consumeSteeringBuffer();
            if (buffered.length > 0) {
              steeringHints = this.mergeSteeringHints(steeringHints, buffered);
              this.pushLog(`Steering applied (${buffered.length}). Re-running...`);
              continue;
            }
            if (busyAbortSignal.aborted) {
              return;
            }
          }
          throw error;
        } finally {
          busyAbortSignal.removeEventListener("abort", forwardAbort);
          this.activeNaturalRequest = undefined;
          this.stopThinking();
        }

        const bufferedAfter = this.consumeSteeringBuffer();
        if (bufferedAfter.length > 0) {
          steeringHints = this.mergeSteeringHints(steeringHints, bufferedAfter);
          this.pushLog(`Steering applied (${bufferedAfter.length}). Re-running...`);
          continue;
        }

        if (!response) {
          return;
        }

        if (response.targetRunId) {
          await this.setActiveRunId(response.targetRunId);
        }

        for (const line of response.lines) {
          this.pushLog(line);
        }

        if (response.pendingCommand) {
          this.pendingNaturalCommand = {
            command: response.pendingCommand,
            sourceInput: text,
            createdAt: new Date().toISOString()
          };
          this.pushLog(`Execution intent detected. Pending command: ${response.pendingCommand}`);
          this.pushLog("Type 'y' to run now, or 'n' to cancel.");
        }
        return;
      }
    });
  }

  private async handlePendingNaturalConfirmation(text: string): Promise<void> {
    const pending = this.pendingNaturalCommand;
    if (!pending) {
      return;
    }

    const normalized = text.trim().toLowerCase();
    if (isAffirmative(normalized)) {
      this.pendingNaturalCommand = undefined;
      await this.runBusyAction(async (abortSignal) => {
        if (abortSignal.aborted) {
          return;
        }
        this.pushLog(`Confirmed. Running: ${pending.command}`);
        const parsed = parseSlashCommand(pending.command);
        if (!parsed) {
          this.pushLog(`Failed to parse pending command: ${pending.command}`);
          return;
        }
        await this.executeParsedSlash(parsed.command, parsed.args, abortSignal);
      }, "pending natural command");
      return;
    }

    if (isNegative(normalized)) {
      this.pendingNaturalCommand = undefined;
      this.pushLog(`Canceled pending command: ${pending.command}`);
      this.render();
      return;
    }

    this.pushLog(`Pending command: ${pending.command}`);
    this.pushLog("Type 'y' to run it, or 'n' to cancel.");
    this.render();
  }

  private async runBusyAction(
    action: (abortSignal: AbortSignal) => Promise<void>,
    label = "operation"
  ): Promise<void> {
    const abortController = new AbortController();
    this.activeBusyAbortController = abortController;
    this.activeBusyLabel = label;
    this.busy = true;
    this.render();
    try {
      await action(abortController.signal);
    } catch (error) {
      if (this.isAbortError(error)) {
        this.pushLog(`Canceled: ${label}`);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.pushLog(`Error: ${message}`);
    } finally {
      if (this.activeBusyAbortController === abortController) {
        this.activeBusyAbortController = undefined;
        this.activeBusyLabel = undefined;
      }
      this.busy = false;
      this.updateSuggestions();
      this.render();
      void this.drainQueuedInputs();
    }
  }

  private async handleFastNaturalIntent(text: string, abortSignal: AbortSignal): Promise<boolean> {
    if (abortSignal.aborted) {
      return true;
    }

    if (isClearCollectedPapersIntent(text)) {
      const run = await this.resolveTargetRun(undefined);
      if (!run) {
        return true;
      }
      this.pushLog("Detected paper cleanup intent.");
      this.pushLog(`Running immediately: /agent clear collect_papers ${run.id}`);
      await this.executeParsedSlash("agent", ["clear", "collect_papers", run.id], abortSignal);
      return true;
    }

    const run = await this.resolveTargetRun(undefined);
    if (!run) {
      return false;
    }

    const language = detectQueryLanguage(text);
    const insights = await this.readCorpusInsights(run.id);

    if (isMissingPdfCountIntent(text)) {
      if (insights.totalPapers === 0) {
        this.pushLog(
          language === "ko"
            ? "현재 run에 수집된 논문이 없습니다."
            : "No collected papers were found in the current run."
        );
        return true;
      }
      this.pushLog(
        language === "ko"
          ? `PDF 경로가 없는 논문은 ${insights.missingPdfCount}편입니다. (총 ${insights.totalPapers}편)`
          : `Papers without a PDF path: ${insights.missingPdfCount} (out of ${insights.totalPapers}).`
      );
      return true;
    }

    if (isTopCitationIntent(text)) {
      if (insights.totalPapers === 0) {
        this.pushLog(
          language === "ko"
            ? "현재 run에 수집된 논문이 없습니다."
            : "No collected papers were found in the current run."
        );
        return true;
      }
      if (!insights.topCitation) {
        this.pushLog(
          language === "ko"
            ? "수집된 논문에 citation 정보가 없어 최고 citation 논문을 계산할 수 없습니다."
            : "Citation metadata is missing, so I cannot compute the top-cited paper."
        );
        return true;
      }
      this.pushLog(
        language === "ko"
          ? `citation이 가장 높은 논문은 "${insights.topCitation.title}"이며 citation_count는 ${insights.topCitation.citationCount}회입니다.`
          : `The top-cited paper is "${insights.topCitation.title}" with ${insights.topCitation.citationCount} citations.`
      );
      return true;
    }

    if (isPaperCountIntent(text)) {
      this.pushLog(
        language === "ko"
          ? `현재 수집된 논문은 ${insights.totalPapers}편입니다.`
          : `The current run has ${insights.totalPapers} collected papers.`
      );
      return true;
    }

    if (isPaperTitleIntent(text)) {
      const limit = extractRequestedTitleCount(text);
      const titles = insights.titles.slice(0, limit);
      if (titles.length === 0) {
        this.pushLog(
          language === "ko"
            ? "현재 run에 수집된 논문 제목이 없습니다."
            : "No collected paper titles were found in the current run."
        );
        return true;
      }

      this.pushLog(
        language === "ko"
          ? `논문 제목 ${titles.length}개입니다.`
          : `Here are ${titles.length} paper title(s).`
      );
      titles.forEach((title, idx) => {
        this.pushLog(`${idx + 1}. ${title}`);
      });
      return true;
    }

    return false;
  }

  private async drainQueuedInputs(): Promise<void> {
    if (this.drainingQueuedInputs || this.stopped || this.busy || this.queuedInputs.length === 0) {
      return;
    }

    this.drainingQueuedInputs = true;
    try {
      while (!this.stopped && !this.busy && this.queuedInputs.length > 0) {
        const next = this.queuedInputs.shift();
        if (!next) {
          break;
        }
        this.pushLog(`Running queued input: ${oneLine(next)}`);
        this.render();
        await this.executeInput(next);
      }
    } finally {
      this.drainingQueuedInputs = false;
    }
  }

  private consumeSteeringBuffer(): string[] {
    const buffered = [...this.steeringBufferDuringThinking];
    this.steeringBufferDuringThinking = [];
    return buffered;
  }

  private mergeSteeringHints(base: string[], incoming: string[]): string[] {
    const merged = [...base];
    for (const hint of incoming) {
      const normalized = oneLine(hint);
      if (!normalized) {
        continue;
      }
      if (!merged.some((x) => oneLine(x) === normalized)) {
        merged.push(hint);
      }
    }
    return merged.slice(-8);
  }

  private async recordHistory(text: string): Promise<void> {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    const last = this.commandHistory[this.commandHistory.length - 1];
    if (last !== normalized) {
      this.commandHistory.push(normalized);
      if (this.commandHistory.length > 300) {
        this.commandHistory = this.commandHistory.slice(-300);
      }
    }
    this.historyCursor = -1;
    this.historyDraft = "";
    await this.persistHistoryForActiveRun();
  }

  private recallPreviousHistory(): boolean {
    if (this.commandHistory.length === 0) {
      return false;
    }

    if (this.historyCursor === -1) {
      this.historyDraft = this.input;
      this.historyCursor = this.commandHistory.length - 1;
    } else if (this.historyCursor > 0) {
      this.historyCursor -= 1;
    } else {
      return false;
    }

    this.input = this.commandHistory[this.historyCursor] || "";
    this.cursorIndex = Array.from(this.input).length;
    this.updateSuggestions();
    return true;
  }

  private recallNextHistory(): boolean {
    if (this.historyCursor === -1) {
      return false;
    }

    if (this.historyCursor < this.commandHistory.length - 1) {
      this.historyCursor += 1;
      this.input = this.commandHistory[this.historyCursor] || "";
    } else {
      this.historyCursor = -1;
      this.input = this.historyDraft;
      this.historyDraft = "";
    }

    this.cursorIndex = Array.from(this.input).length;
    this.updateSuggestions();
    return true;
  }

  private exitHistoryBrowsing(): void {
    if (this.historyCursor !== -1) {
      this.historyCursor = -1;
      this.historyDraft = "";
    }
  }

  private cancelCurrentBusyOperation(): void {
    if (!this.busy) {
      return;
    }

    if (this.activeNaturalRequest && !this.activeNaturalRequest.abortController.signal.aborted) {
      this.pushLog(`Cancel requested: ${oneLine(this.activeNaturalRequest.input)}`);
      this.activeNaturalRequest.abortController.abort();
      this.render();
      return;
    }

    if (this.activeBusyAbortController && !this.activeBusyAbortController.signal.aborted) {
      const label = this.activeBusyLabel || "operation";
      this.pushLog(`Cancel requested: ${label}`);
      this.activeBusyAbortController.abort();
      this.render();
      return;
    }
  }

  private isAbortError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const message = error.message.toLowerCase();
    return message.includes("aborted") || message.includes("abort");
  }

  private isSteeringAbort(error: unknown): boolean {
    return this.isAbortError(error);
  }

  private applySteeringInput(instruction: string): void {
    if (!this.activeNaturalRequest) {
      return;
    }
    this.steeringBufferDuringThinking.push(instruction);
    this.pushLog(`Natural query: ${oneLine(instruction)}`);
    this.pushLog("Replanning current natural query with latest steering...");
    this.activeNaturalRequest.abortController.abort();
    this.render();
  }

  private async executeParsedSlash(
    command: string,
    args: string[],
    abortSignal?: AbortSignal
  ): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted by user");
    }
    switch (command) {
      case "help":
        this.printHelp();
        return;
      case "new":
        await this.handleNewRun();
        return;
      case "doctor":
        await this.handleDoctor();
        return;
      case "runs":
        await this.handleRuns(args);
        return;
      case "run":
        await this.handleRunSelect(args, false);
        return;
      case "resume":
        await this.handleRunSelect(args, true);
        return;
      case "agent":
        await this.handleAgent(args, abortSignal);
        return;
      case "approve":
        await this.handleApprove();
        return;
      case "retry":
        await this.handleRetry();
        return;
      case "settings":
        await this.handleSettings();
        return;
      case "model":
        await this.handleModel(args);
        return;
      case "quit":
        await this.shutdown();
        return;
      default:
        this.pushLog(`Unknown command: /${command}`);
    }
  }

  private printHelp(): void {
    this.pushLog("Available commands:");
    this.pushLog("/help, /new, /doctor, /runs, /run <run>, /resume <run>");
    this.pushLog("/agent list | /agent run <node> [run] | /agent status [run]");
    this.pushLog("/agent collect [query] [options] | /agent recollect <n> [run]");
    this.pushLog("/agent clear <node> [run] | /agent count <node> [run] | /agent clear_papers [run]");
    this.pushLog("/agent focus <node>");
    this.pushLog("/agent graph [run] | /agent resume [run] [checkpoint] | /agent retry [node] [run]");
    this.pushLog("/agent jump <node> [run] [--force] | /agent budget [run]");
    this.pushLog("Collect options: --run --limit --additional --last-years --year --date-range --sort --order --field --venue --type --min-citations --open-access --bibtex --dry-run");
    this.pushLog("/model");
    this.pushLog("/approve, /retry, /settings, /quit");
    this.pushLog("While Thinking: any input is treated as steering for the current turn.");
    this.pushLog("Natural language is supported. Example: What should I do next?");
    this.pushLog("If natural input requests execution, confirm with 'y' or cancel with 'n'.");
  }

  private async handleNewRun(): Promise<void> {
    const topic = await this.askWithinTui("Topic", this.config.research.default_topic);
    const constraintsRaw = await this.askWithinTui(
      "Constraints (comma-separated)",
      this.config.research.default_constraints.join(", ")
    );
    const objectiveMetric = await this.askWithinTui(
      "Objective metric",
      this.config.research.default_objective_metric
    );

    const constraints = constraintsRaw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    this.pushLog("Generating run title with Codex...");
    this.render();

    const title = await this.titleGenerator.generateTitle(topic, constraints, objectiveMetric);
    const run = await this.runStore.createRun({
      title,
      topic,
      constraints,
      objectiveMetric
    });

    await this.setActiveRunId(run.id);
    this.pushLog(`Created run ${run.id}`);
    this.pushLog(`Title: ${run.title}`);
    await this.refreshRunIndex();
  }

  private async handleDoctor(): Promise<void> {
    const checks = await runDoctor(this.codex);
    for (const check of checks) {
      const mark = check.ok ? "OK" : "FAIL";
      this.pushLog(`[${mark}] ${check.name}: ${check.detail}`);
    }
  }

  private async handleRuns(args: string[]): Promise<void> {
    const query = args.join(" ").trim();
    const runs = query ? await this.runStore.searchRuns(query) : await this.runStore.listRuns();
    if (runs.length === 0) {
      this.pushLog("No runs found.");
      return;
    }

    this.pushLog(`Found ${runs.length} run(s):`);
    for (const run of runs.slice(0, 20)) {
      this.pushLog(`${run.id} | ${run.title} | ${run.currentNode} | ${run.status}`);
    }
  }

  private async handleRunSelect(args: string[], resume: boolean): Promise<void> {
    const query = args.join(" ").trim();
    if (!query) {
      this.pushLog(`Usage: /${resume ? "resume" : "run"} <run>`);
      return;
    }

    const runs = await this.runStore.listRuns();
    const run = resolveRunByQuery(runs, query);
    if (!run) {
      this.pushLog(`Run not found for query: ${query}`);
      return;
    }

    await this.setActiveRunId(run.id);
    this.pushLog(`Selected run ${run.id}: ${run.title}`);

    if (resume) {
      await this.orchestrator.resumeRun(run.id);
      this.pushLog("Run resumed from latest checkpoint state.");
    }

    await this.refreshRunIndex();
  }

  private async handleAgent(args: string[], abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted by user");
    }
    const sub = (args[0] || "").toLowerCase();

    if (!sub || sub === "list") {
      this.pushLog(`Graph nodes: ${AGENT_ORDER.join(", ")}`);
      return;
    }

    if (sub === "run") {
      const nodeRaw = args[1] as AgentId | undefined;
      if (!nodeRaw) {
        this.pushLog("Usage: /agent run <node> [run]");
        return;
      }
      if (!AGENT_ORDER.includes(nodeRaw)) {
        this.pushLog(`Unknown node: ${nodeRaw}`);
        return;
      }

      const runQuery = args.slice(2).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      await this.setActiveRunId(run.id);
      const response = await this.orchestrator.runAgentWithOptions(run.id, nodeRaw, { abortSignal });
      await this.refreshRunIndex();

      if (response.result.status === "failure") {
        this.pushLog(`Node ${nodeRaw} failed: ${response.result.error || "unknown error"}`);
        return;
      }

      this.pushLog(`Node ${nodeRaw} finished: ${oneLine(response.result.summary)}`);
      return;
    }

    if (sub === "status") {
      const runQuery = args.slice(1).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      await this.setActiveRunId(run.id);
      this.pushLog(`Run ${run.id}: ${run.title}`);
      this.pushLog(`Current node: ${run.currentNode} | run status: ${run.status}`);
      for (const node of AGENT_ORDER) {
        const state = run.graph.nodeStates[node];
        const retry = run.graph.retryCounters[node] ?? 0;
        const rollback = run.graph.rollbackCounters[node] ?? 0;
        this.pushLog(`- ${node}: ${state.status} (retry=${retry}, rollback=${rollback})`);
      }
      return;
    }

    if (sub === "collect") {
      await this.handleAgentCollect(args.slice(1), abortSignal);
      return;
    }

    if (sub === "recollect") {
      const countRaw = args[1];
      const additional = Number(countRaw);
      if (!countRaw || !Number.isFinite(additional) || additional <= 0) {
        this.pushLog("Usage: /agent recollect <additional_count> [run]");
        return;
      }

      const normalizedAdditional = Math.max(1, Math.floor(additional));
      const runQuery = args.slice(2).join(" ").trim() || undefined;
      const collectArgs = ["--additional", String(normalizedAdditional)];
      if (runQuery) {
        collectArgs.push("--run", runQuery);
      }
      await this.handleAgentCollect(collectArgs, abortSignal, true);
      return;
    }

    if (sub === "count" || sub === "개수조회") {
      const nodeRaw = args[1] as GraphNodeId | undefined;
      if (!nodeRaw || !AGENT_ORDER.includes(nodeRaw)) {
        this.pushLog("Usage: /agent count <node> [run]");
        return;
      }
      const runQuery = args.slice(2).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }
      const countSummary = await this.countNodeArtifacts(run, nodeRaw);
      this.pushLog(countSummary);
      return;
    }

    if (sub === "clear") {
      const nodeRaw = args[1] as GraphNodeId | undefined;
      if (!nodeRaw || !AGENT_ORDER.includes(nodeRaw)) {
        this.pushLog("Usage: /agent clear <node> [run]");
        return;
      }
      const runQuery = args.slice(2).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }
      const removed = await this.clearNodeArtifacts(run, nodeRaw);
      await this.resetRunFromNode(run.id, nodeRaw, `clear ${nodeRaw}`);
      await this.setActiveRunId(run.id);
      this.pushLog(`Cleared ${nodeRaw} artifacts: ${removed} item(s).`);
      this.pushLog(`Run reset from ${nodeRaw} (pending).`);
      await this.refreshRunIndex();
      return;
    }

    if (sub === "clear_papers") {
      const runQuery = args.slice(1).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const removed = await this.clearNodeArtifacts(run, "collect_papers");
      await this.resetRunFromNode(run.id, "collect_papers", "clear collect_papers");
      await this.setActiveRunId(run.id);
      this.pushLog(`Cleared paper artifacts: ${removed} file(s).`);
      this.pushLog("Run reset to collect_papers (pending).");
      await this.refreshRunIndex();
      return;
    }

    if (sub === "focus") {
      const nodeRaw = args[1] as GraphNodeId | undefined;
      if (!nodeRaw || !AGENT_ORDER.includes(nodeRaw)) {
        this.pushLog("Usage: /agent focus <node>");
        return;
      }
      const run = await this.resolveTargetRun(undefined);
      if (!run) {
        return;
      }
      await this.orchestrator.jumpToNode(run.id, nodeRaw, "safe", "focus command");
      this.pushLog(`Focused current node to ${nodeRaw}.`);
      await this.refreshRunIndex();
      return;
    }

    if (sub === "graph") {
      const runQuery = args.slice(1).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const graph = await this.orchestrator.getGraphStatus(run.id);
      this.pushLog(`Graph checkpointSeq=${graph.checkpointSeq} current=${graph.currentNode}`);
      for (const node of AGENT_ORDER) {
        this.pushLog(`- ${node}: ${graph.nodeStates[node].status}`);
      }
      return;
    }

    if (sub === "resume") {
      const runQuery = args[1] || undefined;
      const checkpointRaw = args[2] || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const checkpoint = checkpointRaw ? Number(checkpointRaw) : undefined;
      await this.orchestrator.resumeRun(run.id, Number.isFinite(checkpoint ?? NaN) ? checkpoint : undefined);
      this.pushLog(`Resumed run ${run.id}${checkpoint ? ` from checkpoint ${checkpoint}` : ""}.`);
      await this.refreshRunIndex();
      return;
    }

    if (sub === "retry") {
      const nodeRaw = args[1] as GraphNodeId | undefined;
      const runQuery = args.slice(2).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const node = nodeRaw && AGENT_ORDER.includes(nodeRaw) ? nodeRaw : undefined;
      const updated = await this.orchestrator.retryCurrent(run.id, node);
      this.pushLog(`Retry armed for ${updated.currentNode}.`);
      await this.refreshRunIndex();
      return;
    }

    if (sub === "jump") {
      const nodeRaw = args[1] as GraphNodeId | undefined;
      if (!nodeRaw || !AGENT_ORDER.includes(nodeRaw)) {
        this.pushLog("Usage: /agent jump <node> [run] [--force]");
        return;
      }

      const force = args.includes("--force");
      const runQuery = args
        .slice(2)
        .filter((x) => x !== "--force")
        .join(" ")
        .trim() || undefined;

      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const mode = force ? "force" : "safe";
      await this.orchestrator.jumpToNode(run.id, nodeRaw, mode, "manual jump command");
      this.pushLog(`Jumped to ${nodeRaw} (${mode}).`);
      await this.refreshRunIndex();
      return;
    }

    if (sub === "budget") {
      const runQuery = args.slice(1).join(" ").trim() || undefined;
      const run = await this.resolveTargetRun(runQuery);
      if (!run) {
        return;
      }

      const budget = await this.orchestrator.getBudgetStatus(run.id);
      this.pushLog(
        `Budget: tools ${budget.toolCallsUsed}/${budget.policy.maxToolCalls}, time ${(budget.wallClockMsUsed / 60000).toFixed(1)}m/${budget.policy.maxWallClockMinutes}m, usd ${budget.usdUsed ?? 0}/${budget.policy.maxUsd}`
      );
      return;
    }

    this.pushLog(
      "Usage: /agent list | run | status | collect | recollect | clear | count | clear_papers | focus | graph | resume | retry | jump | budget"
    );
  }

  private async handleAgentCollect(
    rawArgs: string[],
    abortSignal?: AbortSignal,
    fromRecollectAlias = false
  ): Promise<void> {
    const parsed = parseCollectArgs(rawArgs);
    if (!parsed.ok || !parsed.request) {
      for (const error of parsed.errors) {
        this.pushLog(`Collect option error: ${error}`);
      }
      this.pushLog(parsed.usage || COLLECT_USAGE);
      return;
    }

    const request = parsed.request;
    for (const warning of request.warnings) {
      this.pushLog(`Collect option warning: ${warning}`);
    }

    const runQuery = request.runQuery?.trim() || undefined;
    const run = await this.resolveTargetRun(runQuery);
    if (!run) {
      return;
    }

    if (abortSignal?.aborted) {
      throw new Error("Operation aborted by user");
    }

    await this.setActiveRunId(run.id);

    const corpusCount = await this.readCorpusCount(run.id);
    const configuredLimit = Math.max(1, this.config.papers.max_results);
    const targetTotal = request.additional ? corpusCount + request.additional : request.limit ?? configuredLimit;
    const query = request.query?.trim() || run.topic;
    const filters = normalizeCollectFiltersForNode(request);
    const endpoint = request.sort.field === "relevance" ? "/paper/search" : "/paper/search/bulk";
    const nodeRequest = {
      query,
      limit: targetTotal,
      additional: request.additional,
      sort: request.sort,
      filters,
      bibtexMode: request.bibtexMode
    };

    if (request.dryRun) {
      this.pushLog("Collect dry-run plan:");
      this.pushLog(`- run: ${run.id} (${run.title})`);
      this.pushLog(`- query: ${query}`);
      this.pushLog(`- target_total: ${targetTotal} (current ${corpusCount})`);
      this.pushLog(`- endpoint: ${endpoint}`);
      this.pushLog(`- sort: ${request.sort.field}:${request.sort.order}`);
      this.pushLog(`- bibtex: ${request.bibtexMode}`);
      this.pushLog(`- filters: ${JSON.stringify(filters)}`);
      return;
    }

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    await runContext.put("collect_papers.request", nodeRequest);
    await runContext.put("collect_papers.requested_limit", targetTotal);

    await this.orchestrator.jumpToNode(
      run.id,
      "collect_papers",
      "safe",
      fromRecollectAlias ? `recollect +${request.additional ?? 0}` : "collect command"
    );

    const summaryPrefix = request.additional
      ? `Moving to collect_papers and requesting +${request.additional} papers (target total ${targetTotal}).`
      : `Moving to collect_papers with target total ${targetTotal}.`;
    this.pushLog(summaryPrefix);

    const response = await this.orchestrator.runAgentWithOptions(run.id, "collect_papers", {
      abortSignal
    });
    await this.refreshRunIndex();
    if (response.result.status === "failure") {
      this.pushLog(`collect_papers failed: ${response.result.error || "unknown error"}`);
      return;
    }

    this.pushLog(`collect_papers finished: ${oneLine(response.result.summary)}`);
  }

  private async handleApprove(): Promise<void> {
    const run = await this.resolveTargetRun(undefined);
    if (!run) {
      return;
    }

    const updated = await this.orchestrator.approveCurrent(run.id);
    if (updated.status === "completed") {
      this.pushLog("Run completed.");
    } else {
      this.pushLog(`Approved ${run.currentNode}. Next node is ${updated.currentNode}.`);
    }

    await this.refreshRunIndex();
  }

  private async handleRetry(): Promise<void> {
    const run = await this.resolveTargetRun(undefined);
    if (!run) {
      return;
    }

    const updated = await this.orchestrator.retryCurrent(run.id);
    this.pushLog(`Retry set for node ${updated.currentNode}.`);
    await this.refreshRunIndex();
  }

  private async handleSettings(): Promise<void> {
    const topic = await this.askWithinTui("Default topic", this.config.research.default_topic);
    const constraintsRaw = await this.askWithinTui(
      "Default constraints",
      this.config.research.default_constraints.join(", ")
    );
    const metric = await this.askWithinTui(
      "Default objective metric",
      this.config.research.default_objective_metric
    );

    this.config.research.default_topic = topic;
    this.config.research.default_constraints = constraintsRaw
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    this.config.research.default_objective_metric = metric;

    await this.saveConfigFn(this.config);
    this.pushLog("Settings saved.");
  }

  private async handleModel(args: string[]): Promise<void> {
    if (args.length > 0) {
      this.pushLog("`/model` has no subcommands. Run `/model` and choose from the selector.");
      return;
    }

    this.pushCurrentModelDefaults();
    const model = await this.openSelectionMenu(
      "Select model",
      this.buildModelSelectionChoices(),
      this.config.providers.codex.model
    );
    if (!model) {
      this.pushLog("Model selection canceled.");
      return;
    }

    const reasoningChoices = getReasoningEffortChoicesForModel(model);
    const currentEffort = normalizeReasoningEffortForModel(model, this.config.providers.codex.reasoning_effort);
    const effort = await this.openSelectionMenu(
      "Select reasoning effort",
      reasoningChoices,
      currentEffort
    );
    if (!effort) {
      this.pushLog("Model selection canceled.");
      return;
    }

    this.config.providers.codex.model = model;
    this.config.providers.codex.reasoning_effort = effort as CodexReasoningEffort;
    this.codex.updateDefaults({
      model,
      reasoningEffort: effort as CodexReasoningEffort
    });
    await this.saveConfigFn(this.config);
    this.pushLog(`Codex model updated: ${model} (reasoning: ${effort}).`);
    this.pushCurrentModelDefaults();
  }

  private pushCurrentModelDefaults(): void {
    const model = this.config.providers.codex.model;
    const effort = this.config.providers.codex.reasoning_effort;
    this.pushLog(`Codex defaults: model=${model}, reasoning=${effort}`);
  }

  private buildModelSelectionChoices(): string[] {
    return buildCodexModelSelectionChoices(
      this.config.providers.codex.model,
      process.env.AUTORESEARCH_MODEL_CHOICES || ""
    );
  }

  private async openSelectionMenu(
    label: string,
    options: readonly string[],
    currentValue: string
  ): Promise<string | undefined> {
    if (options.length === 0) {
      return undefined;
    }

    const selectedIndex = Math.max(0, options.findIndex((value) => value === currentValue));
    return new Promise<string | undefined>((resolve) => {
      this.activeSelectionMenu = {
        title: label,
        options: [...options],
        selectedIndex,
        resolve
      };
      this.render();
    });
  }

  private async resolveTargetRun(explicitQuery?: string): Promise<RunRecord | undefined> {
    const runs = await this.runStore.listRuns();

    if (explicitQuery) {
      const byQuery = resolveRunByQuery(runs, explicitQuery);
      if (!byQuery) {
        this.pushLog(`Run not found: ${explicitQuery}`);
      }
      return byQuery;
    }

    if (!this.activeRunId) {
      this.pushLog("No active run. Use /new or /run <run>.");
      return undefined;
    }

    const active = runs.find((run) => run.id === this.activeRunId);
    if (!active) {
      this.pushLog(`Active run not found: ${this.activeRunId}`);
      return undefined;
    }

    return active;
  }

  private async setActiveRunId(runId?: string): Promise<void> {
    if (this.activeRunId === runId) {
      return;
    }
    this.activeRunId = runId;
    await this.loadHistoryForRun(runId);
  }

  private async loadHistoryForRun(runId?: string): Promise<void> {
    this.exitHistoryBrowsing();
    if (!runId) {
      this.commandHistory = [];
      this.historyLoadedRunId = undefined;
      return;
    }

    if (this.historyLoadedRunId === runId) {
      return;
    }

    const filePath = this.historyFilePath(runId);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as RunHistoryFile;
      const items = Array.isArray(parsed.items)
        ? parsed.items
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(-300)
        : [];
      this.commandHistory = items;
    } catch {
      this.commandHistory = [];
    }
    this.historyLoadedRunId = runId;
  }

  private historyFilePath(runId: string): string {
    return path.join(process.cwd(), ".autoresearch", "runs", runId, "tui_history.json");
  }

  private async persistHistoryForActiveRun(): Promise<void> {
    const runId = this.activeRunId;
    if (!runId) {
      return;
    }
    const payload: RunHistoryFile = {
      version: 1,
      items: this.commandHistory.slice(-300)
    };
    const filePath = this.historyFilePath(runId);
    try {
      await ensureDir(path.dirname(filePath));
      await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
      this.historyLoadedRunId = runId;
    } catch {
      // Ignore history persistence failures to keep TUI responsive.
    }
  }

  private async askWithinTui(question: string, defaultValue = ""): Promise<string> {
    this.detachKeyboard();
    process.stdout.write("\n");
    const answer = await askLine(question, defaultValue);
    this.attachKeyboard();
    return answer;
  }

  private pushLog(line: string): void {
    this.logs.push(line);
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(-200);
    }
  }

  private async refreshRunIndex(): Promise<void> {
    this.runIndex = await this.runStore.listRuns();
    if (this.runIndex.length > 0) {
      if (!this.activeRunId) {
        await this.setActiveRunId(this.runIndex[0].id);
      } else if (!this.runIndex.some((run) => run.id === this.activeRunId)) {
        await this.setActiveRunId(this.runIndex[0].id);
      }
    } else if (this.activeRunId) {
      await this.setActiveRunId(undefined);
    }
    this.updateSuggestions();
  }

  private render(): void {
    const run = this.activeRunId ? this.runIndex.find((x) => x.id === this.activeRunId) : undefined;
    const frame = buildFrame({
      appVersion: this.appVersion,
      busy: this.busy,
      thinking: this.thinking,
      thinkingFrame: this.thinkingFrame,
      run,
      logs: this.logs,
      input: this.input,
      inputCursor: this.cursorIndex,
      suggestions: this.suggestions,
      selectedSuggestion: this.selectedSuggestion,
      colorEnabled: this.colorEnabled,
      selectionMenu: this.activeSelectionMenu
        ? {
            title: this.activeSelectionMenu.title,
            options: this.activeSelectionMenu.options,
            selectedIndex: this.activeSelectionMenu.selectedIndex
          }
        : undefined
    });

    process.stdout.write("\x1Bc");
    process.stdout.write(frame.lines.join("\n"));

    const up = frame.lines.length - frame.inputLineIndex;
    if (up > 0) {
      process.stdout.write(`\x1b[${up}A`);
    }
    process.stdout.write(`\x1b[${frame.inputColumn}G`);
  }

  private async readCorpusCount(runId: string): Promise<number> {
    const insights = await this.readCorpusInsights(runId);
    return insights.totalPapers;
  }

  private async readPaperTitles(runId: string, maxItems: number): Promise<string[]> {
    const insights = await this.readCorpusInsights(runId);
    return insights.titles.slice(0, maxItems);
  }

  private async readCorpusInsights(runId: string): Promise<CorpusInsights> {
    const filePath = path.join(process.cwd(), ".autoresearch", "runs", runId, "corpus.jsonl");
    try {
      const stat = await fs.stat(filePath);
      const cache = this.corpusInsightsCache.get(runId);
      if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
        return cache.insights;
      }

      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      const insights: CorpusInsights = {
        totalPapers: lines.length,
        missingPdfCount: 0,
        titles: []
      };

      let bestCitation = -1;

      for (const line of lines) {
        try {
          const row = JSON.parse(line) as Record<string, unknown>;

          const title = toNonEmptyString(row.title);
          if (title && insights.titles.length < 200) {
            insights.titles.push(title);
          }

          const pdfPath =
            toNonEmptyString(row.pdf_url) ||
            toNonEmptyString(row.open_access_pdf_url) ||
            readNestedUrl(row.open_access_pdf);
          const canonicalUrl = toNonEmptyString(row.url);
          const hasPdf = Boolean(pdfPath) || looksLikePdfUrl(canonicalUrl);
          if (!hasPdf) {
            insights.missingPdfCount += 1;
          }

          const citationRaw = row.citation_count ?? row.citationCount;
          const citation = toFiniteNumber(citationRaw);
          if (title && citation !== undefined && citation > bestCitation) {
            bestCitation = citation;
            insights.topCitation = {
              title,
              citationCount: citation
            };
          }
        } catch {
          insights.missingPdfCount += 1;
        }
      }

      this.corpusInsightsCache.set(runId, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        insights
      });
      return insights;
    } catch {
      return {
        totalPapers: 0,
        missingPdfCount: 0,
        titles: []
      };
    }
  }

  private async clearNodeArtifacts(run: RunRecord, node: GraphNodeId): Promise<number> {
    const runDir = path.join(process.cwd(), ".autoresearch", "runs", run.id);
    const targets = nodeArtifactTargets(node);

    let removed = 0;
    for (const relative of targets) {
      const fullPath = path.join(runDir, relative);
      try {
        const stat = await fs.stat(fullPath).catch(() => undefined);
        await fs.rm(fullPath, { force: true, recursive: stat?.isDirectory() || false });
        removed += 1;
      } catch {
        // ignore missing files
      }
    }

    const runContext = new RunContextMemory(run.memoryRefs.runContextPath);
    for (const key of nodeContextKeys(node)) {
      await runContext.put(key, null);
    }
    return removed;
  }

  private async resetRunFromNode(runId: string, node: GraphNodeId, reason: string): Promise<void> {
    const run = await this.runStore.getRun(runId);
    if (!run) {
      return;
    }
    const targetIdx = AGENT_ORDER.indexOf(node);
    if (targetIdx < 0) {
      return;
    }
    const now = new Date().toISOString();
    run.currentNode = node;
    run.graph.currentNode = node;
    run.status = "paused";
    run.latestSummary = `Artifacts cleared for ${node}; ready to rerun.`;
    run.graph.budget.toolCallsUsed = 0;
    run.graph.budget.wallClockMsUsed = 0;
    run.graph.budget.usdUsed = 0;
    for (let idx = targetIdx; idx < AGENT_ORDER.length; idx += 1) {
      const nodeId = AGENT_ORDER[idx];
      run.graph.nodeStates[nodeId] = {
        ...run.graph.nodeStates[nodeId],
        status: "pending",
        updatedAt: now,
        note: `Reset by ${reason}`,
        lastError: undefined
      };
      delete run.graph.retryCounters[nodeId];
      delete run.graph.rollbackCounters[nodeId];
    }
    await this.runStore.updateRun(run);
  }

  private async countNodeArtifacts(run: RunRecord, node: GraphNodeId): Promise<string> {
    const runDir = path.join(process.cwd(), ".autoresearch", "runs", run.id);
    switch (node) {
      case "collect_papers": {
        const count = await countJsonl(path.join(runDir, "corpus.jsonl"));
        return `Count(${node}): ${count} papers`;
      }
      case "analyze_papers": {
        const evidence = await countJsonl(path.join(runDir, "evidence_store.jsonl"));
        const summaries = await countJsonl(path.join(runDir, "paper_summaries.jsonl"));
        return `Count(${node}): ${evidence} evidences, ${summaries} summaries`;
      }
      case "generate_hypotheses": {
        const count = await countJsonl(path.join(runDir, "hypotheses.jsonl"));
        return `Count(${node}): ${count} hypotheses`;
      }
      case "design_experiments": {
        const count = await countYamlList(path.join(runDir, "experiment_plan.yaml"), "hypotheses:");
        return `Count(${node}): ${count} planned hypotheses`;
      }
      case "implement_experiments": {
        const exists = await pathExists(path.join(runDir, "experiment.py"));
        return `Count(${node}): ${exists ? 1 : 0} implementation file`;
      }
      case "run_experiments": {
        const runs = await countJsonl(path.join(runDir, "exec_logs", "observations.jsonl"));
        const metrics = await pathExists(path.join(runDir, "metrics.json"));
        return `Count(${node}): ${runs} execution logs, metrics ${metrics ? "present" : "missing"}`;
      }
      case "analyze_results": {
        const figures = await countDirFiles(path.join(runDir, "figures"));
        const metrics = await pathExists(path.join(runDir, "metrics.json"));
        return `Count(${node}): ${figures} figure files, metrics ${metrics ? "present" : "missing"}`;
      }
      case "write_paper": {
        const paperFiles = [
          "paper/main.tex",
          "paper/references.bib",
          "paper/evidence_links.json"
        ];
        let count = 0;
        for (const relative of paperFiles) {
          if (await pathExists(path.join(runDir, relative))) {
            count += 1;
          }
        }
        return `Count(${node}): ${count}/${paperFiles.length} paper artifacts`;
      }
      default:
        return `Count(${node}): unsupported`;
    }
  }

  private async shutdown(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.activeSelectionMenu) {
      const resolve = this.activeSelectionMenu.resolve;
      this.activeSelectionMenu = undefined;
      resolve(undefined);
    }
    this.stopThinking();
    this.detachKeyboard();
    process.stdin.pause();
    this.onQuit();
    this.resolver?.();
  }

  private startThinking(): void {
    if (this.thinking) {
      return;
    }
    this.thinking = true;
    this.thinkingFrame = 0;
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
    }
    this.thinkingTimer = setInterval(() => {
      if (!this.thinking || this.stopped) {
        return;
      }
      this.thinkingFrame = (this.thinkingFrame + 1) % 10_000;
      this.render();
    }, 120);
    this.render();
  }

  private stopThinking(): void {
    this.thinking = false;
    this.thinkingFrame = 0;
    if (this.thinkingTimer) {
      clearInterval(this.thinkingTimer);
      this.thinkingTimer = undefined;
    }
  }

  private advanceThinkingFrame(): void {
    if (!this.thinking) {
      return;
    }
    this.thinkingFrame = (this.thinkingFrame + 1) % 10_000;
  }
}

export async function launchTerminalApp(deps: TerminalAppDeps): Promise<void> {
  const app = new TerminalApp(deps);
  await app.start();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 220);
}

function isSlashPrefixed(text: string): boolean {
  return text.startsWith("/") || text.startsWith("／");
}

function normalizeSlashPrefix(text: string): string {
  if (text.startsWith("／")) {
    return `/${text.slice(1)}`;
  }
  return text;
}

function normalizeSteeringInput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function isConfirmationInput(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return isAffirmative(normalized) || isNegative(normalized);
}

function isClearCollectedPapersIntent(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasPaper = /논문|paper|papers/u.test(raw);
  const hasDelete = /삭제|제거|지워|없애|clear|remove|delete|purge/u.test(lower);
  const hasAll = /모든|모두|전체|전부|all/u.test(lower);
  return hasPaper && hasDelete && hasAll;
}

export function isPaperCountIntent(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasPaper = /논문|paper|papers/u.test(raw);
  const asksCount = /몇|개수|갯수|몇개|몇 개|how many|count|number/u.test(lower);
  const asksTitles = /제목|title|titles|목록|리스트|list/u.test(lower);
  const asksSpecificAttribute = /pdf|citation|인용|doi|저자|author|venue|journal|year|연도|field|분야|abstract|요약/u.test(
    lower
  );
  return hasPaper && asksCount && !asksTitles && !asksSpecificAttribute;
}

export function isMissingPdfCountIntent(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasPaper = /논문|paper|papers/u.test(raw);
  const hasPdf = /pdf|피디에프/u.test(lower);
  const asksMissing = /없|누락|missing|without|no\s+pdf/u.test(lower);
  const asksCount = /몇|개수|갯수|몇개|몇 개|how many|count|number/u.test(lower);
  return hasPaper && hasPdf && asksMissing && asksCount;
}

export function isTopCitationIntent(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasPaper = /논문|paper|papers/u.test(raw);
  const hasCitation = /citation|citations|cited|인용|피인용/u.test(lower);
  const asksTop = /가장|최고|높|top|highest|max|maximum|most|최다/u.test(lower);
  return hasPaper && hasCitation && asksTop;
}

function isPaperTitleIntent(text: string): boolean {
  const raw = text.trim();
  if (!raw) {
    return false;
  }
  const lower = raw.toLowerCase();
  const hasPaper = /논문|paper|papers/u.test(raw);
  const asksTitleOrList = /제목|title|titles|목록|리스트|list/u.test(lower);
  return hasPaper && asksTitleOrList;
}

function extractRequestedTitleCount(text: string): number {
  const lower = text.toLowerCase();
  if (/하나|한 개|한개|one\b/u.test(lower)) {
    return 1;
  }
  if (/두 개|두개|둘|two\b/u.test(lower)) {
    return 2;
  }
  if (/세 개|세개|셋|three\b/u.test(lower)) {
    return 3;
  }

  const match = lower.match(/(\d+)\s*(개|편|titles?|papers?)?/u);
  if (match?.[1]) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0) {
      return Math.min(20, Math.floor(value));
    }
  }

  return 5;
}

function detectQueryLanguage(text: string): "ko" | "en" {
  return /[\p{Script=Hangul}]/u.test(text) ? "ko" : "en";
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed);
    }
  }
  return undefined;
}

function readNestedUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return toNonEmptyString(record.url);
}

function looksLikePdfUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  return /\.pdf($|[?#])/i.test(url);
}

function isAffirmative(text: string): boolean {
  return ["y", "yes", "ok", "okay", "ㅇ", "네", "예", "응"].includes(text);
}

function isNegative(text: string): boolean {
  return ["n", "no", "cancel", "아니", "아니오", "취소"].includes(text);
}

function isWordDeleteShortcut(str: string, key: readline.Key): boolean {
  if (key.ctrl && key.name === "w") {
    return true;
  }

  // Some terminals encode Option+Backspace as ESC + DEL in raw mode.
  return str === "\u001b\u007f";
}

function isLineDeleteShortcut(str: string, key: readline.Key): boolean {
  if (key.ctrl && key.name === "u") {
    return true;
  }

  // Command+Backspace is often mapped to meta+backspace in terminal emulators.
  if (key.meta && key.name === "backspace" && str !== "\u001b\u007f") {
    return true;
  }

  return str === "\u0015";
}

function isWordMoveLeftShortcut(str: string, key: readline.Key): boolean {
  if (key.meta && key.name === "b") {
    return true;
  }

  // Common encodings for Option/Alt + Left.
  return str === "\u001bb" || str === "\u001b[1;3D";
}

function isWordMoveRightShortcut(str: string, key: readline.Key): boolean {
  if (key.meta && key.name === "f") {
    return true;
  }

  // Common encodings for Option/Alt + Right.
  return str === "\u001bf" || str === "\u001b[1;3C";
}

function isLineMoveLeftShortcut(str: string, key: readline.Key): boolean {
  if (key.ctrl && key.name === "a") {
    return true;
  }
  if (key.name === "home") {
    return true;
  }
  if (key.meta && key.name === "left") {
    return true;
  }

  // Common encodings for Home / Command+Left.
  return str === "\u001b[H" || str === "\u001bOH" || str === "\u001b[1~" || str === "\u001b[1;9D";
}

function isLineMoveRightShortcut(str: string, key: readline.Key): boolean {
  if (key.ctrl && key.name === "e") {
    return true;
  }
  if (key.name === "end") {
    return true;
  }
  if (key.meta && key.name === "right") {
    return true;
  }

  // Common encodings for End / Command+Right.
  return str === "\u001b[F" || str === "\u001bOF" || str === "\u001b[4~" || str === "\u001b[1;9C";
}

function nodeArtifactTargets(node: GraphNodeId): string[] {
  switch (node) {
    case "collect_papers":
      return ["corpus.jsonl", "bibtex.bib", "collect_request.json", "collect_result.json"];
    case "analyze_papers":
      return ["paper_summaries.jsonl", "evidence_store.jsonl"];
    case "generate_hypotheses":
      return ["hypotheses.jsonl"];
    case "design_experiments":
      return ["experiment_plan.yaml"];
    case "implement_experiments":
      return ["experiment.py"];
    case "run_experiments":
      return ["exec_logs/observations.jsonl", "exec_logs/run_experiments.txt", "metrics.json"];
    case "analyze_results":
      return ["figures", "metrics.json"];
    case "write_paper":
      return ["paper/main.tex", "paper/references.bib", "paper/evidence_links.json"];
    default:
      return [];
  }
}

function nodeContextKeys(node: GraphNodeId): string[] {
  switch (node) {
    case "collect_papers":
      return [
        "collect_papers.count",
        "collect_papers.source",
        "collect_papers.last_error",
        "collect_papers.requested_limit",
        "collect_papers.request",
        "collect_papers.last_request",
        "collect_papers.last_result"
      ];
    case "analyze_papers":
      return ["analyze_papers.evidence_count"];
    case "generate_hypotheses":
      return ["generate_hypotheses.top_k"];
    case "design_experiments":
      return ["design_experiments.primary"];
    case "implement_experiments":
      return ["implement_experiments.script"];
    default:
      return [];
  }
}

function normalizeCollectFiltersForNode(request: CollectCommandRequest): {
  dateRange?: string;
  year?: string;
  lastYears?: number;
  fieldsOfStudy?: string[];
  venues?: string[];
  publicationTypes?: string[];
  minCitationCount?: number;
  openAccessPdf?: boolean;
} {
  const filters = request.filters || {};
  const normalized: {
    dateRange?: string;
    year?: string;
    lastYears?: number;
    fieldsOfStudy?: string[];
    venues?: string[];
    publicationTypes?: string[];
    minCitationCount?: number;
    openAccessPdf?: boolean;
  } = {};

  if (filters.dateRange) {
    normalized.dateRange = filters.dateRange;
  } else if (filters.year) {
    normalized.year = filters.year;
  } else if (typeof filters.lastYears === "number" && filters.lastYears > 0) {
    normalized.lastYears = Math.floor(filters.lastYears);
  }

  if (filters.fieldsOfStudy && filters.fieldsOfStudy.length > 0) {
    normalized.fieldsOfStudy = filters.fieldsOfStudy;
  }
  if (filters.venues && filters.venues.length > 0) {
    normalized.venues = filters.venues;
  }
  if (filters.publicationTypes && filters.publicationTypes.length > 0) {
    normalized.publicationTypes = filters.publicationTypes;
  }
  if (typeof filters.minCitationCount === "number" && filters.minCitationCount > 0) {
    normalized.minCitationCount = Math.floor(filters.minCitationCount);
  }
  if (filters.openAccessPdf) {
    normalized.openAccessPdf = true;
  }

  return normalized;
}

async function countJsonl(filePath: string): Promise<number> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function countYamlList(filePath: string, sectionHeader: string): Promise<number> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n");
    let inSection = false;
    let count = 0;
    for (const line of lines) {
      if (!inSection) {
        if (line.trim() === sectionHeader) {
          inSection = true;
        }
        continue;
      }
      if (/^[a-zA-Z0-9_]+\s*:/.test(line.trim())) {
        break;
      }
      if (line.trim().startsWith("-")) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countDirFiles(dirPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isFile()) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
