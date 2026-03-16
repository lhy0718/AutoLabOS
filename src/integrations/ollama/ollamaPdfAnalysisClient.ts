import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OllamaClient, type OllamaMessage } from "./ollamaClient.js";
import {
  DEFAULT_OLLAMA_VISION_MODEL
} from "./modelCatalog.js";

export interface OllamaPdfAnalysisResult {
  text: string;
  model?: string;
  pagesAnalyzed: number;
}

const MAX_PAGES_PER_BATCH = 4;
const MAX_TOTAL_PAGES = 12;

export class OllamaPdfAnalysisClient {
  constructor(
    private readonly ollama: OllamaClient,
    private readonly defaultModel: string = DEFAULT_OLLAMA_VISION_MODEL
  ) {}

  async analyzePdfPages(opts: {
    imagePaths: string[];
    prompt: string;
    systemPrompt?: string;
    model?: string;
    abortSignal?: AbortSignal;
  }): Promise<OllamaPdfAnalysisResult> {
    const model = opts.model || this.defaultModel;
    const imagePaths = opts.imagePaths.slice(0, MAX_TOTAL_PAGES);
    const parts: string[] = [];
    let pagesAnalyzed = 0;

    for (let i = 0; i < imagePaths.length; i += MAX_PAGES_PER_BATCH) {
      const batch = imagePaths.slice(i, i + MAX_PAGES_PER_BATCH);
      const images: string[] = [];

      for (const imgPath of batch) {
        try {
          const buf = await fs.readFile(imgPath);
          images.push(buf.toString("base64"));
        } catch {
          // skip unreadable images
          continue;
        }
      }

      if (images.length === 0) continue;

      const pageRange = `pages ${i + 1}–${i + batch.length}`;
      const batchPrompt = imagePaths.length > MAX_PAGES_PER_BATCH
        ? `${opts.prompt}\n\n[Analyzing ${pageRange} of ${imagePaths.length} total pages]`
        : opts.prompt;

      const messages: OllamaMessage[] = [];
      if (opts.systemPrompt) {
        messages.push({ role: "system", content: opts.systemPrompt });
      }
      messages.push({
        role: "user",
        content: batchPrompt,
        images
      });

      const result = await this.ollama.chat({
        model,
        messages,
        abortSignal: opts.abortSignal,
        timeoutMs: 600_000 // 10 min per batch for vision
      });

      if (result.text.trim()) {
        parts.push(result.text.trim());
      }
      pagesAnalyzed += images.length;
    }

    return {
      text: parts.join("\n\n---\n\n"),
      model,
      pagesAnalyzed
    };
  }

  async analyzePageImage(opts: {
    imagePath: string;
    prompt: string;
    systemPrompt?: string;
    model?: string;
    abortSignal?: AbortSignal;
  }): Promise<OllamaPdfAnalysisResult> {
    return this.analyzePdfPages({
      imagePaths: [opts.imagePath],
      prompt: opts.prompt,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      abortSignal: opts.abortSignal
    });
  }
}
