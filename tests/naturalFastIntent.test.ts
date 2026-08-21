import { describe, expect, it } from "vitest";

import {
  extractTitleChangeIntent,
  isMissingPdfCountIntent,
  isPaperCountIntent,
  isTopCitationIntent
} from "../src/tui/TerminalApp.js";

describe("natural fast intent detection", () => {
  it("detects missing pdf count intent", () => {
    expect(isMissingPdfCountIntent("논문들 중 pdf 경로가 없는 논문들이 몇개야?")).toBe(true);
    expect(isMissingPdfCountIntent("논문들 중 pdf 없는 논문은 몇건이지?")).toBe(true);
    expect(isMissingPdfCountIntent("How many papers are missing PDF paths?")).toBe(true);
  });

  it("does not misclassify attribute-specific query as plain paper count", () => {
    expect(isPaperCountIntent("논문들 중 pdf 경로가 없는 논문들이 몇개야?")).toBe(false);
    expect(isPaperCountIntent("논문 몇 개 모았어?")).toBe(true);
    expect(isPaperCountIntent("수집된 논문은 몇건이지?")).toBe(true);
  });

  it("detects top citation intent", () => {
    expect(isTopCitationIntent("논문들 중 citation이 가장 높은 논문이 뭐야?")).toBe(true);
    expect(isTopCitationIntent("What is the highest-citation paper?")).toBe(true);
  });

  it("extracts title change intent", () => {
    expect(extractTitleChangeIntent("멀티에이전트 협업으로 title을 바꿔줘")).toEqual({
      title: "멀티에이전트 협업"
    });
    expect(extractTitleChangeIntent("change the run title to Multi-agent collaboration")).toEqual({
      title: "Multi-agent collaboration"
    });
  });

});
