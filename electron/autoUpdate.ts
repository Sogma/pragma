import { app, type BrowserWindow, dialog } from "electron";
import log from "electron-log/main";
// electron-updater is CommonJS and exposes `autoUpdater` through a computed
// getter that Node's ESM named-export detection can't see — a named import
// (`import { autoUpdater }`) throws "does not provide an export named
// 'autoUpdater'" at runtime in the packaged app. Default-import the namespace
// and destructure instead.
import electronUpdater from "electron-updater";
import type { UpdateStatus } from "../src/protocol/api.ts";

// Reading `.autoUpdater` builds a platform-specific updater that touches
// electron's `app`, so it's destructured inside the functions below (after the
// macOS / dev gate) rather than at module load.

// Windows + Linux only. macOS is gated out and falls back to the read-only
// /api/updates/check. The release carries the signed Mac build and its
// latest-mac.yml, but no update has been installed this way on a real Mac;
// web/view/updateControl.ts gates macOS too.
//
// The updater's own log goes to electron-log's file, never the in-app
// Console: the page records a failed check's error there, once, and the
// updater's step-by-step lines would bury it.

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

// Auto-update is off on macOS (see above), and an unpackaged dev build has no
// update feed unless PRAGMA_DEV_UPDATES points it at dev-app-update.yml.
function updateGate(): UpdateStatus | null {
  if (process.platform === "darwin") return { phase: "unsupported" };
  if (!app.isPackaged && !process.env.PRAGMA_DEV_UPDATES) return { phase: "unsupported" };
  return null;
}

export function setupAutoUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  if (updateGate() !== null) return;

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

async function promptRestart(version: string): Promise<void> {
  const win = getWindow();
  const options = {
    type: "info" as const,
    buttons: ["Restart now", "Later"],
    defaultId: 0,
    cancelId: 1,
    message: `Pragma ${version} is ready to install`,
    detail: "The update has been downloaded. Restart Pragma to finish installing it.",
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response === 0) electronUpdater.autoUpdater.quitAndInstall();
}

// Triggered by the Settings button (ipcMain "pragma:check-for-updates") and once
// quietly on startup. Returns the immediate outcome; "available" then streams
// download/restart progress through "pragma:update-status".
export async function checkForUpdates(): Promise<UpdateStatus> {
  const blocked = updateGate();
  if (blocked !== null) return blocked;

  const { autoUpdater } = electronUpdater;
  emit({ phase: "checking" });
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
