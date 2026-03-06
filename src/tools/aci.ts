export type AciActionType =
  | "read_file"
  | "write_file"
  | "apply_patch"
  | "run_command"
  | "run_tests"
  | "tail_logs";

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
}
