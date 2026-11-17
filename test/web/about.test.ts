// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const html = readFileSync(new NodeURL("../../web/about.html", import.meta.url), "utf8");
const builderConfig = readFileSync(new NodeURL("../../electron-builder.yml", import.meta.url), "utf8");

// The page as the build serves it, at the address the app opens it on. jsdom
// has no matchMedia, which the theme reads.
async function openAbout(search: string): Promise<void> {
  window.history.replaceState(null, "", `/about.html${search}`);
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  await import("../../web/about.ts");
}

beforeEach(() => {
  vi.resetModules();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof matchMedia;
});

describe("the About window", () => {
  it("shows the version its address names", async () => {
    await openAbout("?version=0.5.3");

    const line = document.querySelector<HTMLElement>(".about-version");
    expect(line?.hidden).toBe(false);
    expect(line?.textContent).toBe("version 0.5.3");
  });

  // The packaged app carries electron-builder.yml's line in its bundle, where
  // Finder's Get Info reads it.
  it("shows the copyright line the packaged app carries", () => {
    const packaged = /^copyright: "(.*)"$/m.exec(builderConfig)?.[1];
    const page = new DOMParser().parseFromString(html, "text/html");

    expect(packaged).toBeDefined();
    expect(page.querySelector(".about-copyright")?.textContent).toBe(packaged);
  });
});
