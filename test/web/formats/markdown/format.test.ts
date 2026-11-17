// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { singleLineBreaks } from "../../../../web/services/settings.ts";
import { testFormats } from "../../support/formats.ts";

describe("Single line breaks", () => {
  afterEach(() => singleLineBreaks.set(true));

  // A note's preview sits outside any pane, so a class on the pane would
  // leave it joining the lines reading view keeps.
  it("keeps its class on :root, where a note's preview finds it as reading view does", () => {
    testFormats();
    const root = document.documentElement.classList;
    expect(root.contains("single-line-breaks")).toBe(true);

    singleLineBreaks.set(false);
    expect(root.contains("single-line-breaks")).toBe(false);
  });
});
