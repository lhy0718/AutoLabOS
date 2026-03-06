import { CodexCliClient } from "../../integrations/codex/codexCliClient.js";

export class TitleGenerator {
  constructor(private readonly codex: CodexCliClient) {}

  async generateTitle(topic: string, constraints: string[], objectiveMetric: string): Promise<string> {
    const prompt = [
      "Create a concise research run title in English.",
      "Rules:",
      "- 8 to 12 words",
      "- single line",
      "- no quotes",
      "- include the core topic",
      "",
      `Topic: ${topic}`,
      `Constraints: ${constraints.join(", ") || "none"}`,
      `Objective metric: ${objectiveMetric || "none"}`
    ].join("\n");

    try {
      const response = await this.codex.runForText({
        prompt,
        sandboxMode: "read-only",
        approvalPolicy: "never"
      });
      return sanitizeTitle(response, topic);
    } catch {
      return fallbackTitle(topic);
    }
  }
}

function sanitizeTitle(raw: string, topic: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  if (!oneLine) {
    return fallbackTitle(topic);
  }
  return oneLine.slice(0, 96);
}

function fallbackTitle(topic: string): string {
  const trimmed = topic.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "Untitled AutoResearch Run";
  }
  return trimmed.slice(0, 96);
}
