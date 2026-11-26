// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { createFrostHeader } from "../../../web/lib/frostHeader.ts";

afterEach(() => {
  document.body.replaceChildren();
});

describe("createFrostHeader", () => {
  it("lays the header just before its scroller, in the parent holding both", () => {
    const frame = document.createElement("div");
    const before = document.createElement("div");
    const scroller = document.createElement("div");
    frame.append(before, scroller);

    const header = createFrostHeader(scroller, "chat-header");

    expect([...frame.children]).toEqual([before, header, scroller]);
    expect(header.className).toBe("frost-header chat-header");
    expect(scroller.classList.contains("frost-header-scroller")).toBe(true);
  });

  it("refuses a scroller with no parent to lay the header in", () => {
    expect(() => createFrostHeader(document.createElement("div"), "chat-header")).toThrow(/chat-header/);
  });
});
