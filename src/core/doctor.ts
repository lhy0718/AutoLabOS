import { spawn } from "node:child_process";

import { DoctorCheck } from "../types.js";
import { CodexCliClient } from "../integrations/codex/codexCliClient.js";

export async function runDoctor(
  codex: CodexCliClient,
  opts?: {
    llmMode?: "codex_chatgpt_only" | "openai_api";
    pdfAnalysisMode?: "codex_text_image_hybrid" | "responses_api_pdf";
    openAiApiKeyConfigured?: boolean;
  }
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const cli = await codex.checkCliAvailable();
  checks.push({ name: "codex-cli", ok: cli.ok, detail: cli.detail });

  const login = await codex.checkLoginStatus();
  checks.push({ name: "codex-login", ok: login.ok, detail: login.detail });

  checks.push(await runBinaryCheck("python3", ["--version"], "python"));
  checks.push(await runBinaryCheck("pip3", ["--version"], "pip"));
  checks.push(await runBinaryCheck("pdflatex", ["--version"], "latex"));
  if (opts?.pdfAnalysisMode === "codex_text_image_hybrid") {
    checks.push(await runBinaryCheck("pdftotext", ["-v"], "pdftotext"));
    checks.push(await runBinaryCheck("pdfinfo", ["-v"], "pdfinfo"));
    checks.push(await runBinaryCheck("pdftoppm", ["-v"], "pdftoppm"));
  }
  if (opts?.llmMode === "openai_api" || opts?.pdfAnalysisMode === "responses_api_pdf") {
    checks.push({
      name: "openai-api-key",
      ok: opts.openAiApiKeyConfigured === true,
      detail:
        opts.openAiApiKeyConfigured === true
          ? "OPENAI_API_KEY detected"
          : opts?.llmMode === "openai_api"
            ? "OPENAI_API_KEY missing (required for OpenAI API provider mode)"
            : "OPENAI_API_KEY missing (required for Responses API PDF analysis)"
    });
  }

  return checks;
}

async function runBinaryCheck(bin: string, args: string[], name: string): Promise<DoctorCheck> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: process.env });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.once("error", (err) => {
      resolve({
        name,
        ok: false,
        detail: err.message
      });
    });

    child.once("close", (code) => {
      const out = (stdout || stderr).trim();
      resolve({
        name,
        ok: code === 0,
        detail: out || `${bin} exited with ${code ?? 1}`
      });
    });
  });
}
