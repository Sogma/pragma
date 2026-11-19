// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { moreOptionsButton } from "../../../web/lib/moreOptionsButton.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("moreOptionsButton", () => {
  it("is a ⋮ named More options whose click opens its menu under it", () => {
    const open = vi.fn();
    const { element } = moreOptionsButton("media-hud-more", open);
    expect(element.className).toBe("icon-button media-hud-more");
    expect(["aria-label", "aria-haspopup", "aria-expanded"].map((name) => element.getAttribute(name))).toEqual([
      "More options",
      "true",
      "false",
    ]);

    element.click();
    expect(open).toHaveBeenCalledWith(element);
  });

  it("leaves focus where it was on a press", () => {
    const { element } = moreOptionsButton("media-hud-more", vi.fn());
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    element.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
  });

  // A pick from the menu hands focus back to its button; it goes on to the
  // surface that held it, whose keys the button sits over.
  it("passes on the focus a pick hands back, and none after a close with no pick", async () => {
    const { element } = moreOptionsButton("media-hud-more", vi.fn());
    const surface = document.createElement("div");
    surface.tabIndex = 0;
    document.body.append(surface, element);
    surface.focus();

    element.click();
    // As the menu does when a row is picked.
    element.focus();
    expect(document.activeElement).toBe(surface);

    element.click();
    element.setAttribute("aria-expanded", "true");
    element.setAttribute("aria-expanded", "false");
    await new Promise((resolve) => setTimeout(resolve, 0));
    element.focus();
    expect(document.activeElement).toBe(element);
  });
});
