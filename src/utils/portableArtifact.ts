const UNIX_MACHINE_PATH_PATTERN = /(?<![A-Za-z0-9])(?:\/home\/[^/\s"'`]+|\/Users\/[^/\s"'`]+|\/private\/tmp|\/tmp|\/mnt)(?:\/[^\s"'`<>{}\[\](),;]+)*/gu;
const WINDOWS_MACHINE_PATH_PATTERN = /(?<![A-Za-z0-9])[A-Za-z]:\\Users\\[^\\\s"'`]+(?:\\[^\s"'`<>{}\[\](),;]+)*/gu;

export function projectPortableArtifactValue<T>(value: T): T {
  return projectPortableValue(value) as T;
}

export function sanitizeMachinePathsInText(value: string): string {
  return value
    .replace(UNIX_MACHINE_PATH_PATTERN, (match) => portableMachinePath(match))
    .replace(WINDOWS_MACHINE_PATH_PATTERN, (match) => portableMachinePath(match));
}

function projectPortableValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeMachinePathsInText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => projectPortableValue(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, projectPortableValue(entry)])
  );
}

function portableMachinePath(raw: string): string {
  const punctuation = raw.match(/[.!?:]+$/u)?.[0] || "";
  const normalized = raw.slice(0, raw.length - punctuation.length).replace(/\\/gu, "/");
  const outputsIndex = normalized.lastIndexOf("/outputs/");
  if (outputsIndex >= 0) {
    return `${normalized.slice(outputsIndex + 1)}${punctuation}`;
  }

  const runMarker = "/.autolabos/runs/";
  const runIndex = normalized.lastIndexOf(runMarker);
  if (runIndex >= 0) {
    const afterMarker = normalized.slice(runIndex + runMarker.length);
    const slashIndex = afterMarker.indexOf("/");
    const suffix = slashIndex >= 0 ? afterMarker.slice(slashIndex) : "";
    return `.autolabos/runs/<run-id>${suffix}${punctuation}`;
  }

  const autolabosIndex = normalized.lastIndexOf("/.autolabos/");
  if (autolabosIndex >= 0) {
    return `<workspace-root>${normalized.slice(autolabosIndex)}${punctuation}`;
  }

  const segments = normalized.split("/").filter(Boolean);
  const basename = segments.at(-1);
  return `${basename ? `<machine-path>/${basename}` : "<machine-path>"}${punctuation}`;
}
