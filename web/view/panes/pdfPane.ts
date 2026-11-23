// The PDF pane: PDF.js in a sandboxed frame, under the app's own controls. The frame has an opaque origin and a CSP that lets it fetch nothing,
// so a PDF.js bug lands where the app's API is out of reach; the pane hands
// it PDF.js, the document's bytes and each data file the worker asks for.
//
// The frame is reloaded whenever the pane's element is taken off the page
// (another kind of tab shown), so it announces itself on every load and the
// pane replays the runtime, the open document and where the reader was.
import type { SearchQuery } from "@codemirror/search";
import { fetchFileRaw } from "../../core/apiClient.ts";
import { createPaneFind, type FindCount, type Finder, seedText, slideIn, slideOut } from "../../findCard.ts";
import { DisposableStore, toDisposable } from "../../lib/disposable.ts";
import { appendMetaRow, createInspectorSection, el } from "../../lib/dom.ts";
import { openExternalLink } from "../../lib/externalLinks.ts";
import { zoomMenu, zoomMenuItems } from "../../lib/zoomPicker.ts";
import { dispatchFrameRequests, type FrameRequest } from "../../services/capabilityBroker.ts";
import type { CommandRegistry } from "../../services/commands.ts";
import type { EditorPane, EditorPaneDescriptor } from "../../services/editorPanes.ts";
import { COMMAND_PALETTE, type MenuItem, type MenuRegistry } from "../../services/menus.ts";
import {
  loadPdfRuntime,
  PDF_FRAME_SCRIPT,
  type PdfRuntime,
  pdfBinaryAsset,
  SCROLLBAR_STYLE,
} from "../../services/pdfRuntime.ts";
import { PDF_ZOOM_LEVELS, type PdfZoom, pdfZoom, type Setting } from "../../services/settings.ts";

export interface PdfPaneDeps {
  loadRuntime(): Promise<PdfRuntime>;
  binaryAsset(kind: string, filename: string): Promise<Uint8Array>;
  // A GET against the raw-file route.
  fetchFile(path: string): Promise<Response>;
  // A link the document's reader followed, already checked for its scheme.
  openLink(url: string): void;
  // The page shown of how many, in the status bar where a note's word count
  // is.
  reportReadout(text: string): void;
  // The zoom every PDF opens at on this device, which a Zoom pick sets.
  zoom: Setting<PdfZoom>;
}

// Where the reader was in a document: PDF.js's own view location, so the
// frame can scroll straight back to it, at the device's zoom.
interface PdfLocation {
  pageNumber: number;
  top: number;
  left: number;
}

const FRAME_SOURCE = "pragma-pdf";

// PDF.js's FindState.PENDING, as the frame reports a search still running.
const FIND_PENDING = 3;

const NO_MATCHES: FindCount = { total: 0, current: -1, capped: false };

// Scripts only as inline text and blobs the frame makes itself, its worker a
// blob too, and no fetch of any kind; the frame navigating itself is
// index.html's frame-src to refuse, not this. 'wasm-unsafe-eval' is for the
// image decoders, whose bytes the host hands in.
const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob: 'wasm-unsafe-eval'",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  "img-src blob: data:",
  "font-src blob: data:",
].join("; ");

// The pages scroll inside an absolutely positioned container, which PDFViewer
// requires, transparent so the pane's background shows around them. The
// loading spinner is a URL relative to the frame, which the CSP refuses; the
// id outranks PDF.js's own stylesheet, injected after this one.
//
// The group's floating toolbar and Find's card sit over the frame's top
// (editor-toolbar.css), so Find's current match is scrolled to the middle
// rather than to PDF.js's 50px from the top, under them.
//
// Find's marks take the find colours the host hands in. The letters are drawn
// on the canvas under the text layer, so a solid fill there would hide them:
// the layer multiplies onto the page instead, as a highlighter pen does.
const FRAME_STYLE = `
html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
#viewerContainer { position: absolute; inset: 0; overflow: auto; outline: none; }
#viewer .page.loadingIcon::after { background: none; }
#viewer .textLayer .highlight.selected { scroll-margin-top: calc(50vh - 0.5em); }
@media (forced-colors: none) {
  #viewer .textLayer { mix-blend-mode: multiply; }
  #viewer .textLayer .highlight { --highlight-bg-color: var(--find-match-bg); }
  #viewer .textLayer .highlight.selected { --highlight-selected-bg-color: var(--find-current-bg); }
}
`;

// `</script` inside the inlined script would end the element early.
function frameDocument(): string {
  const script = PDF_FRAME_SCRIPT.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><style>${SCROLLBAR_STYLE}</style><style>${FRAME_STYLE}</style><style id="pdfjs-css"></style></head><body><div id="viewerContainer" tabindex="0"><div id="viewer" class="pdfViewer"></div></div><script type="module">${script}</script></body></html>`;
}

// Only what a reader means by following a link; a `javascript:` or `file:`
// URL in a PDF is the document's, not the reader's, choice.
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function linkToOpen(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    return LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function asLocation(value: unknown): PdfLocation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { pageNumber, top, left } = value as Record<string, unknown>;
  if (!Number.isInteger(pageNumber) || typeof top !== "number" || typeof left !== "number") return undefined;
  return { pageNumber: pageNumber as number, top, left };
}

const colorScheme = () => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

// The frame can't read the app's tokens, so the theme it is told carries the
// ones its stylesheets use, by their own names: find's colours, and the
// scrollbars' (styles/scrollbars.css).
const FRAME_TOKENS = ["--find-match-bg", "--find-current-bg", "--border-input"];

function theme(): { scheme: string; tokens: Record<string, string> } {
  const computed = getComputedStyle(document.documentElement);
  const tokens = Object.fromEntries(FRAME_TOKENS.map((name) => [name, computed.getPropertyValue(name).trim()]));
  return { scheme: colorScheme(), tokens };
}

export interface PdfPane extends EditorPane {
  // The ⋮ menu's Zoom: Fit to width, then the steps, what shows checked.
  pageZoom(): MenuItem[];
  // Go to page, once a document has pages to go to.
  canGoToPage(): boolean;
  goToPage(): void;
}

function isPdfPane(pane: EditorPane): pane is PdfPane {
  return pane.kind === "pdf";
}

// The zoom is the ⋮ menu's, as a screenplay's is.
const ZOOM = zoomMenu((context) => (context.pane && isPdfPane(context.pane) ? context.pane.pageZoom() : []));

export function pdfPane(
  commands: Pick<CommandRegistry, "register">,
  menus: Pick<MenuRegistry, "register">,
): EditorPaneDescriptor {
  const pdfOf = (pane: EditorPane | undefined) => (pane && isPdfPane(pane) ? pane : undefined);
  commands.register({
    id: "pdf.goToPage",
    label: "Go to page…",
    when: (context) => pdfOf(context.pane)?.canGoToPage() ?? false,
    run: (context) => pdfOf(context.pane)?.goToPage(),
  });
  menus.register("editor.toolbar", (context) =>
    context.tab.kind === "pdf" ? [{ command: "pdf.goToPage" }, ZOOM] : [],
  );
  menus.register(COMMAND_PALETTE, [{ command: "pdf.goToPage", label: "PDF: Go to page…" }]);
  const deps: Omit<PdfPaneDeps, "reportReadout"> = {
    zoom: pdfZoom,
    loadRuntime: loadPdfRuntime,
    binaryAsset: pdfBinaryAsset,
    fetchFile: fetchFileRaw,
    openLink: openExternalLink,
  };
  return {
    kind: "pdf",
    chrome: { toolbar: true, readingView: false, statusbar: true, actions: [] },
    create: (group) => createPdfPane({ ...deps, reportReadout: (text) => group.reportReadout(text) }),
  };
}

interface PageCard {
  // Where the card shows, beside Find's card in the toolbar's row.
  readonly host: HTMLElement;
  isOpen(): boolean;
  open(page: number, pages: number): void;
  // The page now showing, which the field takes unless it holds a page typed
  // and not yet gone to.
  follow(page: number): void;
  close(slide?: boolean): void;
}

// Go to page's card, in Find's card's look and place: the page in a field,
// "of N" after it, and Close. Enter goes there and stays, the page selected
// for the next; one the document hasn't puts the count in the danger colour.
function createPageCard(go: (page: number) => void): PageCard {
  const host = el("div", "page-card-host");
  let shown:
    | { dom: HTMLElement; field: HTMLInputElement; count: HTMLElement; pages: number; typed: boolean }
    | undefined;
  // What had focus when the card opened, given it back on a close from it.
  let returnFocus: HTMLElement | undefined;

  const pageIn = (value: string, pages: number): number | undefined => {
    const page = /^\d+$/.test(value.trim()) ? Number(value) : Number.NaN;
    return page >= 1 && page <= pages ? page : undefined;
  };

  function close(slide = true): void {
    if (!shown) return;
    const { dom } = shown;
    shown = undefined;
    const hadFocus = dom.contains(document.activeElement);
    if (slide) slideOut(dom, host);
    else dom.remove();
    if (hadFocus && returnFocus?.isConnected) returnFocus.focus();
    returnFocus = undefined;
  }

  function build(pages: number): NonNullable<typeof shown> {
    for (const leaving of host.querySelectorAll(".page-card.is-closing")) leaving.remove();
    const dom = el("div", "floating-toolbar page-card");
    dom.setAttribute("role", "group");
    dom.setAttribute("aria-label", "Go to page");
    const box = el("div", "form-input page-card-field");
    const field = el("input", "page-card-input");
    field.inputMode = "numeric";
    field.autocomplete = "off";
    field.setAttribute("aria-label", "Page");
    box.append(field);
    const count = el("span", "page-card-count");
    const line = el("span", "floating-toolbar-line");
    line.setAttribute("aria-hidden", "true");
    const closeButton = el("button", "icon-button page-card-close");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.dataset.tooltip = "Close (Escape)";
    closeButton.addEventListener("mousedown", (event) => event.preventDefault());
    closeButton.addEventListener("click", () => close());
    dom.append(box, count, line, closeButton);
    const card = { dom, field, count, pages, typed: false };
    field.addEventListener("input", () => {
      card.typed = true;
      count.classList.toggle("is-invalid", field.value.trim() !== "" && pageIn(field.value, card.pages) === undefined);
    });
    field.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const page = pageIn(field.value, card.pages);
        count.classList.toggle("is-invalid", page === undefined);
        if (page === undefined) return;
        go(page);
        card.typed = false;
        field.select();
      }
    });
    host.append(dom);
    slideIn(dom);
    return card;
  }

  return {
    host,
    isOpen: () => shown !== undefined,
    open(page, pages) {
      if (!shown) {
        const active = document.activeElement;
        returnFocus = active instanceof HTMLElement ? active : undefined;
        shown = build(pages);
      }
      shown.pages = pages;
      shown.typed = false;
      shown.field.value = String(page);
      shown.count.textContent = `of ${pages}`;
      shown.count.classList.remove("is-invalid");
      shown.field.focus();
      shown.field.select();
    },
    // Selected again while it has focus, so the next number types over it.
    follow(page) {
      if (!shown || shown.typed) return;
      shown.field.value = String(page);
      shown.count.classList.remove("is-invalid");
      if (document.activeElement === shown.field) shown.field.select();
    },
    close,
  };
}

export function createPdfPane(deps: PdfPaneDeps): PdfPane {
  const store = new DisposableStore();
  const element = el("div", "editor-pdf");
  const stage = el("div", "editor-pdf-stage");
  const frame = el("iframe", "editor-pdf-frame");
  frame.title = "PDF";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = frameDocument();
  const message = el("p", "editor-pdf-message");
  message.hidden = true;
  stage.append(frame, message);

  element.append(stage);

  const details = createInspectorSection("PDF");
  details.body.className = "meta-rows";
  let rows = new Map<string, HTMLElement>();

  // The document the pane shows. Its bytes are kept, not transferred, so a
  // reloaded frame can be handed them again.
  let current: { path: string; bytes: ArrayBuffer } | undefined;
  let pages = 0;
  // The page PDF.js last said shows: 0 until it says, which can be after or
  // before the document says how many it has.
  let page = 0;
  let frameReady = false;
  // The zoom PDF.js last reported: its percent, and whether it fits the width.
  let zoom = { percent: 100, fit: true };
  // Session memory only: where the reader left each document.
  const locations = new Map<string, PdfLocation>();

  function command(data: Record<string, unknown>, transfer: Transferable[] = []): void {
    frame.contentWindow?.postMessage({ source: "pragma-host", ...data }, "*", transfer);
  }

  function showMessage(text: string | undefined): void {
    message.textContent = text ?? "";
    message.hidden = text === undefined;
  }

  function drawReadout(): void {
    if (pages > 0) deps.reportReadout(`${page || 1} of ${pages}`);
  }

  function resetView(): void {
    pages = 0;
    page = 0;
    pageCard.close(false);
    zoom = { percent: 100, fit: true };
    deps.reportReadout("");
  }

  // PDF.js's name for a zoom: a preset's, or a scale.
  const scaleOf = (value: PdfZoom) => (value === "fit" ? "page-width" : value / 100);

  function openCurrent(): void {
    if (!current || !frameReady) return;
    const data = current.bytes.slice(0);
    const scale = scaleOf(deps.zoom.get());
    command({ type: "open", data, location: locations.get(current.path), scale }, [data]);
  }

  // A Zoom pick is the device's: every PDF pane takes it, this one included,
  // as every screenplay takes its zoom. Picking the zoom already kept still
  // applies it, undoing a passing Ctrl+= in the frame.
  store.add(
    toDisposable(
      deps.zoom.subscribe((value) =>
        command(value === "fit" ? { type: "zoom", action: "fit" } : { type: "zoom", scale: scaleOf(value) }),
      ),
    ),
  );

  // Find runs in the frame, as PDF.js's own search: it has no regular
  // expressions, and its count comes in as it reads the pages.
  interface Search {
    query?: SearchQuery;
    count: FindCount;
    changed: () => void;
  }
  let searching: Search | undefined;

  function sendFind(again: boolean, previous = false): void {
    const query = searching?.query;
    if (!query?.valid) return;
    const { search, caseSensitive, wholeWord } = query;
    command({ type: "find", query: search, again, previous, caseSensitive, entireWord: wholeWord });
  }

  function frameFinder(changed: () => void): Finder {
    const live: Search = { count: NO_MATCHES, changed };
    searching = live;
    return {
      search(query) {
        live.query = query;
        live.count = query.valid ? { ...NO_MATCHES, pending: true } : NO_MATCHES;
        if (query.valid) sendFind(false);
        else command({ type: "findclose" });
      },
      count: () => live.count,
      // A new search starts from the page in view, and PDF.js brings each
      // match it picks into view itself.
      fromView: () => undefined,
      seek: () => undefined,
      step: (backward) => sendFind(true, backward),
      dispose() {
        if (searching === live) searching = undefined;
        command({ type: "findclose" });
      },
    };
  }

  const find = createPaneFind({
    finder: (_card, changed) => frameFinder(changed),
    offered: ["caseSensitive", "wholeWord"],
  });
  store.add({ dispose: () => find.dispose() });

  // Go to page's card sits left of Find's, so Find's stays where it was.
  const pageCard = createPageCard((target) => command({ type: "page", page: target }));
  const aside = el("div", "editor-pdf-aside");
  aside.append(pageCard.host, find.host);
  const themeWatch = new MutationObserver(() => command({ type: "theme", ...theme() }));
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  function onNotice(data: FrameRequest): void {
    switch (data.type) {
      case "ready":
        frameReady = false;
        deps.loadRuntime().then(
          (runtime) => command({ type: "init", ...runtime }),
          () => showMessage("The PDF viewer couldn't be loaded."),
        );
        command({ type: "theme", ...theme() });
        return;
      case "initialized":
        frameReady = true;
        openCurrent();
        return;
      case "loaded": {
        if (!current) return;
        pages = Number.isInteger(data.pages) ? (data.pages as number) : 0;
        drawReadout();
        // A search open while the document loaded reached no pages.
        sendFind(false);
        rows.get("Pages")?.replaceChildren(String(pages));
        rows.get("Title")?.replaceChildren(typeof data.title === "string" && data.title ? data.title : "None");
        rows.get("Author")?.replaceChildren(typeof data.author === "string" && data.author ? data.author : "None");
        return;
      }
      case "page":
        if (!Number.isInteger(data.page)) return;
        page = data.page as number;
        pageCard.follow(page);
        drawReadout();
        return;
      case "scale":
        if (typeof data.scale === "number")
          zoom = { percent: Math.round(data.scale * 100), fit: data.preset === "page-width" };
        return;
      case "location": {
        const location = asLocation(data.location);
        if (current && location) locations.set(current.path, location);
        return;
      }
      case "find": {
        if (!searching) return;
        const total = typeof data.total === "number" ? data.total : 0;
        const at = typeof data.current === "number" ? data.current : 0;
        // A count alone, as pages are read, leaves the search's state as it was.
        const pending = typeof data.state === "number" ? data.state === FIND_PENDING : searching.count.pending;
        searching.count = { total, current: at - 1, capped: false, pending };
        searching.changed();
        return;
      }
      case "find-shortcut":
        if (pages > 0) find.open(seedText(typeof data.selection === "string" ? data.selection : undefined));
        return;
      case "link": {
        const url = linkToOpen(data.url);
        if (url) deps.openLink(url);
        return;
      }
      case "key": {
        if (typeof data.key !== "string") return;
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: data.key,
            code: typeof data.code === "string" ? data.code : "",
            ctrlKey: data.ctrlKey === true,
            metaKey: data.metaKey === true,
            shiftKey: data.shiftKey === true,
            altKey: data.altKey === true,
            bubbles: true,
            cancelable: true,
          }),
        );
        return;
      }
      case "error":
        if (!current) return;
        showMessage(
          data.reason === "password"
            ? "This PDF is password-protected, which the viewer doesn't support yet."
            : data.reason === "unreadable"
              ? "This file couldn't be read as a PDF."
              : "The PDF viewer ran into a problem showing this file.",
        );
        return;
    }
  }

  store.add(
    dispatchFrameRequests({
      frame: () => frame,
      source: FRAME_SOURCE,
      handlers: {
        binary: (data) => deps.binaryAsset(String(data.kind), String(data.filename)),
      },
      onNotice,
    }),
  );

  function fillDetails(): void {
    details.body.replaceChildren();
    rows = new Map(["Pages", "Title", "Author"].map((label) => [label, appendMetaRow(details.body, label, "…")]));
    details.section.hidden = false;
  }

  return {
    kind: "pdf",
    element,
    toolbarAside: aside,
    inspector: details.section,
    async setInput(tab, ctx) {
      if (tab.kind !== "pdf") throw new Error(`the PDF pane can't show a "${tab.kind}" tab`);
      current = undefined;
      resetView();
      find.show(tab.path);
      showMessage(undefined);
      fillDetails();
      command({ type: "close" });

      const response = await deps.fetchFile(tab.path).catch(() => undefined);
      if (!ctx.isCurrent()) return;
      if (!response?.ok) {
        showMessage(
          response?.status === 404
            ? "This file isn't there any more. It may have been moved or deleted."
            : "This PDF couldn't be loaded.",
        );
        return;
      }
      const bytes = await response.arrayBuffer();
      if (!ctx.isCurrent()) return;
      current = { path: tab.path, bytes };
      openCurrent();
    },
    clearInput() {
      current = undefined;
      find.show(undefined);
      resetView();
      showMessage(undefined);
      command({ type: "close" });
      details.body.replaceChildren();
      details.section.hidden = true;
    },
    title: () => undefined, // the tab names it; no title bar
    pageZoom() {
      const fit: MenuItem = {
        label: "Fit to width",
        group: "fit",
        detail: zoom.fit ? `${zoom.percent}%` : undefined,
        checked: () => zoom.fit,
        run: () => deps.zoom.set("fit"),
      };
      const steps = zoomMenuItems({
        levels: PDF_ZOOM_LEVELS,
        get: () => (zoom.fit ? Number.NaN : zoom.percent),
        set: (percent) => deps.zoom.set(percent),
      });
      return [fit, ...steps];
    },
    canGoToPage: () => pages > 0,
    goToPage: () => pageCard.open(page || 1, pages),
    findable: () => (pages > 0 ? "find" : undefined),
    openFind: () => find.open(),
    hasTransient: () => pageCard.isOpen() || find.isOpen(),
    dismissTransient() {
      if (pageCard.isOpen()) pageCard.close();
      else find.close();
    },
    dispose() {
      themeWatch.disconnect();
      store.dispose();
      element.remove();
    },
  };
}
