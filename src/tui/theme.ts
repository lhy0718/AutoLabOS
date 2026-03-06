import process from "node:process";

export interface PaintStyle {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
}

export const reset = "\x1b[0m";

export function supportsColor(): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }
  if (process.env.TERM === "dumb") {
    return false;
  }
  return Boolean(process.stdout.isTTY);
}

export function fg(text: string, code: number, enabled = supportsColor()): string {
  return paint(text, { fg: code }, enabled);
}

export function bg(text: string, code: number, enabled = supportsColor()): string {
  return paint(text, { bg: code }, enabled);
}

export function bold(text: string, enabled = supportsColor()): string {
  return paint(text, { bold: true }, enabled);
}

export function dim(text: string, enabled = supportsColor()): string {
  return paint(text, { dim: true }, enabled);
}

export function paint(text: string, style: PaintStyle, enabled = supportsColor()): string {
  if (!enabled) {
    return text;
  }

  const codes: number[] = [];
  if (style.bold) {
    codes.push(1);
  }
  if (style.dim) {
    codes.push(2);
  }
  if (typeof style.fg === "number") {
    codes.push(style.fg);
  }
  if (typeof style.bg === "number") {
    codes.push(style.bg);
  }

  if (codes.length === 0) {
    return text;
  }
  return `\x1b[${codes.join(";")}m${text}${reset}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
