import type { CommandPolicyDecision } from "./commandPolicy.js";

export type AciActionType =
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "run_command"
  | "run_tests"
  | "tail_logs"
  | "search_code"
  | "find_symbol"
  | "list_files";

export interface AciAction {
  type: AciActionType;
  input: Record<string, unknown>;
}

export interface AciObservation {
  status: "ok" | "error";
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  artifacts?: string[];
  policy?: CommandPolicyDecision;
  duration_ms: number;
}

export interface AgentComputerInterface {
  perform(action: AciAction): Promise<AciObservation>;

  readFile(filePath: string): Promise<AciObservation>;
  writeFile(filePath: string, content: string): Promise<AciObservation>;
  applyPatch(diff: string, cwd?: string): Promise<AciObservation>;
  runCommand(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation>;
  runTests(command: string, cwd?: string, signal?: AbortSignal): Promise<AciObservation>;
  tailLogs(filePath: string, lines?: number): Promise<AciObservation>;
  searchCode(
    query: string,
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
  findSymbol(
    symbol: string,
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
  listFiles(
    cwd?: string,
    limit?: number,
    globs?: string[]
  ): Promise<AciObservation>;
}
