import { describe, expect, it } from "vitest";
import { sceneNumber } from "../../src/protocol/fountainSceneNumber.ts";

describe("a scene heading's number", () => {
  it("reads every number Fountain's examples write", () => {
    for (const number of ["1", "1A", "1a", "A1", "I-1-A", "1.", "110A", "110A."]) {
      const text = `INT. HOUSE - DAY #${number}#`;
      expect(sceneNumber(text)).toEqual({ from: 17, to: text.length, number });
    }
  });

  it("reads one that ends the line but for blanks and notes", () => {
    expect(sceneNumber("INT. HOUSE - DAY #4#  ")).toEqual({ from: 17, to: 20, number: "4" });
    expect(sceneNumber("INT. HOUSE - DAY #4# [[>sid_k3x9]] [[recheck]]")).toEqual({ from: 17, to: 20, number: "4" });
    expect(sceneNumber("INT. HOUSE - DAY [[recheck]] #4#")).toEqual({ from: 29, to: 32, number: "4" });
    expect(sceneNumber("INT. HOUSE - DAY#4#")).toEqual({ from: 16, to: 19, number: "4" });
  });

  it("reads none elsewhere on the line, none holding other characters, and none inside a note", () => {
    expect(sceneNumber("INT. HOUSE #4# - DAY")).toBeUndefined();
    expect(sceneNumber("INT. HOUSE - DAY #4 A#")).toBeUndefined();
    expect(sceneNumber("INT. HOUSE - DAY #4*#")).toBeUndefined();
    expect(sceneNumber("INT. HOUSE - DAY ##")).toBeUndefined();
    expect(sceneNumber("INT. HOUSE - DAY [[#4#]]")).toBeUndefined();
  });
});
