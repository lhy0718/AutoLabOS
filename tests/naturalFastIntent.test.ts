import { describe, expect, it } from "vitest";

import {
  isMissingPdfCountIntent,
  isPaperCountIntent,
  isTopCitationIntent
} from "../src/tui/TerminalApp.js";

describe("natural fast intent detection", () => {
  it("detects missing pdf count intent", () => {
    expect(isMissingPdfCountIntent("논문들 중 pdf 경로가 없는 논문들이 몇개야?")).toBe(true);
    expect(isMissingPdfCountIntent("How many papers are missing PDF paths?")).toBe(true);
  });

  it("does not misclassify attribute-specific query as plain paper count", () => {
    expect(isPaperCountIntent("논문들 중 pdf 경로가 없는 논문들이 몇개야?")).toBe(false);
    expect(isPaperCountIntent("논문 몇 개 모았어?")).toBe(true);
  });

  it("detects top citation intent", () => {
    expect(isTopCitationIntent("논문들 중 citation이 가장 높은 논문이 뭐야?")).toBe(true);
    expect(isTopCitationIntent("What is the highest-citation paper?")).toBe(true);
  });
});
