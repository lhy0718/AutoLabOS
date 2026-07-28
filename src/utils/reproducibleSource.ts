const TRANSIENT_SOURCE_SUFFIXES = [
  ".orig",
  ".bak",
  ".backup",
  ".pyc",
  ".pyo",
  ".rej",
  ".swp",
  ".swo"
] as const;

const TRANSIENT_SOURCE_FILENAMES = new Set([
  ".ds_store",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
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
