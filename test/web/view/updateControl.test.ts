// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../../../src/protocol/api.ts";
import type { PragmaElectronBridge } from "../../../web/core/apiClient.ts";
import { bindToggle } from "../../../web/lib/toggleRow.ts";
import { createCommands } from "../../../web/services/commands.ts";
import { wireUpdateControl } from "../../../web/view/updateControl.ts";

function setup(bridge?: Partial<PragmaElectronBridge>) {
  window.pragmaElectron = bridge as PragmaElectronBridge | undefined;
  const page = document.createElement("div");
  page.innerHTML = `
    <span id="setting-version-value"></span>
    <button id="setting-check-updates"></button>
    <div id="setting-update-status" hidden></div>
    <div id="setting-release-notes-line" hidden>
      <button id="setting-release-notes"></button>
    </div>
    <div id="setting-automatic-updates-group" hidden>
      <button id="setting-automatic-updates" aria-checked="true"></button>
    </div>`;
  const alert = vi.fn();
  const commands = createCommands();
  const showPage = vi.fn();
  commands.register({ id: "settings.open", label: "Open Settings", run: (_, category) => showPage(category) });
  const logEntry = vi.fn();
  const row = wireUpdateControl(page, { alert, bindToggle, commands, modelConsole: { logEntry } });
  return {
    row,
    commands,
    showPage,
    logEntry,
    button: page.querySelector<HTMLButtonElement>("#setting-check-updates") as HTMLButtonElement,
    status: page.querySelector<HTMLElement>("#setting-update-status") as HTMLElement,
    versionValue: page.querySelector<HTMLElement>("#setting-version-value") as HTMLElement,
    releaseNotesLine: page.querySelector<HTMLElement>("#setting-release-notes-line") as HTMLElement,
    releaseNotes: page.querySelector<HTMLButtonElement>("#setting-release-notes") as HTMLButtonElement,
    automaticGroup: page.querySelector<HTMLElement>("#setting-automatic-updates-group") as HTMLElement,
    automaticToggle: page.querySelector<HTMLButtonElement>("#setting-automatic-updates") as HTMLButtonElement,
    alert,
  };
}

function electron(platform: string, stored: boolean, save = vi.fn(async (_on: boolean) => undefined)) {
  return {
    platform,
    onUpdateStatus: () => () => undefined,
    getAutomaticUpdates: vi.fn(async () => stored),
    setAutomaticUpdates: save,
  };
}

afterEach(() => {
  window.pragmaElectron = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Release notes", () => {
  const RELEASE = "https://pragma.sogma.com/changelog#desktop-v0.4.0";

  it("names the version and opens its release notes in the browser", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { row, versionValue, releaseNotesLine, releaseNotes } = setup();
    row.show({ version: "0.4.0", releaseNotesUrl: RELEASE });
    expect(versionValue.textContent).toBe("version 0.4.0");
    expect(releaseNotesLine.hidden).toBe(false);

    releaseNotes.click();
    expect(open).toHaveBeenCalledWith(RELEASE, "_blank", "noopener");
  });

  it("stays hidden when the server sends no link", () => {
    const { row, releaseNotesLine } = setup(electron("linux", true));
    row.show({ version: "0.4.0" });
    expect(releaseNotesLine.hidden).toBe(true);
  });
});

describe("Automatic updates", () => {
  it("stays hidden in a browser tab and on macOS, where no launch check runs", () => {
    expect(setup().automaticGroup.hidden).toBe(true);
    expect(setup(electron("darwin", true)).automaticGroup.hidden).toBe(true);
  });

  it("shows the main process's value and saves a flip back to it", async () => {
    const bridge = electron("win32", false);
    const { automaticGroup, automaticToggle } = setup(bridge);
    expect(automaticGroup.hidden).toBe(false);
    await vi.waitFor(() => expect(automaticToggle.getAttribute("aria-checked")).toBe("false"));

    automaticToggle.click();
    expect(automaticToggle.getAttribute("aria-checked")).toBe("true");
    expect(bridge.setAutomaticUpdates).toHaveBeenCalledWith(true);
  });

  it("flips back and says why when the save is refused", async () => {
    const bridge = electron(
      "linux",
      true,
      vi.fn(async () => {
        throw new Error("Disk full");
      }),
    );
    const { automaticToggle, alert } = setup(bridge);
    await vi.waitFor(() => expect(bridge.getAutomaticUpdates).toHaveBeenCalled());

    automaticToggle.click();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith("Disk full"));
    expect(automaticToggle.getAttribute("aria-checked")).toBe("true");
  });
});

describe("Check for Updates", () => {
  it("opens the page it reports on and runs the button's check", async () => {
    const checkForUpdates = vi.fn(async () => ({ phase: "not-available" as const }));
    const { commands, showPage, status } = setup({ ...electron("win32", true), checkForUpdates });

    await commands.run("settings.checkForUpdates", { tab: { kind: "empty" }, pane: undefined });

    expect(showPage).toHaveBeenCalledExactlyOnceWith("general");
    expect(checkForUpdates).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(status.textContent).toBe("Pragma is up to date."));
  });

  const FAILED = { phase: "error", message: "404 Not Found" } satisfies UpdateStatus;

  it("writes a failed check's reason to the Console once, however often Electron reports it", async () => {
    let report: (status: UpdateStatus) => void = () => undefined;
    // The updater's error event and the main process's own report, then the
    // check's answer.
    const checkForUpdates = vi.fn(async () => {
      report(FAILED);
      report(FAILED);
      return FAILED;
    });
    const { button, status, logEntry } = setup({
      ...electron("linux", true),
      onUpdateStatus: (callback) => {
        report = callback;
        return () => undefined;
      },
      checkForUpdates,
    });

    button.click();
    await checkForUpdates.mock.results[0]?.value;
    expect(status.textContent).toBe("Update check failed.");
    expect(logEntry).toHaveBeenCalledExactlyOnceWith("error", "Updates", "Update check failed", FAILED.message);

    button.click();
    await checkForUpdates.mock.results[1]?.value;
    expect(logEntry).toHaveBeenCalledTimes(2);
  });

  it("does the same for the version check a browser tab runs", async () => {
    const answer = { phase: "error", message: "GitHub returned 404" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } })),
    );
    const { button, status, logEntry } = setup();

    button.click();
    await vi.waitFor(() => expect(status.textContent).toBe("Update check failed."));
    expect(logEntry).toHaveBeenCalledExactlyOnceWith("error", "Updates", "Update check failed", "GitHub returned 404");
  });
});
