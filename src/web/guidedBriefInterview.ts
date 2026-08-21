import { randomUUID } from "node:crypto";

import {
  buildAdaptiveGuidedBriefAnswers,
  createAdaptiveGuidedBriefState,
  getNextAdaptiveGuidedBriefPrompt,
  summarizeAdaptiveGuidedBriefCoverage,
  type AdaptiveGuidedBriefFallbackReason,
  type AdaptiveGuidedBriefResolution,
  type AdaptiveGuidedBriefState,
  type GuidedBriefField
} from "../core/runs/adaptiveGuidedBriefInterview.js";
import {
  getGuidedBriefInterviewCopy,
  type GuidedBriefInterviewLanguage,
  type GuidedBriefResearchMode
} from "../core/runs/guidedBriefInterview.js";
import { buildGuidedResearchBriefMarkdown } from "../core/runs/researchBriefFiles.js";

const DEFAULT_INTERVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_INTERVIEWS = 32;
const MAX_INTERVIEW_TURNS = 40;

export interface WebGuidedBriefInterviewProjection {
  id: string;
  language: GuidedBriefInterviewLanguage;
  researchMode: GuidedBriefResearchMode;
  introLines: string[];
  status: "active" | "complete";
  prompt: ReturnType<typeof getNextAdaptiveGuidedBriefPrompt>;
  coverage: ReturnType<typeof summarizeAdaptiveGuidedBriefCoverage>;
  answeredFields: GuidedBriefField[];
  turnCount: number;
  lastAcceptedFields: GuidedBriefField[];
  lastResolutionSource?: AdaptiveGuidedBriefResolution["source"];
  lastFallbackReason?: AdaptiveGuidedBriefFallbackReason;
  generatedBrief?: string;
}

export class WebGuidedBriefInterviewNotFoundError extends Error {}
export class WebGuidedBriefInterviewBusyError extends Error {}
export class WebGuidedBriefInterviewLimitError extends Error {}

interface StoredWebGuidedBriefInterview {
  state: AdaptiveGuidedBriefState;
  templateDefault: string;
  updatedAtMs: number;
  lastAcceptedFields: GuidedBriefField[];
  lastResolutionSource?: AdaptiveGuidedBriefResolution["source"];
  lastFallbackReason?: AdaptiveGuidedBriefFallbackReason;
}

export interface WebGuidedBriefInterviewManagerOptions {
  resolveAnswer: (input: {
    state: AdaptiveGuidedBriefState;
    answer: string;
    templateDefault?: string;
    abortSignal?: AbortSignal;
  }) => Promise<AdaptiveGuidedBriefResolution>;
  idFactory?: () => string;
  now?: () => number;
  ttlMs?: number;
  maxInterviews?: number;
}

export class WebGuidedBriefInterviewManager {
  private readonly interviews = new Map<string, StoredWebGuidedBriefInterview>();
  private readonly answering = new Set<string>();
  private readonly resolveAnswer: WebGuidedBriefInterviewManagerOptions["resolveAnswer"];
  private readonly idFactory: () => string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxInterviews: number;

  constructor(options: WebGuidedBriefInterviewManagerOptions) {
    this.resolveAnswer = options.resolveAnswer;
    this.idFactory = options.idFactory || randomUUID;
    this.now = options.now || Date.now;
    this.ttlMs = options.ttlMs || DEFAULT_INTERVIEW_TTL_MS;
    this.maxInterviews = options.maxInterviews || DEFAULT_MAX_INTERVIEWS;
  }

  start(input: {
    language: GuidedBriefInterviewLanguage;
    researchMode: GuidedBriefResearchMode;
    templateDefault?: string;
  }): WebGuidedBriefInterviewProjection {
    this.pruneExpired();
    if (this.interviews.size >= this.maxInterviews) {
      throw new WebGuidedBriefInterviewLimitError(
        "Too many guided brief drafts are active. Cancel an existing draft or wait for an inactive draft to expire."
      );
    }
    const id = this.idFactory();
    const stored: StoredWebGuidedBriefInterview = {
      state: createAdaptiveGuidedBriefState({
        language: input.language,
        researchMode: input.researchMode
      }),
      templateDefault: input.templateDefault?.trim() || "",
      updatedAtMs: this.now(),
      lastAcceptedFields: []
    };
    this.interviews.set(id, stored);
    return this.project(id, stored);
  }

  get(id: string): WebGuidedBriefInterviewProjection {
    this.pruneExpired();
    return this.project(id, this.requireInterview(id));
  }

  async answer(input: {
    id: string;
    answer: string;
    abortSignal?: AbortSignal;
  }): Promise<WebGuidedBriefInterviewProjection> {
    this.pruneExpired();
    const stored = this.requireInterview(input.id);
    if (getNextAdaptiveGuidedBriefPrompt(
      stored.state,
      getGuidedBriefInterviewCopy(stored.state.language, stored.state.researchMode),
      stored.templateDefault
    ).kind === "complete") {
      return this.project(input.id, stored);
    }
    if (this.answering.has(input.id)) {
      throw new WebGuidedBriefInterviewBusyError("This guided brief answer is already being processed.");
    }
    if (stored.state.conversation.length >= MAX_INTERVIEW_TURNS) {
      throw new Error("Adaptive guided brief interview exceeded the 40-turn safety limit.");
    }

    this.answering.add(input.id);
    try {
      const resolution = await this.resolveAnswer({
        state: stored.state,
        answer: input.answer,
        templateDefault: stored.templateDefault,
        abortSignal: input.abortSignal
      });
      if (this.interviews.get(input.id) !== stored) {
        throw new WebGuidedBriefInterviewNotFoundError(
          "This guided brief draft was cancelled while the answer was being processed."
        );
      }
      const nextStored: StoredWebGuidedBriefInterview = {
        ...stored,
        state: resolution.state,
        updatedAtMs: this.now(),
        lastAcceptedFields: [...resolution.acceptedFields],
        lastResolutionSource: resolution.source,
        lastFallbackReason: resolution.fallbackReason
      };
      this.interviews.set(input.id, nextStored);
      return this.project(input.id, nextStored);
    } finally {
      this.answering.delete(input.id);
    }
  }

  cancel(id: string): boolean {
    return this.interviews.delete(id);
  }

  private requireInterview(id: string): StoredWebGuidedBriefInterview {
    const stored = this.interviews.get(id);
    if (!stored) {
      throw new WebGuidedBriefInterviewNotFoundError(
        "This guided brief draft is no longer available. Start a new interview."
      );
    }
    return stored;
  }

  private project(
    id: string,
    stored: StoredWebGuidedBriefInterview
  ): WebGuidedBriefInterviewProjection {
    const copy = getGuidedBriefInterviewCopy(stored.state.language, stored.state.researchMode);
    const prompt = getNextAdaptiveGuidedBriefPrompt(stored.state, copy, stored.templateDefault);
    const complete = prompt.kind === "complete";
    return {
      id,
      language: stored.state.language,
      researchMode: stored.state.researchMode,
      introLines: [...copy.introLines],
      status: complete ? "complete" : "active",
      prompt,
      coverage: summarizeAdaptiveGuidedBriefCoverage(stored.state),
      answeredFields: Object.keys(stored.state.answers) as GuidedBriefField[],
      turnCount: stored.state.conversation.length,
      lastAcceptedFields: [...stored.lastAcceptedFields],
      lastResolutionSource: stored.lastResolutionSource,
      lastFallbackReason: stored.lastFallbackReason,
      generatedBrief: complete
        ? buildGuidedResearchBriefMarkdown(buildAdaptiveGuidedBriefAnswers(stored.state))
        : undefined
    };
  }

  private pruneExpired(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, stored] of this.interviews) {
      if (stored.updatedAtMs < cutoff && !this.answering.has(id)) {
        this.interviews.delete(id);
      }
    }
  }
}
