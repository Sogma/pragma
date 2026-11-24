import { app, type BrowserWindow, dialog, type MessageBoxOptions, shell } from "electron";
import log from "electron-log/main";
// electron-updater is CommonJS and exposes `autoUpdater` through a computed
// getter that Node's ESM named-export detection can't see — a named import
// (`import { autoUpdater }`) throws "does not provide an export named
// 'autoUpdater'" at runtime in the packaged app. Default-import the namespace
// and destructure instead.
import electronUpdater from "electron-updater";
import { loadGlobalConfig, saveGlobalConfig } from "../src/config/loadConfig.ts";
import type { UpdateStatus } from "../src/protocol/api.ts";
import { checkLatestRelease } from "../src/server/latestRelease.ts";

// Reading `.autoUpdater` builds a platform-specific updater that touches
// electron's `app`, so it's destructured inside the functions below (after the
// macOS / dev gate) rather than at module load.

// electron-updater installs updates on Windows and Linux. macOS installs
// nothing itself: its check finds the newest release and offers the disk image
// to download. The release carries the signed Mac build and the latest-mac.yml
// electron-updater would read, but no update has been installed that way on a
// real Mac.
//
// The updater's own log goes to electron-log's file, never the in-app
// Console: the page records a failed check's error there, once, and the
// updater's step-by-step lines would bury it.
const downloadsByHand = process.platform === "darwin";

let getWindow: () => BrowserWindow | null = () => null;
let listenersBound = false;

function emit(status: UpdateStatus): void {
  getWindow()?.webContents.send("pragma:update-status", status);
}

// Only an error's first line reaches the page: electron-updater's HTTP errors
// go on with the request, a hint about tokens and the response's headers. The
// updater's own error listener writes the whole error to electron-log's file.
function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().split("\n", 1)[0].trim();
}

// An unpackaged dev build checks nothing unless PRAGMA_DEV_UPDATES is set,
// which on Windows and Linux points the updater at dev-app-update.yml.
function updateGate(): UpdateStatus | null {
  if (!app.isPackaged && !process.env.PRAGMA_DEV_UPDATES) return { phase: "unsupported" };
  return null;
}

export function setupAutoUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (downloadsByHand || updateGate() !== null) return;

  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = log;
  log.transports.file.level = "info";

  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  if (listenersBound) return;
  listenersBound = true;

  autoUpdater.on("checking-for-update", () => emit({ phase: "checking" }));
  autoUpdater.on("update-available", (info) => emit({ phase: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => emit({ phase: "not-available" }));
  autoUpdater.on("download-progress", (progress) =>
    emit({ phase: "downloading", percent: Math.round(progress.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    emit({ phase: "downloaded", version: info.version });
    void promptRestart(info.version);
  });
  autoUpdater.on("error", (error) => emit({ phase: "error", message: errorReason(error) }));
}

async function ask(options: MessageBoxOptions): Promise<number> {
  const win = getWindow();
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response;
}

async function promptRestart(version: string): Promise<void> {
  const response = await ask({
    type: "info",
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Pragma ${version} is ready to install`,
    detail: "The update has been downloaded. Restart Pragma to finish installing it.",
  });
  if (response === 0) electronUpdater.autoUpdater.quitAndInstall();
}

// The steps match the ones Settings shows after its Download button.
async function offerDownload(version: string, url: string): Promise<void> {
  const response = await ask({
    type: "info",
    buttons: ["Download", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Pragma ${version} is available`,
    detail:
      "When it has downloaded, quit Pragma, open the disk image, and drag Pragma to Applications, choosing Replace.",
  });
  if (response === 0) void shell.openExternal(url);
}

// Triggered by the Settings button (ipcMain "pragma:check-for-updates") and by
// the launch check. Returns the immediate outcome; on Windows and Linux,
// "available" then streams download/restart progress through
// "pragma:update-status".
export async function checkForUpdates(): Promise<UpdateStatus> {
  const blocked = updateGate();
  if (blocked !== null) return blocked;

  emit({ phase: "checking" });
  if (downloadsByHand) {
    const status = await checkLatestRelease(".dmg");
    emit(status);
    return status;
  }
  const { autoUpdater } = electronUpdater;
  try {
    const result = await autoUpdater.checkForUpdates();
    return result?.isUpdateAvailable
      ? { phase: "available", version: result.updateInfo.version }
      : { phase: "not-available" };
  } catch (error) {
    const message = errorReason(error);
    emit({ phase: "error", message });
    return { phase: "error", message };
  }
}

// The launch check. On macOS a newer release is offered once per version, so
// a Later isn't asked again at the next launch; Settings still offers it.
export async function checkForUpdatesAtLaunch(): Promise<void> {
  const status = await checkForUpdates();
  if (status.phase !== "available" || status.downloadUrl === undefined) return;
  try {
    const config = loadGlobalConfig();
    if (config.offeredUpdate === status.version) return;
    saveGlobalConfig({ ...config, offeredUpdate: status.version });
  } catch (error) {
    // An unreadable config.json offers nothing, rather than asking every launch.
    console.error("Couldn't record the update offered at launch", error);
    return;
  }
  await offerDownload(status.version, status.downloadUrl);
}
