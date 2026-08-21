import { describe, expect, it } from "vitest";

import {
  deleteBackward,
  deleteToLineStart,
  deletePreviousWord,
  insertAtCursor,
  moveCursorLineEnd,
  moveCursorLineStart,
  moveCursorWordLeft,
  moveCursorWordRight
} from "../src/tui/inputEditing.js";

describe("deletePreviousWord", () => {
  it("deletes the previous word", () => {
    expect(deletePreviousWord("hello world", 11)).toEqual({
      input: "hello ",
      cursor: 6
    });
  });

  it("deletes trailing spaces and previous word", () => {
    expect(deletePreviousWord("hello world   ", 14)).toEqual({
      input: "hello ",
      cursor: 6
    });
  });

  it("handles single word input", () => {
    expect(deletePreviousWord("hello", 5)).toEqual({
      input: "",
      cursor: 0
    });
  });

  it("supports Korean words", () => {
    expect(deletePreviousWord("논문 제목 알려줘", 9)).toEqual({
      input: "논문 제목 ",
      cursor: 6
    });
  });
});

describe("cursor editing helpers", () => {
  it("inserts text at cursor", () => {
    expect(insertAtCursor("hello world", 6, "big ")).toEqual({
      input: "hello big world",
      cursor: 10
    });
  });

  it("deletes one character backward at cursor", () => {
    expect(deleteBackward("hello", 5)).toEqual({
      input: "hell",
      cursor: 4
    });
  });

  it("moves cursor by word left/right", () => {
    expect(moveCursorWordLeft("hello big world", 15)).toBe(10);
    expect(moveCursorWordRight("hello big world", 6)).toBe(9);
  });

  it("moves cursor to line boundaries", () => {
    expect(moveCursorLineStart()).toBe(0);
    expect(moveCursorLineEnd("hello big world")).toBe(15);
  });

  it("deletes from cursor to line start", () => {
    expect(deleteToLineStart("hello big world", 10)).toEqual({
      input: "world",
      cursor: 0
    });
    expect(deleteToLineStart("hello", 0)).toEqual({
      input: "hello",
      cursor: 0
    });
  });
});
