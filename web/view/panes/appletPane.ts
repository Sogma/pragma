// The applet pane: a `.applet.html` run on its own in a sandboxed iframe. On
// its own an Applet touches nothing — no space reads or writes, no model
// calls (docs/protocol.md, Applets); anything more is a Flow's, through an
// Applet node's ports. The frame only reports its height, which sizes it.
import type { AppletManifest } from "../../../src/protocol/types.ts";
import { appletRefusal } from "../../../src/protocol/types.ts";
import type { AppletFileResponse, AppletImportSource, FileResponse } from "../../core/apiClient.ts";
import { DisposableStore } from "../../lib/disposable.ts";
import { appendMetaRow, createInspectorSection, el } from "../../lib/dom.ts";
import { dispatchFrameRequests } from "../../services/capabilityBroker.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import type { SaveQueue } from "../../services/saveQueue.ts";

export interface AppletPaneDeps {
  loadFile(path: string): Promise<FileResponse>;
  // Each mount records the revision it runs, which outside edits are checked
  // against (services/outsideEdits.ts). Unrecorded, a running Applet would
  // never follow its file, or would reload on every check against an older
  // revision its Edit code left.
  //
  // Reload writes what is queued for the file first, so it runs what Edit
  // code shows, not the last save.
  saveQueue: Pick<SaveQueue, "noteRevision" | "flush">;
  // The applet's HTML with the `pragma` client and its imports injected.
  injectRuntime(html: string, manifest: AppletManifest, imports: readonly AppletImportSource[]): string;
  // After every mount — the title bar reads the manifest's name.
  onRendered(): void;
}

export interface AppletPane extends EditorPane {
  readonly kind: "applet";
}

export function isAppletPane(pane: EditorPane): pane is AppletPane {
  return pane.kind === "applet";
}

export function appletPane(deps: Omit<AppletPaneDeps, "onRendered">): EditorPaneDescriptor {
  return {
    kind: "applet",
    chrome: { toolbar: true, readingView: false, statusbar: true, actions: [] },
    create: (group) => createAppletPane({ ...deps, onRendered: () => group.rendered() }),
  };
}

function blankFrame(): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "editor-applet-frame";
  frame.title = "Applet";
  frame.setAttribute("sandbox", "allow-scripts");
  return frame;
}

function reloadButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button applet-reload-button";
  button.setAttribute("aria-label", "Reload");
  button.append(el("span", "applet-reload-icon"));
  return button;
}

export function createAppletPane(deps: AppletPaneDeps): AppletPane {
  const store = new DisposableStore();

  const element = el("div", "editor-applet");
  const scroll = el("div", "editor-applet-scroll");
  // Why an Applet can't run, in the pane rather than thrown: an error out of
  // opening a tab reaches no one, and the pane would just stay blank.
  const notice = el("div", "document-locked-notice editor-applet-notice inline-warning");
  notice.hidden = true;
  let frame = blankFrame();
  scroll.append(notice, frame);
  element.append(scroll);
  const details = createInspectorSection("Applet");
  details.body.className = "meta-rows";
  const reload = reloadButton();

  let manifest: AppletManifest | undefined;
  // The path the pane was last given, and how many inputs it has had: a
  // Reload still loading when the next one arrives lands nowhere.
  let shownPath: string | undefined;
  let inputs = 0;

  // The content-height report, the one message a frame sends: size the frame
  // to it so the scroll region scrolls the title bar and the applet as one.
  store.add(
    dispatchFrameRequests({
      frame: () => frame,
      source: "pragma-applet",
      handlers: {},
      onNotice: (data) => {
        if (data.type !== "resize" || typeof data.height !== "number" || !Number.isFinite(data.height)) return;
        const height = `${Math.max(0, Math.round(data.height))}px`;
        if (frame.style.height !== height) frame.style.height = height;
      },
    }),
  );

  // The description stays a plain row where a Table's or a Flow's is a
  // field: it lives in the manifest, the author's own code, which an edit
  // from here would have to rewrite.
  function fillDetails(next: AppletManifest): void {
    details.body.replaceChildren();
    if (next.meta?.description) appendMetaRow(details.body, "Description", next.meta.description);
    details.section.hidden = details.body.childElementCount === 0;
  }

  // Mounts via srcdoc — the HTML stays in memory, never a fetchable
  // same-origin resource — into a fresh <iframe> every time rather than
  // reassigning srcdoc on a reused one: without allow-same-origin every
  // load gets a new opaque origin, and a same-element cross-process swap
  // is the prime suspect for a frame silently failing to render.
  function mount(file: AppletFileResponse): void {
    unmount();
    manifest = file.manifest;
    const refusal = file.importError ?? appletRefusal(file.manifest);
    if (refusal) {
      notice.textContent = refusal;
      notice.hidden = false;
    } else {
      const fresh = blankFrame();
      fresh.srcdoc = deps.injectRuntime(file.html, file.manifest, file.imports);
      frame.replaceWith(fresh);
      frame = fresh;
    }
    fillDetails(file.manifest);
    deps.onRendered();
  }

  function unmount(): void {
    manifest = undefined;
    notice.hidden = true;
    const fresh = blankFrame(); // stops the applet's script; a stale frame can no longer post
    frame.replaceWith(fresh);
    frame = fresh;
    details.body.replaceChildren();
    details.section.hidden = true;
  }

  function clear(): void {
    inputs++;
    shownPath = undefined;
    unmount();
  }

  // Saves first, as a Flow's Run does: a save that hasn't landed is the
  // status bar's to explain, and running the older file instead would show
  // code the writer has already changed.
  async function reloadShown(): Promise<void> {
    const path = shownPath;
    if (path === undefined) return;
    const at = inputs;
    const saved = await deps.saveQueue.flush(path);
    if (at !== inputs) return;
    if (!saved) {
      window.alert("Couldn't save before reloading. The status bar says why.");
      return;
    }
    let file: FileResponse;
    try {
      file = await deps.loadFile(path);
    } catch (error: unknown) {
      if (at === inputs) window.alert(error instanceof Error ? error.message : String(error));
      return;
    }
    if (at !== inputs || file.kind !== "applet") return;
    deps.saveQueue.noteRevision(file.path, file.revision);
    mount(file);
  }
  reload.addEventListener("click", () => void reloadShown());

  return {
    kind: "applet",
    element,
    inspector: details.section,
    toolbar: reload,
    async setInput(tab, ctx, prefetched) {
      if (tab.kind !== "applet") throw new Error(`the applet pane can't show a "${tab.kind}" tab`);
      inputs++;
      shownPath = tab.path;
      const file = prefetched ?? (await deps.loadFile(tab.path));
      if (!ctx.isCurrent()) return;
      if (file.kind !== "applet") throw new Error(`${tab.path} is not an applet`);
      deps.saveQueue.noteRevision(file.path, file.revision);
      mount(file);
    },
    clearInput: clear,
    title: () => manifest?.meta?.name?.trim() || undefined,
    titleHost: () => scroll, // scrolls with the frame
    dispose() {
      clear();
      store.dispose();
      element.remove();
    },
  };
}
