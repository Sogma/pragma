// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { spellcheckFields } from "../../../web/lib/spellcheck.ts";

describe("spellcheckFields", () => {
  afterEach(() => document.documentElement.removeAttribute("spellcheck"));

  // "true" on the root would turn on every field without a value of its own,
  // search boxes and ids included, so on leaves the root unset.
  it("turns every field off from the root, and on by leaving each to its own default", () => {
    spellcheckFields(false);
    expect(document.documentElement.getAttribute("spellcheck")).toBe("false");

    spellcheckFields(true);
    expect(document.documentElement.hasAttribute("spellcheck")).toBe(false);
  });
});
