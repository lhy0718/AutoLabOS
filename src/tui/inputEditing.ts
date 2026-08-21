export function insertAtCursor(input: string, cursor: number, text: string): { input: string; cursor: number } {
  const chars = Array.from(input);
  const left = chars.slice(0, cursor).join("");
  const right = chars.slice(cursor).join("");
  const insert = Array.from(text).join("");
  return {
    input: `${left}${insert}${right}`,
    cursor: cursor + Array.from(insert).length
  };
}

export function deleteBackward(input: string, cursor: number): { input: string; cursor: number } {
  if (cursor <= 0) {
    return { input, cursor: 0 };
  }
  const chars = Array.from(input);
  chars.splice(cursor - 1, 1);
  return {
    input: chars.join(""),
    cursor: cursor - 1
  };
}

export function deletePreviousWord(input: string, cursor: number): { input: string; cursor: number } {
  if (!input || cursor <= 0) {
    return { input, cursor: Math.max(0, cursor) };
  }

  const chars = Array.from(input);
  let idx = cursor;

  while (idx > 0 && isWhitespace(chars[idx - 1])) {
    idx -= 1;
  }

  while (idx > 0 && !isWhitespace(chars[idx - 1])) {
    idx -= 1;
  }

  const next = [...chars.slice(0, idx), ...chars.slice(cursor)].join("");
  return { input: next, cursor: idx };
}

export function deleteToLineStart(input: string, cursor: number): { input: string; cursor: number } {
  if (!input || cursor <= 0) {
    return { input, cursor: Math.max(0, cursor) };
  }
  const chars = Array.from(input);
  const clamped = Math.min(Math.max(cursor, 0), chars.length);
  return {
    input: chars.slice(clamped).join(""),
    cursor: 0
  };
}

export function moveCursorWordLeft(input: string, cursor: number): number {
  const chars = Array.from(input);
  let idx = Math.min(Math.max(cursor, 0), chars.length);
  while (idx > 0 && isWhitespace(chars[idx - 1])) {
    idx -= 1;
  }
  while (idx > 0 && !isWhitespace(chars[idx - 1])) {
    idx -= 1;
  }
  return idx;
}

export function moveCursorWordRight(input: string, cursor: number): number {
  const chars = Array.from(input);
  let idx = Math.min(Math.max(cursor, 0), chars.length);
  while (idx < chars.length && isWhitespace(chars[idx])) {
    idx += 1;
  }
  while (idx < chars.length && !isWhitespace(chars[idx])) {
    idx += 1;
  }
  return idx;
}

export function moveCursorLineStart(): number {
  return 0;
}

export function moveCursorLineEnd(input: string): number {
  return Array.from(input).length;
}

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}
