// About Pragma, in a window of Pragma's own (web/about.html), loaded from the
// build as the welcome window's page is. It carries no bridge: the version
// comes in its address.
import { BrowserWindow, nativeTheme } from "electron";
import { windowBackground } from "./windowBackground.ts";

// Pragma's dialogs fade in over the same time (dialog.css).
const FADE_MS = 120;

let about: BrowserWindow | null = null;

/** Opens the About window on `url`, or brings forward the one already open. */
export function openAboutWindow(url: string): void {
  if (about) {
    about.focus();
    return;
  }
  const opened = new BrowserWindow({
    width: 280,
    height: 180,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    opacity: 0,
    title: "About Pragma",
    backgroundColor: windowBackground(nativeTheme),
    titleBarStyle: "hidden",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  about = opened;
  opened.on("closed", () => {
    about = null;
  });

  // ⌘W closes it, as it closes macOS's own About panel. Left to the menu bar,
  // ⌘W is Close Tab, which acts on the main window's page.
  opened.webContents.on("before-input-event", (event, input) => {
    const commandOnly = input.meta && !input.shift && !input.alt && !input.control;
    if (input.type !== "keyDown" || !commandOnly || input.key.toLowerCase() !== "w") return;
    event.preventDefault();
    opened.close();
  });

  // Shown once painted, so never white before its theme, then faded in, and
  // nothing else: macOS gives a window Electron opens no motion of its own.
  // Electron sets an opacity at once, so the fade is stepped here.
  opened.once("ready-to-show", () => {
    opened.show();
    const start = Date.now();
    const step = setInterval(() => {
      const done = Math.min(1, (Date.now() - start) / FADE_MS);
      if (!opened.isDestroyed()) opened.setOpacity(1 - (1 - done) ** 2);
      if (done === 1 || opened.isDestroyed()) clearInterval(step);
    }, 16);
  });
  void opened.loadURL(url);
}
