const TRANSIENT_SOURCE_SUFFIXES = [
  ".orig",
  ".bak",
  ".backup",
  ".rej",
  ".swp",
  ".swo"
] as const;

const TRANSIENT_SOURCE_FILENAMES = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini"
]);

export function isReproducibleSourceEntry(name: string): boolean {
  const normalized = name.toLowerCase();
  return !TRANSIENT_SOURCE_FILENAMES.has(normalized)
    && !name.startsWith(".#")
    && !name.endsWith("~")
    && !TRANSIENT_SOURCE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}
