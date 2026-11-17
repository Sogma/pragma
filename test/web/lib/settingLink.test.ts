// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { goToSettingsLabel, provideSettingLinks, settingLinks, setupPage } from "../../../web/lib/settingLink.ts";

describe("settingLinks", () => {
  it("is none when no setting fixes the error", () => {
    expect(settingLinks(undefined)).toEqual([]);
  });

  it("names the page that meets the need, and opens its place when pressed", () => {
    const open = vi.fn();
    provideSettingLinks(open);
    const need = { kind: "publisherKey", publisher: "sogma" } as const;
    const [link] = settingLinks(need);
    expect(link.textContent).toBe("Go to Publishing settings");
    link.click();
    expect(open).toHaveBeenCalledWith(need);
  });

  it("is drawn as a button inside an inline error, the same control", () => {
    const need = { kind: "publisher" } as const;
    expect(settingLinks(need)[0].className).toBe("setting-link");
    expect(settingLinks(need, "button")[0].className).toBe("setting-link btn");
  });

  it("sends a model or provider need to AI Models and a publisher need to Publishing", () => {
    expect(setupPage({ kind: "defaultModel", output: "video" })).toBe("models");
    expect(setupPage({ kind: "providerKey", provider: "p" })).toBe("models");
    expect(setupPage({ kind: "provider", model: "m" })).toBe("models");
    expect(setupPage({ kind: "publisher" })).toBe("publishing");
  });

  // A page renamed in the nav and not here would show here.
  it("names each page as Settings' nav does", () => {
    const html = readFileSync(new NodeURL("../../../web/index.html", import.meta.url), "utf8");
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const page of ["models", "publishing"] as const) {
      const nav = doc.querySelector(`.settings-nav-item[data-settings-category="${page}"]`);
      expect(goToSettingsLabel(page)).toBe(`Go to ${nav?.textContent?.trim()} settings`);
    }
  });
});
