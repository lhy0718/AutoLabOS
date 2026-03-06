export interface ParsedSlashCommand {
  command: string;
  args: string[];
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const normalized = normalizeSlashPrefix(input);
  const trimmed = normalized.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const body = trimmed.slice(1).trim();
  if (!body) {
    return { command: "help", args: [] };
  }

  const parts = tokenizeShellLike(body);
  if (parts.length === 0) {
    return null;
  }

  return {
    command: parts[0].toLowerCase(),
    args: parts.slice(1)
  };
}

function normalizeSlashPrefix(input: string): string {
  const trimmedStart = input.trimStart();
  if (trimmedStart.startsWith("／")) {
    return `/${trimmedStart.slice(1)}`;
  }
  return input;
}

export function tokenizeShellLike(text: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: "'" | '"' | null = null;
  let escape = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (escape) {
      buf += char;
      escape = false;
      continue;
    }

    if (char === "\\") {
      const next = text[i + 1];
      if (next && (next === "\\" || next === "'" || next === '"' || /\s/u.test(next))) {
        escape = true;
        continue;
      }
      buf += char;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        buf += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (buf) {
        tokens.push(buf);
        buf = "";
      }
      continue;
    }

    buf += char;
  }

  if (escape) {
    buf += "\\";
  }
  if (buf) {
    tokens.push(buf);
  }
  return tokens;
}
