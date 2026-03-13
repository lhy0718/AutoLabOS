export interface SlashCommandDef {
  name: string;
  usage: string;
  description: string;
  visible?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "help", usage: "/help", description: "Show the minimal workflow", visible: true },
  { name: "new", usage: "/new", description: "Create a Markdown Research Brief", visible: true },
  { name: "brief", usage: "/brief start <path|--latest>", description: "Start research from a brief file", visible: true },
  { name: "doctor", usage: "/doctor", description: "Run environment checks" },
  { name: "runs", usage: "/runs", description: "List and search runs" },
  { name: "run", usage: "/run <run>", description: "Select a run" },
  { name: "resume", usage: "/resume <run>", description: "Resume a run" },
  { name: "title", usage: "/title <new title>", description: "Rename the active run" },
  { name: "agent", usage: "/agent <subcommand>", description: "Run and inspect state graph nodes" },
  { name: "model", usage: "/model", description: "Open model and reasoning selector" },
  { name: "approve", usage: "/approve", description: "Approve the current step", visible: true },
  { name: "retry", usage: "/retry", description: "Retry current node" },
  { name: "settings", usage: "/settings", description: "Edit configuration" },
  { name: "quit", usage: "/quit", description: "Exit AutoLabOS" }
];
