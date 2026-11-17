// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedSpace } from "../../src/protocol/api.ts";

const html = readFileSync(new NodeURL("../../web/welcome.html", import.meta.url), "utf8");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const mark = vi.hoisted(() => ({ mountAnimatedMark: vi.fn(() => ({ dispose: vi.fn() })) }));
vi.mock("../../web/view/animatedMark.ts", () => mark);

function desktopBridge(spaces: ListedSpace[] = []) {
  return {
    platform: "win32",
    browseSpaceLocation: vi.fn(async () => undefined),
    createSpaceAt: vi.fn(async () => undefined),
    openSpaceFolder: vi.fn(async () => undefined),
    relocateSpace: vi.fn(async (_id: string): Promise<string | undefined> => "/found/Old notes"),
    listSpaces: vi.fn(async () => spaces),
    appVersion: vi.fn(async () => "0.5.3"),
    openSpace: vi.fn(async (_id: string) => undefined),
    styleWindowControls: vi.fn(async () => undefined),
  };
}

const gone: ListedSpace = {
  id: "spc_gone",
  name: "Old notes",
  path: "/archive/Old notes",
  parent: "/archive",
  missing: true,
};

// The page as the build serves it, run fresh each time: the module starts on
// import. jsdom has no matchMedia, which the theme reads.
async function openWelcome(bridge: ReturnType<typeof desktopBridge> | undefined): Promise<void> {
  document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
  window.pragmaElectron = bridge as unknown as typeof window.pragmaElectron;
  await import("../../web/welcome.ts");
  await tick();
}

const visible = (selector: string) => document.querySelector<HTMLElement>(selector)?.hidden === false;

beforeEach(() => {
  vi.resetModules();
  mark.mountAnimatedMark.mockClear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn() })) as unknown as typeof matchMedia;
});

describe("the welcome window", () => {
  it("on a first run, shows the still logo over the version, and the examples start on", async () => {
    const bridge = desktopBridge();

    await openWelcome(bridge);

    expect(visible(".welcome-spaces")).toBe(false);
    expect(visible(".welcome-version")).toBe(true);
    expect(document.querySelector(".welcome-version")?.textContent).toBe("version 0.5.3");
    expect(mark.mountAnimatedMark).not.toHaveBeenCalled();
    expect(document.querySelector(".welcome-main .space-form")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(document.querySelector(".space-form-create .toggle-switch")?.getAttribute("aria-checked")).toBe("true");
    expect(bridge.styleWindowControls).toHaveBeenCalled();
  });

  it("with spaces registered, lists them, plays the logo with no version, and starts the examples off", async () => {
    await openWelcome(desktopBridge([gone]));

    expect(visible(".welcome-spaces")).toBe(true);
    const row = document.querySelector<HTMLElement>(".welcome-space-list .list-item") as HTMLElement;
    expect(row.querySelector(".list-item-title")?.textContent).toBe("Old notes");
    expect(row.querySelector(".list-item-subtitle")?.textContent).toBe("/archive (folder not found)");
    expect(row.classList.contains("is-missing")).toBe(true);
    expect(visible(".welcome-version")).toBe(false);
    expect(mark.mountAnimatedMark).toHaveBeenCalledOnce();
    expect(document.querySelector(".space-form-create .toggle-switch")?.getAttribute("aria-checked")).toBe("false");
  });

  it("locates a missing space from its ⋮, then opens it on a click", async () => {
    const bridge = desktopBridge([gone]);
    await openWelcome(bridge);
    bridge.listSpaces.mockResolvedValue([{ ...gone, path: "/found/Old notes", parent: "/found", missing: false }]);

    document.querySelector<HTMLButtonElement>(".welcome-space-list .list-item-menu")?.click();
    const locate = [...document.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) =>
      item.textContent?.includes("Locate…"),
    );
    locate?.click();
    await tick();
    await tick();

    expect(bridge.relocateSpace).toHaveBeenCalledWith("spc_gone");
    const row = document.querySelector<HTMLElement>(".welcome-space-list .list-item") as HTMLElement;
    expect(row.classList.contains("is-missing")).toBe(false);
    expect(row.querySelector(".list-item-menu")).toBeNull();
    row.click();
    expect(bridge.openSpace).toHaveBeenCalledWith("spc_gone");
  });

  it("reports a refused Locate under the list", async () => {
    const bridge = desktopBridge([gone]);
    bridge.relocateSpace.mockRejectedValueOnce(new Error("That folder is already a space."));
    await openWelcome(bridge);

    document.querySelector<HTMLButtonElement>(".welcome-space-list .list-item-menu")?.click();
    [...document.querySelectorAll<HTMLElement>("[role='menuitem']")]
      .find((item) => item.textContent?.includes("Locate…"))
      ?.click();
    await tick();

    expect(visible(".welcome-spaces-error")).toBe(true);
    expect(document.querySelector(".welcome-spaces-error")?.textContent).toBe("That folder is already a space.");
  });

  it("shows the logo and wordmark but no form outside the desktop app", async () => {
    await openWelcome(undefined);

    expect(document.querySelector(".settings-logo")).not.toBeNull();
    expect(document.querySelector(".settings-wordmark")?.getAttribute("aria-label")).toBe("Pragma");
    expect(document.querySelector(".space-form")).toBeNull();
    expect(visible(".welcome-version")).toBe(false);
  });
});
