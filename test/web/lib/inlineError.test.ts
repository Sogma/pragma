// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createInlineError } from "../../../web/lib/inlineError.ts";

const parts = (card: HTMLElement) => [...card.children].map((child) => child.className);

describe("createInlineError", () => {
  it("draws a message alone, announced as an alert", () => {
    const card = createInlineError({ message: "Enter a name." });
    expect(card.className).toBe("inline-error");
    expect(card.getAttribute("role")).toBe("alert");
    expect(parts(card)).toEqual(["inline-error-message"]);
    expect(card.textContent).toBe("Enter a name.");
  });

  it("puts a title over the message, and the setting that fixes it under it as a button", () => {
    const need = { kind: "defaultModel", output: "text" } as const;
    const card = createInlineError({ title: "Tighten failed", message: "No model selected.", need });
    expect(parts(card)).toEqual(["inline-error-title", "inline-error-message", "setting-link btn"]);
    expect(card.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
  });
});
