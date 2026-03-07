import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

export type PromptReader = (question: string, defaultValue?: string) => Promise<string>;

export async function askLine(question: string, defaultValue = ""): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    if (!answer && defaultValue) {
      return defaultValue;
    }
    return answer;
  } finally {
    rl.close();
  }
}

export async function askRequiredLine(
  question: string,
  reader: PromptReader = askLine
): Promise<string> {
  while (true) {
    const answer = (await reader(question)).trim();
    if (answer) {
      return answer;
    }
    output.write(`${question} is required.\n`);
  }
}
