import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const FALLBACK_VERSION = "0.0.0";

let cachedVersion: string | undefined;

export interface AppVersionOptions {
  packageJsonPath?: string;
  useCache?: boolean;
  fallback?: string;
}

export function getAppVersion(options: AppVersionOptions = {}): string {
  const useCache = options.useCache ?? true;
  if (useCache && cachedVersion) {
    return cachedVersion;
  }

  const fallback = options.fallback ?? FALLBACK_VERSION;
  const packageJsonPath = options.packageJsonPath || resolveDefaultPackageJsonPath();

  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : fallback;

    if (useCache) {
      cachedVersion = version;
    }
    return version;
  } catch {
    if (useCache) {
      cachedVersion = fallback;
    }
    return fallback;
  }
}

export function clearVersionCache(): void {
  cachedVersion = undefined;
}

function resolveDefaultPackageJsonPath(): string {
  const filePath = fileURLToPath(import.meta.url);
  const tuiDir = path.dirname(filePath);
  return path.resolve(tuiDir, "../../package.json");
}
