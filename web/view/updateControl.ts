// Settings → General's version row. "Check for updates" is two mechanisms
// behind one always-shown button: Windows/Linux Electron runs electron-updater
// over the bridge (electron/autoUpdate.ts) and reports download progress;
// macOS Electron (auto-update is off there) and the browser targets
// fall back to a read-only version check against /api/updates/check.
//
// Only the wording differs otherwise, hence `autoDownloads` as a parameter
// rather than two copies of the status text.
//
// "Automatic updates" shows only where electron-updater runs: it gates the
// launch check, which the other targets don't make.
import type { AppletInfoResponse, UpdateStatus } from "../../src/protocol/api.ts";
import { fetchUpdateCheck } from "../core/apiClient.ts";
import { must } from "../lib/dom.ts";
import { openExternalLink } from "../lib/externalLinks.ts";
import type { bindToggle } from "../lib/toggleRow.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { ModelConsole } from "../services/modelConsole.ts";
import { createServerSetting } from "../services/serverSetting.ts";

export interface UpdateControlDeps {
  alert(message: string): void;
  /** The Settings dialog's own, handed in since a view never imports one. */
  bindToggle: typeof bindToggle;
  commands: CommandRegistry;
  /** Takes a failed check's reason, which the status line leaves out. */
  modelConsole: Pick<ModelConsole, "logEntry">;
}

function statusText(status: UpdateStatus, autoDownloads: boolean): string {
  switch (status.phase) {
    case "checking":
      return "Checking for updates…";
    case "available":
      return autoDownloads
        ? `Update ${status.version} available, downloading…`
        : `Update ${status.version} available. See the release notes.`;
    case "not-available":
      return "Pragma is up to date.";
    case "downloading":
      return `Downloading update… ${status.percent}%`;
    case "downloaded":
      return `Update ${status.version} downloaded. Restart to install.`;
    case "error":
      // The reason goes to the Console instead: technical wording such as
      // "404 Not Found" or "net::ERR_INTERNET_DISCONNECTED".
      return "Update check failed.";
    case "unsupported":
      return "Automatic updates aren't available in this build.";
  }
}

export interface VersionRow {
  /** Names the running version, and links its release notes when it has some. */
  show(info: AppletInfoResponse): void;
}

/** Wires the controls inside `page`, the Settings body. */
export function wireUpdateControl(page: HTMLElement, deps: UpdateControlDeps): VersionRow {
  const { alert, bindToggle } = deps;
  const button = must<HTMLButtonElement>("#setting-check-updates", page);
  const status = must<HTMLElement>("#setting-update-status", page);
  // The button's own check, on the General page where its outcome shows. A
  // click on the button, so a check already running isn't started again.
  deps.commands.register({
    id: "settings.checkForUpdates",
    label: "Check for Updates",
    run: (context) => {
      void deps.commands.run("settings.open", context, "general");
      button.click();
    },
  });
  const versionValue = must<HTMLElement>("#setting-version-value", page);
  const releaseNotesLine = must<HTMLElement>("#setting-release-notes-line", page);
  const releaseNotes = must<HTMLButtonElement>("#setting-release-notes", page);

  let releaseNotesUrl: string | undefined;
  releaseNotes.addEventListener("click", () => {
    if (releaseNotesUrl) openExternalLink(releaseNotesUrl);
  });
  const row: VersionRow = {
    show(info) {
      versionValue.textContent = `version ${info.version}`;
      releaseNotesUrl = info.releaseNotesUrl;
      releaseNotesLine.hidden = !releaseNotesUrl;
    },
  };

  // Electron reports one failed check several times (the updater's error
  // event, then the check's own answer), so only the turn into "error"
  // writes a Console entry.
  let shownPhase: UpdateStatus["phase"] | undefined;
  function render(next: UpdateStatus, autoDownloads: boolean): void {
    if (next.phase === "error" && shownPhase !== "error") {
      deps.modelConsole.logEntry("error", "Updates", "Update check failed", next.message);
    }
    shownPhase = next.phase;
    // Disabled for every phase that is still going somewhere, so a second
    // click can't start a parallel check or interrupt a download.
    button.disabled = next.phase === "checking" || next.phase === "available" || next.phase === "downloading";
    status.textContent = statusText(next, autoDownloads);
    status.hidden = false;
  }

  const bridge = window.pragmaElectron;
  if (bridge && bridge.platform !== "darwin") {
    bridge.onUpdateStatus((next) => render(next, true));
    button.addEventListener("click", () => {
      render({ phase: "checking" }, true);
      void bridge.checkForUpdates().then((next) => render(next, true));
    });

    const automatic = createServerSetting({
      initial: true,
      fetch: () => bridge.getAutomaticUpdates(),
      save: (on) => bridge.setAutomaticUpdates(on),
      onSaveFailed: (error) =>
        alert(error instanceof Error ? error.message : "Couldn't save the automatic updates setting"),
    });
    bindToggle(must<HTMLButtonElement>("#setting-automatic-updates", page), automatic);
    must<HTMLElement>("#setting-automatic-updates-group", page).hidden = false;
    void automatic.refresh();
    return row;
  }

  button.addEventListener("click", () => {
    render({ phase: "checking" }, false);
    void fetchUpdateCheck()
      .then((next) => render(next, false))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "Network error";
        render({ phase: "error", message }, false);
      });
  });
  return row;
}
