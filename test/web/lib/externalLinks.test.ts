// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { markExternalLink, openExternalLink } from "../../../web/lib/externalLinks.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a link out of Pragma", () => {
  it("opens in a new tab with no opener and no referrer, as a link or from script", () => {
    const link = markExternalLink(document.createElement("a"));
    expect([link.target, link.rel]).toEqual(["_blank", "noopener noreferrer"]);

    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternalLink("https://example.com/docs");
    expect(open).toHaveBeenCalledWith("https://example.com/docs", "_blank", "noopener,noreferrer");
  });
});
