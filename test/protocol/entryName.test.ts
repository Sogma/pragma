import { describe, expect, it } from "vitest";
import {
  entryNameForTitle,
  entryNameKey,
  illegalEntryNameReason,
  isNamed,
  sanitizeEntryName,
  spellingIn,
} from "../../src/protocol/entryName.ts";

describe("judging a name someone typed", () => {
  it("accepts an ordinary name", () => {
    for (const name of ["aria.md", "Act 2 — rewrite.fountain", "characters", "notes.2024.md"]) {
      expect(illegalEntryNameReason(name)).toBeNull();
    }
  });

  it("refuses each character Windows refuses, and a control character", () => {
    for (const name of ["a<b", "a>b", "a:b", 'a"b', "a|b", "a?b", "a*b", "a\u0007b"]) {
      expect(illegalEntryNameReason(name)).toMatch(/can't contain/);
    }
  });

  // `..drafts` is not an escape — the containment check resolves it happily —
  // but the tree hides any leading-dot name, so it is still not a name to
  // mint. The two rules answer different questions about the same string.
  it("refuses a leading dot, which the tree would hide", () => {
    expect(illegalEntryNameReason(".hidden.md")).toMatch(/start with a dot/);
    expect(illegalEntryNameReason("..drafts")).toMatch(/start with a dot/);
  });

  // The rule is stateless, which is worth asserting rather than assuming: a
  // `/g` regex would answer true, false, true here as `lastIndex` walked the
  // string, and the bug only shows up on the second name a session judges.
  it("gives the same answer every time it is asked", () => {
    for (let i = 0; i < 3; i += 1) expect(illegalEntryNameReason("a<b")).toMatch(/can't contain/);
    for (let i = 0; i < 3; i += 1) expect(illegalEntryNameReason("fine.md")).toBeNull();
  });
});

describe("repairing a name nobody can be asked about", () => {
  it("replaces what it can and strips what it can't keep", () => {
    expect(sanitizeEntryName('a<b>c:d"e|f?g*h.png')).toBe("a-b-c-d-e-f-g-h.png");
    expect(sanitizeEntryName("..hidden.png")).toBe("hidden.png");
    expect(sanitizeEntryName("  spaced.png  ")).toBe("spaced.png");
  });

  it("repairs every occurrence, not just the first", () => {
    expect(sanitizeEntryName("a:b:c:d.png")).toBe("a-b-c-d.png");
  });

  it("can leave nothing behind, which is the caller's to refuse", () => {
    expect(sanitizeEntryName("...")).toBe("");
  });
});

describe("naming a document after the title someone typed", () => {
  it("turns a colon into a dash that reads like the title", () => {
    expect(entryNameForTitle("Part 1: The Beginning")).toBe("Part 1 - The Beginning");
    expect(entryNameForTitle("Part 1 : The Beginning")).toBe("Part 1 - The Beginning");
    expect(entryNameForTitle("Doors open 12:30")).toBe("Doors open 12-30");
  });

  it("drops the rest of what a name can't hold", () => {
    expect(entryNameForTitle('Why "pragma"?')).toBe("Why pragma");
    expect(entryNameForTitle("Plans | Pricing")).toBe("Plans Pricing");
    expect(entryNameForTitle("a <b> *c*")).toBe("a b c");
  });

  it("returns a name the name rule accepts", () => {
    for (const title of ["Part 1: The Beginning", "What now?", ".NET: notes", "Wait: what...", "Note to self:"]) {
      const name = entryNameForTitle(title);
      expect(name).not.toBe("");
      expect(illegalEntryNameReason(name)).toBeNull();
    }
  });

  it("trims the ends a name can't keep or that only a colon left", () => {
    expect(entryNameForTitle(".NET: notes")).toBe("NET - notes");
    expect(entryNameForTitle("Wait: what...")).toBe("Wait - what");
    expect(entryNameForTitle("Note to self:")).toBe("Note to self");
  });

  it("can leave nothing behind, which is the caller's to refuse", () => {
    expect(entryNameForTitle("???")).toBe("");
  });
});

describe("comparing two names", () => {
  it("treats names that differ only by case or Unicode normalization as one", () => {
    expect(entryNameKey("Caf\u00e9.md")).toBe(entryNameKey("cafe\u0301.md"));
  });

  // Only canonical equivalence folds: macOS keeps a ligature apart from the
  // letters it looks like, so folding compatibility forms too would refuse
  // a name every host can store.
  it("keeps names that only look alike apart", () => {
    expect(entryNameKey("\ufb01le.md")).not.toBe(entryNameKey("file.md"));
  });
});

describe("finding a name the protocol defines", () => {
  it("matches it in any case, on every platform", () => {
    expect(isNamed("readme.md", "README.md")).toBe(true);
    expect(isNamed("_Templates", "_templates")).toBe(true);
    expect(isNamed("README.markdown", "README.md")).toBe(false);
  });

  it("takes the exact spelling first, else the one name folding to it", () => {
    expect(spellingIn(["notes", "Readme.md"], "README.md")).toBe("Readme.md");
    expect(spellingIn(["readme.md", "README.md"], "README.md")).toBe("README.md");
    expect(spellingIn(["notes"], "README.md")).toBeUndefined();
  });

  // Another tool can make `Readme.md` beside `readme.md`, and a guess would
  // pick one of them by chance, as two paths that fold alike name neither.
  it("names none when two fold to it and neither is spelled exactly", () => {
    expect(spellingIn(["readme.md", "Readme.md"], "README.md")).toBeUndefined();
  });
});
