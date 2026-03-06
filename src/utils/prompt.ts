import { stdin as input, stdout as output } from "node:process";
import readline from "node:readline/promises";

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
