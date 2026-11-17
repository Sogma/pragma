import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type WebContents,
} from "electron";
import { createSafeStorageProtector } from "../src/config/credentialProtector.ts";
import { createFileCredentialStore } from "../src/config/credentialStore.ts";
import { setCredentialHost, setCredentialStore } from "../src/config/credentials.ts";
import { HostStateParseError } from "../src/config/hostStateFile.ts";
import {
  globalConfigDir,
  loadGlobalConfig,
  relocateSpace,
  rememberSpace,
  resolveOpenableSpace,
  saveGlobalConfig,
  spaceTrust,
  updatesAutomatically,
  windowTheme,
} from "../src/config/loadConfig.ts";
import type { LibraryEntry, LibraryOffer, Misspelling, SpellcheckLanguages } from "../src/protocol/api.ts";
import { scaffoldSpace } from "../src/protocol/scaffoldSpace.ts";
import { type AgentEndpoint, createAgentEndpoint } from "../src/server/apiServer.ts";
import { defaultAppTarget, systemTarget } from "../src/server/defaultApp.ts";
import { resumeJobs } from "../src/server/jobRunner.ts";
import { createLaunchTokenAuth, LAUNCH_TOKEN_COOKIE } from "../src/server/launchTokenAuth.ts";
import { listeningPort } from "../src/server/listeningPort.ts";
import { createProductionServer, type ProductionServer } from "../src/server/productionServer.ts";
import { newSpaceFolderIn } from "../src/server/rootedFiles.ts";
import { createServedSpace, type ServedSpace } from "../src/server/servedSpace.ts";
import {
  addOfferedLibrary,
  addSpaceLibrary,
  libraryOffers,
  locateSpaceLibrary,
  moveLibrariesOntoSpaces,
  spaceLibrary,
} from "../src/server/spaceLibraries.ts";
import { listedSpaces } from "../src/server/spaceList.ts";
import { readStaticFile } from "../src/server/staticFiles.ts";
import { pragmaVersion } from "../src/server/version.ts";
import { openAboutWindow } from "./aboutWindow.ts";
import { checkForUpdates, setupAutoUpdater } from "./autoUpdate.ts";
import { menuBarTemplate } from "./menuBar.ts";
import { framePermits } from "./permissions.ts";
import { windowBackground } from "./windowBackground.ts";
import { boundsOnScreen } from "./windowBounds.ts";

const staticRoot = path.join(app.getAppPath(), "dist/web");
// Bundled to CommonJS by `npm run build:preload`: a sandboxed preload (the
// Electron default, kept on rather than relaxed to sandbox: false) has no
// module loader, so preload.ts can never run unbundled the way this file does.
const preloadPath = path.join(app.getAppPath(), "dist/electron/preload.js");

let win: BrowserWindow | null = null;
let welcome: BrowserWindow | null = null;
let production: ProductionServer | null = null;

// The pages that come from the build, not the server, load over this scheme:
// the first-run window's, since no server runs before a space exists, and
// About's. Standard, so their absolute asset paths resolve as they do on the
// server's page, and secure, as a loopback page is.
const BUILD_SCHEME = "pragma-app";
protocol.registerSchemesAsPrivileged([{ scheme: BUILD_SCHEME, privileges: { standard: true, secure: true } }]);

// No OS title bar: web/index.html's #app-header is the window's drag region,
// and the window's own controls sit over its ends. titleBarOverlay hands the
// page their room as env(titlebar-area-*), which the header keeps clear
// (frame.css) at any zoom.
//
// macOS keeps its traffic lights via titleBarStyle, which needs frame left at
// its default — it is an alternative to frame:false, not composable with it;
// trafficLightPosition centers them in the header's 40px height. The overlay
// draws nothing there, and Electron empties its room in fullscreen.
//
// Windows and Linux get Electron's minimize, maximize and close, which Windows
// treats as its own (snap layouts on maximize). The page sets their colours
// and height (pragma:window-controls below); until it does, a mid grey reads
// on either theme and 39px is the header less its bottom line.
function windowChromeOptions(): Pick<
  BrowserWindowConstructorOptions,
  "titleBarStyle" | "trafficLightPosition" | "titleBarOverlay"
> {
  return process.platform === "darwin"
    ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 12, y: 13 }, titleBarOverlay: true }
    : { titleBarStyle: "hidden", titleBarOverlay: { color: "rgba(0, 0, 0, 0)", symbolColor: "#888", height: 39 } };
}

// Only ever a folder that exists: a space to open, or where a new one goes.
async function pickSpace(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
}

// The first run, and a launch whose every space has gone: the welcome window
// (web/welcome.ts), Manage Spaces' create and open pages beside the spaces
// registered, if any. Shown once painted, so it never flashes white before
// its theme. Closing it without opening a space quits, since there is nothing
// else to show.
function openWelcome(): void {
  welcome = new BrowserWindow({
    width: 800,
    height: 650,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Welcome to Pragma",
    backgroundColor: windowBackground(nativeTheme),
    ...windowChromeOptions(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  });
  welcome.once("ready-to-show", () => welcome?.show());
  welcome.on("closed", () => {
    welcome = null;
    if (!served) app.quit();
  });
  void welcome.loadURL(`${BUILD_SCHEME}://app/welcome.html`);
}

// The production server (and its port) lives for the life of the app:
// opening a different space, from any entry point, switches the served space
// and reloads the window rather than recreating the server on a new port.
let served: ServedSpace | undefined;
let agentEndpoint: AgentEndpoint | undefined;

// Fixed, because localStorage belongs to the window's origin, port included:
// a new port each launch would start every launch from default settings.
// Below every OS's ephemeral range, and not 4320, the port someone moving
// the agent endpoint off a taken 4319 would likely pick.
const WINDOW_PORT = 24319;

async function openSpace(spacePath: string): Promise<void> {
  saveGlobalConfig(rememberSpace(loadGlobalConfig(), spacePath));

  if (served) {
    served.switchTo(spacePath);
    if (win) await win.webContents.reload();
    return;
  }

  // The agent endpoint is a second listener, on its own fixed loopback port,
  // and only exists when the API is switched on (docs/agent-api.md). It reads
  // the served space, so switching spaces above changes which tokens it
  // accepts without rebinding anything.
  served = createServedSpace(spacePath);
  agentEndpoint = createAgentEndpoint(served.root);
  await agentEndpoint.apply().catch((error: unknown) => {
    console.error("Agent endpoint failed to start", error);
  });

  const launchToken = createLaunchTokenAuth();
  production = createProductionServer({
    port: WINDOW_PORT,
    served,
    staticRoot,
    auth: launchToken.auth,
    agentEndpoint,
    // The desktop app is the writer's own machine, so an OAuth sign-in's
    // browser is theirs.
    ownMachine: true,
  });
  // The port actually bound, never WINDOW_PORT itself: when that port is
  // taken, whatever holds it isn't Pragma, and the window must not load it.
  const port = await listeningPort(production.server, "127.0.0.1");
  // A session cookie in the default session reaches every window this app
  // opens and nothing outside it. Strict, so no other site's page can make
  // the window's own requests carry it.
  await session.defaultSession.cookies.set({
    url: `http://127.0.0.1:${port}/`,
    name: LAUNCH_TOKEN_COOKIE,
    value: launchToken.token,
    httpOnly: true,
    sameSite: "strict",
  });

  const saved = loadGlobalConfig().windowBounds;
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  win = new BrowserWindow({
    ...boundsOnScreen(saved, workAreas, screen.getPrimaryDisplay().workArea, { width: 1280, height: 800 }),
    show: false,
    title: "Pragma",
    backgroundColor: windowBackground(nativeTheme),
    ...windowChromeOptions(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
  });
  // Maximized over the normal bounds above, so un-maximizing goes back to
  // them, and before the window shows, so it never shows at the smaller size.
  if (saved?.maximized === true) win.maximize();
  win.show();
  if (saved?.fullScreen === true) win.setFullScreen(true);
  // Electron swallows a failed preload script otherwise — no crash, no
  // terminal output, just every window.pragmaElectron-gated row silently
  // absent.
  win.webContents.on("preload-error", (_event, failedPreloadPath, error) => {
    console.error("[preload error]", failedPreloadPath, error);
  });
  // A renderer beforeunload that cancels (the save queue still holds writes)
  // keeps the window open with no prompt at all, so this asks instead.
  //
  // preventDefault() here overrides that cancel and lets the window close —
  // the documented contract, which reads backwards — so it runs only for
  // "Close anyway". Cancel leaves the beforeunload in force.
  win.webContents.on("will-prevent-unload", (event) => {
    if (!win) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: "warning",
      buttons: ["Close anyway", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "Some changes haven't been saved yet.",
      detail: "Pragma is still trying to write them. Closing now will lose them.",
    });
    if (choice === 0) event.preventDefault();
  });

  // The normal bounds, not the screen-filling ones of a maximized or full
  // screen window, nor a minimized one's, which Windows parks far off screen.
  win.on("close", () => {
    if (!win) return;
    const { width, height, x, y } = win.getNormalBounds();
    const windowBounds = {
      width,
      height,
      x,
      y,
      ...(win.isMaximized() && { maximized: true as const }),
      ...(win.isFullScreen() && { fullScreen: true as const }),
    };
    saveGlobalConfig({ ...loadGlobalConfig(), windowBounds });
  });
  followMainWindow(win);
  await win.loadURL(`http://127.0.0.1:${port}/`);
  welcome?.close();
}

// Manage Spaces' Electron-only rows reach these through preload.ts's
// contextBridge. They do their filesystem work here, in the main process,
// not through the shared HTTP API: placing a space anywhere or opening an
// arbitrary folder can only be a local, Electron-only capability (see
// preload.ts).
ipcMain.handle("pragma:browse-space-location", () => pickSpace());

ipcMain.handle("pragma:create-space-at", async (_event, name: string, parentDir: string, examples: unknown) => {
  const placed = newSpaceFolderIn(parentDir, name);
  if ("refused" in placed) throw new Error(placed.refused);
  await scaffoldSpace(placed.folder, { examples: examples === true });
  await openSpace(placed.folder);
});

// The welcome window's list and its version line. It loads from the build,
// with no server to ask (web/welcome.ts).
ipcMain.handle("pragma:list-spaces", () => listedSpaces(loadGlobalConfig()));
ipcMain.handle("pragma:app-version", () => pragmaVersion);

// A registered space by its id, never a path: the page names only what the
// registry already holds.
ipcMain.handle("pragma:open-space", async (_event, id: string) => {
  const record = loadGlobalConfig().spaces?.[id];
  if (!record) throw new Error("Not a known space");
  if (!existsSync(record.path)) throw new Error("That space's folder wasn't found.");
  await openSpace(record.path);
});

// Points an existing registry entry at a folder that moved, keeping its id —
// and with it every capability approved for that space, since grants are
// keyed by the id (src/server/grants.ts).
//
// Electron-only and deliberately not an HTTP route: it is the one space
// operation that takes an arbitrary filesystem path, and the remote-access
// target must expose no such thing. See docs/architecture.md's Document writes
// and reference integrity section.
ipcMain.handle("pragma:relocate-space", async (_event, id: string) => {
  if (!loadGlobalConfig().spaces?.[id]) throw new Error("Not a known space");

  const picked = await pickSpace();
  if (!picked) return undefined;

  // Read after the picker, which isn't modal: a copy read before it would
  // undo any setting changed while it was open.
  const relocated = relocateSpace(loadGlobalConfig(), id, picked);
  if ("refused" in relocated) throw new Error(relocated.refused);
  saveGlobalConfig(relocated.config);
  return picked;
});

ipcMain.handle("pragma:open-space-folder", async () => {
  const picked = await pickSpace();
  if (picked) await openSpace(picked);
});

// ---- Libraries
//
// Adding or locating a library names an absolute path outside the space, so
// it happens here, from a native picker or a folder this host located for
// another space, never in a route the remote-access target serves. Its other
// writes — permission, label, removal — name no path and are ordinary routes
// on every target. See docs/architecture.md's Document writes and reference integrity.

async function pickLibraryFolder(): Promise<string | undefined> {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? undefined : result.filePaths[0];
}

ipcMain.handle("pragma:library-offers", (): LibraryOffer[] => {
  const spaceRoot = served?.root();
  return spaceRoot === undefined ? [] : libraryOffers(spaceRoot);
});

// With `from`, the offer it names, looked up here again: the page names a
// library another space has, never a folder.
ipcMain.handle(
  "pragma:add-library",
  async (_event, from?: Pick<LibraryOffer, "space" | "id">): Promise<LibraryEntry | undefined> => {
    const spaceRoot = served?.root();
    if (spaceRoot === undefined) throw new Error("No space is open");
    if (from) return addOfferedLibrary(spaceRoot, from);
    const picked = await pickLibraryFolder();
    return picked ? addSpaceLibrary(spaceRoot, picked) : undefined;
  },
);

// Points one of the space's libraries at its folder on this computer, keeping
// its id, which every `lib:<id>/…` reference already written in the space is
// against. Declaring a new library instead would leave those references
// pointing at nothing, the same failure relocating a space avoids for grants.
ipcMain.handle("pragma:relocate-library", async (_event, id: string) => {
  const spaceRoot = served?.root();
  if (spaceRoot === undefined) throw new Error("No space is open");
  spaceLibrary(spaceRoot, id);
  const picked = await pickLibraryFolder();
  if (!picked) return undefined;
  // Checked again after the picker, as relocating a space is.
  locateSpaceLibrary(spaceRoot, id, picked);
  return picked;
});

// The Secrets settings panel is a web feature on every target (see
// docs/architecture.md's Model providers and configuration section and docs/publishing.md).
// Electron's only part is the encrypted credential store installed at
// startup: no key-specific IPC channels.

// The window's own controls on Windows and Linux, in the header's colours,
// which the page reports with its height in DIPs at start and on every theme
// or zoom change. Drawn transparent, so the header shows through and a
// dialog's scrim dims under them too. The RGB stays: Linux blends their hover
// from it.
const CSS_RGB = /^rgba?\((\d{1,3}), (\d{1,3}), (\d{1,3})(?:, [\d.]+)?\)$/;
ipcMain.handle("pragma:window-controls", (event, style: unknown) => {
  const target = senderWindow(event);
  if (!target || process.platform === "darwin") return;
  const { background, foreground, height } = (style ?? {}) as Record<string, unknown>;
  const rgb = typeof background === "string" ? CSS_RGB.exec(background) : null;
  if (!rgb || typeof foreground !== "string" || !CSS_RGB.test(foreground)) return;
  if (typeof height !== "number" || !Number.isInteger(height) || height < 1) return;
  target.setTitleBarOverlay({ color: `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0)`, symbolColor: foreground, height });
});

// Which of the app's windows a page's top frame is, the main one or the
// welcome window. Every channel but the window controls answers the main
// window alone (fromOwnWindow below).
function senderWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  if (event.senderFrame?.parent !== null) return undefined;
  return [win, welcome].find((candidate) => candidate !== null && candidate.webContents === event.sender) ?? undefined;
}

// Electron's own UI follows the theme picked in Settings, not only the OS:
// the window controls' hover tint comes from it. "system" hands it back to
// the OS, and with it prefers-color-scheme, which System Default reads.
//
// So does the window's background. The pick is saved too, because the next
// launch opens its windows before the page can say which theme it keeps.
ipcMain.handle("pragma:native-theme", (event, theme: unknown) => {
  if (!fromOwnWindow(event)) return;
  if (theme !== "system" && theme !== "light" && theme !== "dark") return;
  nativeTheme.themeSource = theme;
  win?.setBackgroundColor(windowBackground(nativeTheme));
  const config = loadGlobalConfig();
  if (config.windowTheme !== theme) saveGlobalConfig({ ...config, windowTheme: theme });
});

// ---- A file Pragma can't open
//
// Its menu offers the system's default app and file manager. The renderer
// names a space path and this resolves it against the open space; the open
// itself asks src/server/defaultApp.ts again as it happens, so a menu drawn
// before the file changed can't hand over one that is no longer safe.
function fromOwnWindow(event: IpcMainInvokeEvent): boolean {
  return win !== null && event.sender === win.webContents && event.senderFrame?.parent === null;
}

async function defaultAppTargetFor(event: IpcMainInvokeEvent, input: string) {
  const spaceRoot = served?.root();
  if (!fromOwnWindow(event) || spaceRoot === undefined) return { refusal: "Pragma can't open this file" };
  return defaultAppTarget(spaceRoot, input, {
    trusted: spaceTrust(loadGlobalConfig(), spaceRoot) === true,
    platform: process.platform,
    pathExt: process.env.PATHEXT,
  });
}

ipcMain.handle("pragma:default-app-refusal", async (event, input: string) => {
  const target = await defaultAppTargetFor(event, input);
  return "refusal" in target ? target.refusal : null;
});

ipcMain.handle("pragma:open-in-default-app", async (event, input: string) => {
  const target = await defaultAppTargetFor(event, input);
  if ("refusal" in target) return target.refusal;
  return (await shell.openPath(target.file)) || null;
});

ipcMain.handle("pragma:show-in-folder", async (event, input: string) => {
  const spaceRoot = served?.root();
  if (!fromOwnWindow(event) || spaceRoot === undefined) return;
  const target = await systemTarget(spaceRoot, input);
  if ("file" in target) shell.showItemInFolder(target.file);
});

// ---- The text menu's spelling rows
//
// Chromium names the misspelled word under the pointer only in its own
// context-menu event, which fires for a right-click the page left
// uncancelled. The page asks during that right-click, ahead of Chromium's
// report, so its question is waiting when the event comes and takes the
// answer. The timeout covers a report that never comes.
const spellingQuestions = new Map<number, (misspelling: Misspelling | null) => void>();

ipcMain.handle("pragma:misspelling-at-menu", (event) => {
  if (!fromOwnWindow(event)) return null;
  const id = event.sender.id;
  spellingQuestions.get(id)?.(null);
  return new Promise<Misspelling | null>((resolve) => {
    const timeout = setTimeout(() => answer(null), 500);
    function answer(misspelling: Misspelling | null): void {
      clearTimeout(timeout);
      spellingQuestions.delete(id);
      resolve(misspelling);
    }
    spellingQuestions.set(id, answer);
  });
});

ipcMain.handle("pragma:replace-misspelling", (event, word: unknown) => {
  if (fromOwnWindow(event) && typeof word === "string") event.sender.replaceMisspelling(word);
});

// Replacing the word with itself has Chromium check it again, which clears
// its underline now that the dictionary holds it.
ipcMain.handle("pragma:add-to-dictionary", (event, word: unknown) => {
  if (!fromOwnWindow(event) || typeof word !== "string") return;
  event.sender.session.addWordToSpellCheckerDictionary(word);
  event.sender.replaceMisspelling(word);
});

ipcMain.handle("pragma:added-words", (event) =>
  fromOwnWindow(event) ? event.sender.session.listWordsInSpellCheckerDictionary() : [],
);

ipcMain.handle("pragma:remove-from-dictionary", (event, word: unknown) => {
  if (fromOwnWindow(event) && typeof word === "string") event.sender.session.removeWordFromSpellCheckerDictionary(word);
});

ipcMain.handle("pragma:spellcheck-languages", (event): SpellcheckLanguages => {
  if (!fromOwnWindow(event)) return { chosen: [], available: [] };
  const checker = event.sender.session;
  return { chosen: checker.getSpellCheckerLanguages(), available: checker.availableSpellCheckerLanguages };
});

// Only languages Chromium has a dictionary for, and never none: an empty list
// would check nothing while the Spellcheck switch says it checks.
ipcMain.handle("pragma:set-spellcheck-languages", (event, codes: unknown) => {
  if (!fromOwnWindow(event) || !Array.isArray(codes)) return;
  const checker = event.sender.session;
  const known = codes.filter(
    (code): code is string => typeof code === "string" && checker.availableSpellCheckerLanguages.includes(code),
  );
  if (known.length > 0) checker.setSpellCheckerLanguages(known);
});

// Settings → General's "Check for updates" button (web/main.ts, behind
// window.pragmaElectron). The updater itself, its event stream, and the
// "restart to install" dialog all live in electron/autoUpdate.ts.
ipcMain.handle("pragma:check-for-updates", () => checkForUpdates());

// Settings → General's "Automatic updates", read once at launch below.
ipcMain.handle("pragma:get-automatic-updates", () => updatesAutomatically(loadGlobalConfig()));
ipcMain.handle("pragma:set-automatic-updates", (event, on: boolean) => {
  if (!fromOwnWindow(event)) return;
  saveGlobalConfig({ ...loadGlobalConfig(), automaticUpdates: on === true });
});

// macOS's menu bar: the base one (menuBar.ts) until the main window's page
// describes its own, and again once that window closes. Windows and Linux
// have none, the header being the window's title bar.
let pageMenuBar: unknown;

function applyMenuBar(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const shown = win !== null && !win.isDestroyed() ? win : undefined;
  const template = menuBarTemplate(pageMenuBar, {
    run: (command, arg) => {
      if (win !== null && !win.isDestroyed()) win.webContents.send("pragma:menu-command", command, arg);
    },
    showAbout: () => openAboutWindow(`${BUILD_SCHEME}://app/about.html?version=${encodeURIComponent(pragmaVersion)}`),
    fullScreen: shown?.isFullScreen() ?? false,
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Sent again whenever what the page's menus hold changes: a label, which
// commands apply, a chord.
ipcMain.handle("pragma:menu-bar", (event, menus: unknown) => {
  if (!fromOwnWindow(event)) return;
  pageMenuBar = menus;
  applyMenuBar();
});

// However the main window opened, the menu bar's full screen item follows
// it, and its page's menus go with it when it closes.
function followMainWindow(window: BrowserWindow): void {
  window.on("enter-full-screen", applyMenuBar);
  window.on("leave-full-screen", applyMenuBar);
  window.on("closed", () => {
    if (win !== window) return;
    win = null;
    pageMenuBar = undefined;
    applyMenuBar();
  });
}

/** Ends the launch when the config file is there but won't parse, rather than
 * opening a window whose first save would rewrite it from nothing. Nothing
 * in-app can repair the file that holds the app's own settings, so this opens
 * the folder rather than offering a fix it cannot perform. */
function reportUnreadableConfig(error: HostStateParseError): void {
  const choice = dialog.showMessageBoxSync({
    type: "error",
    buttons: ["Open Config Folder", "Quit"],
    defaultId: 0,
    cancelId: 1,
    message: "Pragma can't read its configuration",
    detail: error.message,
  });
  if (choice === 0) void shell.openPath(globalConfigDir());
  app.exit(1);
}

app.whenReady().then(async () => {
  applyMenuBar();
  // Keys and sign-ins rest in the encrypted credential store, protected
  // through the async safeStorage calls, which only exist once the app is ready.
  setCredentialStore(
    createFileCredentialStore({
      backing: "encrypted",
      root: globalConfigDir,
      protector: createSafeStorageProtector({ safeStorage }),
    }),
  );
  setCredentialHost("desktop");

  // Permissions by who asks (permissions.ts): the window's own page, judged
  // as the navigation guard judges an origin, or a frame inside it. No device
  // is ever offered to a page.
  const ownPage = (contents: WebContents | null, url: string | undefined, mainFrame: boolean): boolean =>
    contents !== null && mainFrame && url !== undefined && sameOrigin(url, contents.getURL());
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(framePermits(permission, ownPage(contents, details.requestingUrl, details.isMainFrame))),
  );
  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    framePermits(permission, ownPage(contents, details.requestingUrl ?? requestingOrigin, details.isMainFrame)),
  );
  session.defaultSession.setDevicePermissionHandler(() => false);

  // Not the configured `spacePath` directly: a space whose folder has gone (an
  // unmounted share, a removable disk) would be opened anyway, and every read
  // against it fails with no way back. Falling through to another registered
  // space recovers; finding none is a first run, so it lands on the welcome
  // window rather than an error.
  let initialSpace: string | undefined;
  try {
    initialSpace = resolveOpenableSpace(loadGlobalConfig());
  } catch (error) {
    if (error instanceof HostStateParseError) return reportUnreadableConfig(error);
    throw error;
  }
  await moveLibrariesOntoSpaces().catch((error: unknown) => {
    console.error("Libraries could not all be moved onto their spaces", error);
  });
  // Before any window opens, so each opens in its theme's background, and a
  // page that reads prefers-color-scheme gets the theme picked last.
  nativeTheme.themeSource = windowTheme(loadGlobalConfig());

  protocol.handle(BUILD_SCHEME, async (request) => {
    const file = await readStaticFile(staticRoot, new URL(request.url).pathname);
    return file
      ? new Response(new Uint8Array(file.content), { headers: { "content-type": file.type } })
      : new Response(null, { status: 404 });
  });
  if (initialSpace) await openSpace(initialSpace);
  else openWelcome();
  // After the credential store, which a provider's sign-in is read through.
  resumeJobs();

  // No-op on macOS and in unpackaged dev (see autoUpdate.ts). The startup check
  // is quiet — outcomes surface only in the Settings row, and the sole proactive
  // interrupt is the "restart to install" dialog once an update has downloaded.
  // Turning "Automatic updates" off skips it; the Settings button still checks.
  setupAutoUpdater(() => win);
  if (updatesAutomatically(loadGlobalConfig())) setTimeout(() => void checkForUpdates(), 4000);

  // With no main window, a Dock click brings one back even while the About
  // window is up.
  app.on("activate", () => {
    if (win === null && welcome === null && production) {
      const { port } = production.server.address() as AddressInfo;
      win = new BrowserWindow({
        width: 1280,
        height: 800,
        title: "Pragma",
        backgroundColor: windowBackground(nativeTheme),
        ...windowChromeOptions(),
        webPreferences: { contextIsolation: true, nodeIntegration: false, preload: preloadPath },
      });
      followMainWindow(win);
      void win.loadURL(`http://127.0.0.1:${port}/`);
    }
  });
});

// Every new window a page asks for — a reading-view link, a video player's
// "Watch on YouTube" — goes to the system browser. Electron would otherwise
// open it as a bare app window, with none of the browser's own safeguards.
// Registered per webContents so an embedded frame's request is caught too.
//
// A page navigating its own window away is caught the same way, whatever
// sent it: another origin loaded there would get the preload's bridge. Only
// the app's own origin stays in the window.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => {
    if (sameOrigin(event.url, contents.getURL())) return;
    event.preventDefault();
    if (/^https?:/i.test(event.url)) void shell.openExternal(event.url);
  });
  if (contents.getType() === "window") {
    wireDevTools(contents);
    wireContextMenu(contents);
  }
});

// Ctrl+Shift+I (⌥⌘I on a Mac) opens DevTools in every build: Electron's own
// shortcut for it lives on its default menu, which the app's replaces.
function wireDevTools(contents: WebContents): void {
  contents.on("before-input-event", (event, input) => {
    const mac = process.platform === "darwin";
    const chord = mac ? input.meta && input.alt : input.control && input.shift;
    if (input.type !== "keyDown" || input.code !== "KeyI" || !chord) return;
    event.preventDefault();
    contents.toggleDevTools();
  });
}

// A right-click the page left uncancelled answers the spelling question
// waiting for it. Run from source, any other offers Inspect Element,
// standing in for the browser's menu, which Electron has none of; the page
// leaves those right-clicks alone (web/lib/textMenu.ts).
function wireContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const answer = spellingQuestions.get(contents.id);
    if (answer) {
      const { misspelledWord: word, dictionarySuggestions: suggestions } = params;
      answer(word ? { word, suggestions } : null);
    } else if (!app.isPackaged) {
      const inspect = () => contents.inspectElement(params.x, params.y);
      Menu.buildFromTemplate([{ label: "Inspect Element", click: inspect }]).popup();
    }
  });
}

// A URL on the build's scheme has an opaque origin, "null", as a file: URL
// has, so comparing origins alone would let that page move to any file.
// Scheme and host stand in for an origin it lacks.
function sameOrigin(a: string, b: string): boolean {
  const originOf = (url: URL): string => (url.origin === "null" ? `${url.protocol}//${url.host}` : url.origin);
  try {
    return originOf(new URL(a)) === originOf(new URL(b));
  } catch {
    return false;
  }
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  production?.server.close();
});
