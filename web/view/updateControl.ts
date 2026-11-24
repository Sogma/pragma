// Settings → General's version row. "Check for updates" is two mechanisms
// behind one always-shown button: the desktop app checks in its main process
// over the bridge (electron/autoUpdate.ts), where Windows and Linux go on to
// download the update and report progress; a browser tab falls back to a
// read-only version check against /api/updates/check.
//
// A release the app can't install itself (macOS) comes with its download
// link, and the button offers Download until the next check.
//
// "Automatic updates" shows only in the desktop app: it gates the launch
// check, which a browser tab doesn't make.
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
      if (status.downloadUrl) return `Update ${status.version} available.`;
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

// In the words of the offer the launch check makes on macOS.
export const INSTALL_STEPS =
  "When it has downloaded, quit Pragma, open the disk image, and drag Pragma to Applications, choosing Replace.";

export interface VersionRow {
  /** Names the running version, and links its release notes when it has some. */
  show(info: AppletInfoResponse): void;
}

/** Wires the controls inside `page`, the Settings body. */
export function wireUpdateControl(page: HTMLElement, deps: UpdateControlDeps): VersionRow {
  const { alert, bindToggle } = deps;
  const button = must<HTMLButtonElement>("#setting-check-updates", page);
  const status = must<HTMLElement>("#setting-update-status", page);
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

  const bridge = window.pragmaElectron;
  const autoDownloads = bridge !== undefined && bridge.platform !== "darwin";
  // Electron reports one failed check several times (the updater's error
  // event, then the check's own answer), so only the turn into "error"
  // writes a Console entry.
  let shownPhase: UpdateStatus["phase"] | undefined;
  let downloadUrl: string | undefined;
  function render(next: UpdateStatus): void {
    if (next.phase === "error" && shownPhase !== "error") {
      deps.modelConsole.logEntry("error", "Updates", "Update check failed", next.message);
    }
    shownPhase = next.phase;
    downloadUrl = next.phase === "available" ? next.downloadUrl : undefined;
    button.textContent = downloadUrl ? "Download" : "Check for updates";
    button.classList.toggle("primary", downloadUrl !== undefined);
    // Disabled for every phase that is still going somewhere, so a second
    // click can't start a parallel check or interrupt a download.
    button.disabled =
      next.phase === "checking" || (next.phase === "available" && !downloadUrl) || next.phase === "downloading";
    status.textContent = statusText(next, autoDownloads);
    status.hidden = false;
  }

  const check = bridge
    ? () => {
        render({ phase: "checking" });
        void bridge.checkForUpdates().then(render);
      }
    : () => {
        render({ phase: "checking" });
        void fetchUpdateCheck()
          .then(render)
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : "Network error";
            render({ phase: "error", message });
          });
      };
  button.addEventListener("click", () => {
    if (downloadUrl === undefined) {
      check();
      return;
    }
    openExternalLink(downloadUrl);
    status.textContent = INSTALL_STEPS;
  });
  // The menu's check, on the General page where its outcome shows. It checks
  // even while the button offers Download, and not while a check is running.
  deps.commands.register({
    id: "settings.checkForUpdates",
    label: "Check for Updates",
    run: (context) => {
      void deps.commands.run("settings.open", context, "general");
      if (!button.disabled) check();
    },
  });

  if (bridge) {
    bridge.onUpdateStatus(render);
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
  }
  return row;
}
