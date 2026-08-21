import fs from "node:fs";
import path from "node:path";

const PRIVATE_PATH_PATTERN = /(?:^|[\s"'])(?:\/home\/|\/Users\/|\/mnt\/|\/tmp\/|[A-Za-z]:\\)/u;
const SENSITIVE_ASSIGNMENT_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|private[_-]?key|credential|secret)\s*[=:]\s*["']?[^\s"',}]{8,}/iu;

export function parseOptionalReportArg(args) {
  if (args.some((arg) => arg === "--help" || arg === "-h")) {
    return { help: true, reportPath: undefined };
  }
  if (args.length === 0) return { help: false, reportPath: undefined };
  if (args.length === 2 && args[0] === "--report" && args[1] && !args[1].startsWith("--")) {
    return { help: false, reportPath: args[1] };
  }
  throw new Error("Expected no arguments or --report <path>.");
}

export function writeValidationReport(report, reportPath, cwd = process.cwd()) {
  if (!reportPath) return report;
  const absolutePath = path.isAbsolute(reportPath) ? path.normalize(reportPath) : path.resolve(cwd, reportPath);
  const relative = path.relative(cwd, absolutePath).replace(/\\/gu, "/");
  const reportOutput = relative && !relative.startsWith("../")
    ? relative
    : `<external-report-root>/${path.basename(absolutePath)}`;
  const persisted = { ...report, reportOutput };
  const serialized = `${JSON.stringify(persisted, null, 2)}\n`;

  if (PRIVATE_PATH_PATTERN.test(serialized)) {
    throw new Error("Validation report contains a machine-specific absolute path.");
  }
  if (SENSITIVE_ASSIGNMENT_PATTERN.test(serialized)) {
    throw new Error("Validation report contains credential-like assigned text.");
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${process.pid}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, absolutePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
  }
  return persisted;
}
