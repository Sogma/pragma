// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { iconButton } from "../../../web/lib/dom.ts";

describe("an icon button", () => {
  it("is a button named by its label, which its tooltip shows", () => {
    const button = iconButton("rail-icon", "Search");
    expect(button.type).toBe("button");
    expect(button.className).toBe("icon-button rail-icon");
    expect(button.getAttribute("aria-label")).toBe("Search");
    expect(button.dataset.tooltip).toBeUndefined();
    expect(iconButton("", "More options").className).toBe("icon-button");
  });

  it("keeps a tooltip only where it differs from the label", () => {
    expect(iconButton("zoom-reset", "Reset zoom to 100%", "Reset to 100%").dataset.tooltip).toBe("Reset to 100%");
    expect(iconButton("fit", "Fit view", "Fit view").dataset.tooltip).toBeUndefined();
  });
});
