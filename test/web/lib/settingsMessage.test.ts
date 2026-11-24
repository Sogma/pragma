// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createSettingsMessage } from "../../../web/lib/settingsMessage.ts";

// Node's URL: under jsdom the global one is jsdom's, which Node's fs refuses.
const html = readFileSync(new NodeURL("../../../web/index.html", import.meta.url), "utf8");

// A form's line on its subpage, as web/index.html has it.
function setup() {
  document.body.innerHTML = `
    <section class="settings-subpage">
      <form><p class="settings-form-message" hidden></p><input /></form>
    </section>`;
  const page = document.querySelector<HTMLElement>(".settings-subpage") as HTMLElement;
  const line = page.querySelector<HTMLElement>(".settings-form-message") as HTMLElement;
  return { page, line, message: createSettingsMessage(line) };
}

describe("createSettingsMessage", () => {
  it("says a message at its level, dropping the last one's", () => {
    const { line, message } = setup();
    message.show("Key works.", "success");
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe("Key works.");
    expect([...line.classList]).toEqual(["settings-form-message", "inline-success"]);

    message.show("Saved, but the key couldn't be checked.", "warning");
    expect([...line.classList]).toEqual(["settings-form-message", "inline-warning"]);

    message.show("The key was refused.");
    expect([...line.classList]).toEqual(["settings-form-message", "inline-error"]);
  });

  // The line is the first thing on its page, and an outcome can land while
  // the person is further down.
  it("scrolls its page to the top, where the line is", () => {
    const { page, message } = setup();
    page.scrollTop = 240;
    message.show("Couldn't save the model selection");
    expect(page.scrollTop).toBe(0);
  });

  it("hides the line on clear", () => {
    const { line, message } = setup();
    message.show("The key was refused.");
    message.clear();
    expect(line.hidden).toBe(true);
  });
});

describe("Settings' forms", () => {
  it("each open with their message line, above any intro or field", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const forms = [...doc.querySelectorAll<HTMLFormElement>(".settings-subpage form")];
    expect(forms.map((form) => form.id)).toEqual([
      "mcp-server-form",
      "sharing-form",
      "publishers-form",
      "providers-form",
      "api-token-form",
    ]);
    for (const form of forms) {
      expect(form.firstElementChild?.classList.contains("settings-form-message"), form.id).toBe(true);
    }
    expect(doc.querySelectorAll(".settings-form-message")).toHaveLength(forms.length);
  });
});
