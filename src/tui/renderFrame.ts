import { RunRecord, SuggestionItem } from "../types.js";
import { paint } from "./theme.js";
import { getDisplayWidth } from "./displayWidth.js";

export interface RenderFrameInput {
  appVersion: string;
  busy: boolean;
  thinking: boolean;
  thinkingFrame: number;
  run?: RunRecord;
  logs: string[];
  input: string;
  inputCursor: number;
  suggestions: SuggestionItem[];
  selectedSuggestion: number;
  colorEnabled: boolean;
  selectionMenu?: {
    title: string;
    options: string[];
    selectedIndex: number;
  };
}

export interface RenderFrameOutput {
  lines: string[];
  inputLineIndex: number;
  inputColumn: number;
}

export function buildFrame(input: RenderFrameInput): RenderFrameOutput {
  const lines: string[] = [];

  lines.push(paint(`AutoResearch v${input.appVersion}`, { fg: 96, bold: true }, input.colorEnabled));

  if (input.run) {
    lines.push(renderLabelValue("Run", input.run.id, input.colorEnabled, true));
    lines.push(renderLabelValue("Title", input.run.title, input.colorEnabled, true));
    lines.push(
      renderLabelValue(
        "Node",
        `${input.run.currentNode} (${input.run.graph.nodeStates[input.run.currentNode].status})`,
        input.colorEnabled,
        true
      )
    );
  } else {
    lines.push(renderLabelValue("Run", "none", input.colorEnabled, true));
  }

  if (input.busy) {
    lines.push(paint("Busy", { fg: 33, bold: true }, input.colorEnabled));
  }

  lines.push("");
  lines.push(paint("Recent logs", { fg: 97, bold: true }, input.colorEnabled));

  const recentLogs = input.logs.slice(-12);
  if (recentLogs.length === 0) {
    lines.push(paint("no logs yet", { fg: 90 }, input.colorEnabled));
  } else {
    for (const log of recentLogs) {
      lines.push(renderLogLine(log, input.colorEnabled));
    }
  }

  if (input.thinking) {
    lines.push("");
    lines.push(renderThinkingText(input.thinkingFrame, input.colorEnabled));
  }

  lines.push("");
  const prompt = `${paint(">", { fg: 96, bold: true }, input.colorEnabled)} ${paint(input.input, { fg: 97 }, input.colorEnabled)}`;
  lines.push(prompt);
  const inputLineIndex = lines.length;
  const inputColumn = 3 + getDisplayWidth(sliceByChars(input.input, input.inputCursor));

  if (input.suggestions.length > 0) {
    lines.push("");
    input.suggestions.forEach((suggestion, idx) => {
      lines.push(renderSuggestionRow({
        suggestion,
        selected: idx === input.selectedSuggestion,
        colorEnabled: input.colorEnabled
      }));
    });
  }

  if (input.selectionMenu) {
    lines.push("");
    lines.push(
      paint(
        `${input.selectionMenu.title}  (↑/↓ move, Enter select, Esc cancel)`,
        { fg: 97, bold: true },
        input.colorEnabled
      )
    );
    input.selectionMenu.options.forEach((option, idx) => {
      lines.push(
        renderSelectionRow({
          option,
          selected: idx === input.selectionMenu?.selectedIndex,
          colorEnabled: input.colorEnabled
        })
      );
    });
  }

  return {
    lines,
    inputLineIndex,
    inputColumn
  };
}

function sliceByChars(text: string, count: number): string {
  return Array.from(text).slice(0, Math.max(0, count)).join("");
}

interface SuggestionRowArgs {
  suggestion: SuggestionItem;
  selected: boolean;
  colorEnabled: boolean;
}

function renderSuggestionRow(args: SuggestionRowArgs): string {
  const rowText = `${args.suggestion.label}  ${args.suggestion.description}`;
  if (args.selected) {
    return paint(rowText, { fg: 97, bg: 44, bold: true }, args.colorEnabled);
  }

  const command = paint(args.suggestion.label, { fg: 97 }, args.colorEnabled);
  const description = paint(args.suggestion.description, { fg: 90 }, args.colorEnabled);
  return `${command}  ${description}`;
}

interface SelectionRowArgs {
  option: string;
  selected: boolean;
  colorEnabled: boolean;
}

function renderSelectionRow(args: SelectionRowArgs): string {
  const text = `  ${args.option}`;
  if (args.selected) {
    return paint(text, { fg: 97, bg: 44, bold: true }, args.colorEnabled);
  }
  return paint(text, { fg: 97 }, args.colorEnabled);
}

function renderLabelValue(label: string, value: string, colorEnabled: boolean, emphasizeValue = false): string {
  return `${paint(`${label}:`, { fg: 97, bold: true }, colorEnabled)} ${paint(value, emphasizeValue ? { fg: 97 } : { fg: 90 }, colorEnabled)}`;
}

function renderLogLine(log: string, colorEnabled: boolean): string {
  const lower = log.toLowerCase();

  if (lower.startsWith("error:") || lower.includes("[fail]") || lower.includes("failed")) {
    return paint(log, { fg: 91, bold: true }, colorEnabled);
  }
  if (lower.startsWith("next step:") || lower.startsWith("execution intent detected")) {
    return paint(log, { fg: 97, bold: true }, colorEnabled);
  }
  if (log.startsWith("다음 단계:") || log.startsWith("실행 의도 감지")) {
    return paint(log, { fg: 97, bold: true }, colorEnabled);
  }
  if (
    lower.startsWith("natural query:") ||
    lower.startsWith("available commands:") ||
    lower.startsWith("current node:") ||
    lower.startsWith("budget:")
  ) {
    return paint(log, { fg: 97, bold: true }, colorEnabled);
  }
  if (log.startsWith("자연어 질의:") || log.startsWith("현재 노드:") || log.startsWith("예산:")) {
    return paint(log, { fg: 97, bold: true }, colorEnabled);
  }
  if (
    lower.startsWith("confirmed.") ||
    lower.startsWith("run ") ||
    lower.startsWith("run:") ||
    lower.startsWith("status:") ||
    lower.startsWith("workflow:") ||
    lower.startsWith("node ") ||
    lower.startsWith("created run") ||
    lower.startsWith("selected run") ||
    lower.startsWith("graph ") ||
    lower.startsWith("resumed run") ||
    lower.startsWith("retry ") ||
    lower.startsWith("approved ")
  ) {
    return paint(log, { fg: 97 }, colorEnabled);
  }
  if (
    log.startsWith("런:") ||
    log.startsWith("상태:") ||
    log.startsWith("워크플로:") ||
    log.startsWith("노드 ") ||
    log.startsWith("생성된 run") ||
    log.startsWith("선택된 run") ||
    log.startsWith("그래프 ") ||
    log.startsWith("재개됨") ||
    log.startsWith("재시도 ") ||
    log.startsWith("승인됨")
  ) {
    return paint(log, { fg: 97 }, colorEnabled);
  }
  if (lower.startsWith("type 'y'") || lower.startsWith("pending command:")) {
    return paint(log, { fg: 96, bold: true }, colorEnabled);
  }
  if (lower.startsWith("use the suggested")) {
    return paint(log, { fg: 90, dim: true }, colorEnabled);
  }
  return paint(log, { fg: 90 }, colorEnabled);
}

function renderThinkingText(frame: number, colorEnabled: boolean): string {
  const text = "Thinking...";
  if (!colorEnabled) {
    return text;
  }

  const chars = Array.from(text);
  const window = [90, 37, 97, 37, 90];
  const head = frame % (chars.length + window.length) - window.length;

  const painted = chars.map((ch, idx) => {
    const dist = idx - head;
    const shade = dist >= 0 && dist < window.length ? window[dist] : 90;
    const bold = shade === 97;
    return paint(ch, { fg: shade, bold }, colorEnabled);
  });

  return painted.join("");
}
