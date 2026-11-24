import { contextBridge, ipcRenderer, webFrame } from "electron";
import type {
  LibraryEntry,
  LibraryOffer,
  LinkRequest,
  ListedSpace,
  MenuBarMenu,
  Misspelling,
  SpellcheckLanguages,
  UpdateStatus,
} from "../src/protocol/api.ts";

// A handler's error reaches the page with Electron's own prefix on it,
// "Error invoking remote method '<channel>': Error: ", which the page would
// show as is. Every message a handler throws is written for its reader.
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ""));
  });
}

// The renderer's only bridge into the main process, which does the real
// filesystem work — never the shared HTTP API, whose routes the remote-access
// target serves to other devices and so must never accept an arbitrary path.
// The web build feature-detects `window.pragmaElectron` to show Electron-only
// rows.
//
// Not `window.pragma`: that name belongs to an applet's sandboxed iframe — a
// different realm, so no collision, but kept apart to avoid confusing the two.
contextBridge.exposeInMainWorld("pragmaElectron", {
  // A plain string, not a function — safe to expose directly since it
  // carries no capability of its own.
  //
  // The web build reads it to leave the window controls alone on macOS,
  // whose traffic lights take no colours from the page (electron/main.ts).
  platform: process.platform,
  browseSpaceLocation: (): Promise<string | undefined> => invoke("pragma:browse-space-location"),
  createSpaceAt: (name: string, parentDir: string, examples: boolean): Promise<void> =>
    invoke("pragma:create-space-at", name, parentDir, examples),
  openSpaceFolder: (): Promise<void> => invoke("pragma:open-space-folder"),
  relocateSpace: (id: string): Promise<string | undefined> => invoke("pragma:relocate-space", id),
  // The welcome window's own reads and its one switch: it loads from the
  // build, before any server runs.
  listSpaces: (): Promise<ListedSpace[]> => invoke("pragma:list-spaces"),
  appVersion: (): Promise<string> => invoke("pragma:app-version"),
  openSpace: (id: string): Promise<void> => invoke("pragma:open-space", id),
  // Libraries. Adding or locating one names an absolute path outside the
  // space, so — exactly like the space channels above — the folder only ever
  // comes from the main process, never an HTTP route: a native picker, or an
  // offer named by its space and library id. Permission, label and removal
  // name no path and are routes instead.
  libraryOffers: (): Promise<LibraryOffer[]> => invoke("pragma:library-offers"),
  addLibrary: (from?: Pick<LibraryOffer, "space" | "id">): Promise<LibraryEntry | undefined> =>
    invoke("pragma:add-library", from),
  relocateLibrary: (id: string): Promise<string | undefined> => invoke("pragma:relocate-library", id),
  // The window's own controls, which Electron draws over the header on
  // Windows/Linux in the colours and height the page reports. The theme
  // picked in Settings goes to Electron's own UI.
  styleWindowControls: (style: { background: string; foreground: string; height: number }): Promise<void> =>
    invoke("pragma:window-controls", style),
  setNativeTheme: (theme: "system" | "light" | "dark"): Promise<void> => invoke("pragma:native-theme", theme),
  // Settings → Appearance's zoom. A renderer call, not a channel: nothing
  // in the main process needs the level. Without the native menu, Electron
  // binds no zoom keys of its own, so this is the only way it changes.
  setZoomFactor: (factor: number): void => webFrame.setZoomFactor(factor),
  // Settings → General's update control. The check resolves with the
  // immediate outcome; follow-on states (downloading → downloaded) stream
  // through the subscription, which returns its unsubscribe.
  checkForUpdates: (): Promise<UpdateStatus> => invoke("pragma:check-for-updates"),
  onUpdateStatus: (callback: (status: UpdateStatus) => void): (() => void) => {
    const handler = (_event: unknown, status: UpdateStatus): void => callback(status);
    ipcRenderer.on("pragma:update-status", handler);
    return () => ipcRenderer.removeListener("pragma:update-status", handler);
  },
  getAutomaticUpdates: (): Promise<boolean> => invoke("pragma:get-automatic-updates"),
  setAutomaticUpdates: (on: boolean): Promise<void> => invoke("pragma:set-automatic-updates", on),
  // A file Pragma can't open, named by its space path. The main process
  // checks it against src/server/defaultApp.ts; the first two answer why it
  // stays closed, or null.
  defaultAppRefusal: (path: string): Promise<string | null> => invoke("pragma:default-app-refusal", path),
  openInDefaultApp: (path: string): Promise<string | null> => invoke("pragma:open-in-default-app", path),
  showInFolder: (path: string): Promise<void> => invoke("pragma:show-in-folder", path),
  // The text menu's spelling rows. The question must go out during the
  // right-click itself, ahead of Chromium's own report of it, which the main
  // process turns into the answer.
  misspellingAtMenu: (): Promise<Misspelling | null> => invoke("pragma:misspelling-at-menu"),
  replaceMisspelling: (word: string): Promise<void> => invoke("pragma:replace-misspelling", word),
  addToDictionary: (word: string): Promise<void> => invoke("pragma:add-to-dictionary", word),
  // Settings → Editor → Custom dictionary.
  addedWords: (): Promise<string[]> => invoke("pragma:added-words"),
  removeFromDictionary: (word: string): Promise<void> => invoke("pragma:remove-from-dictionary", word),
  // Settings → Editor → Spellcheck languages, on Windows and Linux.
  spellcheckLanguages: (): Promise<SpellcheckLanguages> => invoke("pragma:spellcheck-languages"),
  setSpellcheckLanguages: (codes: string[]): Promise<void> => invoke("pragma:set-spellcheck-languages", codes),
  // macOS's menu bar: the page describes its menus, and a pick comes back as
  // the command and argument its item named.
  setMenuBar: (menus: MenuBarMenu[]): Promise<void> => invoke("pragma:menu-bar", menus),
  onMenuCommand: (callback: (command: string, arg: unknown) => void): (() => void) => {
    const handler = (_event: unknown, command: string, arg: unknown): void => callback(command, arg);
    ipcRenderer.on("pragma:menu-command", handler);
    return () => ipcRenderer.removeListener("pragma:menu-command", handler);
  },
  // Pragma links: what the latest asks of the window, taken once, and word
  // that another has come while the window shows.
  takeLink: (): Promise<LinkRequest | null> => invoke("pragma:take-link"),
  onLinkWaiting: (callback: () => void): (() => void) => {
    const handler = (): void => callback();
    ipcRenderer.on("pragma:link-waiting", handler);
    return () => ipcRenderer.removeListener("pragma:link-waiting", handler);
  },
});
