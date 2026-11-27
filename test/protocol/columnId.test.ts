import { describe, expect, it } from "vitest";
import { columnIdFor, columnIdOf } from "../../src/protocol/columnId.ts";

describe("a column id from typed text", () => {
  it("is lowercase letters and digits, each other run one underscore, none at either end", () => {
    expect(columnIdOf("Shot size")).toBe("shot_size");
    expect(columnIdOf("Size (mm)")).toBe("size_mm");
    expect(columnIdOf("  --Take #2--  ")).toBe("take_2");
    expect(columnIdOf("shot-size")).toBe("shot_size");
    expect(columnIdOf("already_an_id")).toBe("already_an_id");
  });

  it("folds an accent to the letter under it, and spells out the letters a fold leaves", () => {
    expect(columnIdOf("Título")).toBe("titulo");
    expect(columnIdOf("Crème brûlée")).toBe("creme_brulee");
    expect(columnIdOf("Straße")).toBe("strasse");
    expect(columnIdOf("Ærø Łódź")).toBe("aero_lodz");
    expect(columnIdOf("ﬁnal")).toBe("final");
  });

  it("is empty when nothing is left to keep", () => {
    expect(columnIdOf("名前")).toBe("");
    expect(columnIdOf("!!!")).toBe("");
    expect(columnIdOf("")).toBe("");
  });
});

describe("a new column's id", () => {
  it("is its name's, made unique past the ids taken", () => {
    expect(columnIdFor("Prompt", new Set())).toBe("prompt");
    expect(columnIdFor("Prompt", new Set(["prompt"]))).toBe("prompt_2");
    expect(columnIdFor("Prompt", new Set(["prompt", "prompt_2"]))).toBe("prompt_3");
  });

  // A name with nothing to keep is numbered from 1, so no id reads as the
  // name of a column called "Column".
  it("is numbered from column_1 for a name with nothing to keep", () => {
    expect(columnIdFor("名前", new Set())).toBe("column_1");
    expect(columnIdFor("名前", new Set(["column_1"]))).toBe("column_2");
    expect(columnIdFor("Column", new Set())).toBe("column");
  });
});
