// The PDF pane's frame script, inlined into a sandboxed frame by pdfPane.ts.
// Plain JS because it arrives as text: the frame's opaque origin and CSP
// reach no module graph, so PDF.js, its worker, the document's bytes and
// every data file the worker asks for come in over postMessage instead.
//
// A link in the document never navigates the frame or the app: the click is
// cancelled and the URL handed to the host, which decides where it opens.

const SOURCE = "pragma-pdf";
const HOST = "pragma-host";

function post(message, transfer) {
  window.parent.postMessage({ source: SOURCE, ...message }, "*", transfer ?? []);
}

// Requests answered by the host: the data files the worker needs.
let nextRequestId = 1;
const pending = new Map();
function call(type, payload) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++;
    pending.set(requestId, { resolve, reject });
    post({ type, requestId, ...payload });
  });
}

// getDocument's hook for CMaps, standard fonts and wasm, asked of the host
// rather than fetched — the frame can fetch nothing.
class HostBinaryData {
  fetch({ kind, filename }) {
    return call("binary", { kind, filename });
  }
}

const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));

// A classic worker that import()s PDF.js's worker module: Chromium refuses a
// module worker from a blob in an opaque-origin frame, but runs the same
// module through import(). The module wires itself to the worker's port and
// says "ready" once loaded; PDF.js gets the worker only then, since a message
// sent while the import is in flight would reach no listener and be lost.
function startWorker(source) {
  const moduleUrl = JSON.stringify(blobUrl(source));
  const worker = new Worker(blobUrl(`import(${moduleUrl}).catch((e) => postMessage({ failed: String(e) }));`));
  return new Promise((resolve, reject) => {
    worker.addEventListener(
      "message",
      (event) => (event.data?.failed ? reject(new Error(event.data.failed)) : resolve(worker)),
      { once: true },
    );
    worker.addEventListener("error", () => reject(new Error("The PDF worker failed to start")), { once: true });
  });
}

const container = document.getElementById("viewerContainer");
let pdfjs;
let viewer;
let eventBus;
let linkService;
let findController;
let loadingTask = null;
let openCount = 0;
let pendingLocation = null;
let pendingScale = "page-width";

async function init(runtime) {
  document.getElementById("pdfjs-css").textContent = runtime.css;
  pdfjs = await import(blobUrl(runtime.lib));
  const components = await import(blobUrl(runtime.viewer));
  pdfjs.GlobalWorkerOptions.workerPort = await startWorker(runtime.worker);

  eventBus = new components.EventBus();
  linkService = new components.PDFLinkService({
    eventBus,
    externalLinkTarget: components.LinkTarget.BLANK,
    externalLinkRel: "noopener noreferrer nofollow",
  });
  findController = new components.PDFFindController({ eventBus, linkService });
  viewer = new components.PDFViewer({
    container,
    eventBus,
    linkService,
    findController,
    annotationMode: pdfjs.AnnotationMode.ENABLE,
  });
  linkService.setViewer(viewer);

  // Fit to width follows the frame's width. PDF.js's components keep a preset
  // scale as first worked out; its own viewer works it out again on every
  // resize, as this does. Nothing is fitted to a frame with no width.
  new ResizeObserver(() => {
    if (!viewer.pdfDocument || container.clientWidth === 0) return;
    if (viewer.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
    viewer.update();
  }).observe(container);

  // "pagechanging" fires only on a change, so the page a document opens on
  // is reported here.
  eventBus.on("pagesinit", () => {
    const location = pendingLocation;
    pendingLocation = null;
    viewer.currentScaleValue = pendingScale;
    if (location) {
      viewer.scrollPageIntoView({
        pageNumber: location.pageNumber,
        destArray: [null, { name: "XYZ" }, location.left, location.top, null],
        allowNegativeOffset: true,
      });
    }
    post({ type: "page", page: viewer.currentPageNumber });
  });
  eventBus.on("pagechanging", ({ pageNumber }) => post({ type: "page", page: pageNumber }));
  eventBus.on("scalechanging", ({ scale, presetValue }) => post({ type: "scale", scale, preset: presetValue }));
  eventBus.on("updateviewarea", ({ location }) => {
    const { pageNumber, top, left } = location;
    post({ type: "location", location: { pageNumber, top, left } });
  });
  eventBus.on("updatefindmatchescount", ({ matchesCount }) => post({ type: "find", ...matchesCount }));
  eventBus.on("updatefindcontrolstate", ({ state, matchesCount }) => post({ type: "find", state, ...matchesCount }));
  post({ type: "initialized" });
}

async function close() {
  const task = loadingTask;
  loadingTask = null;
  if (viewer) {
    viewer.setDocument(null);
    linkService.setDocument(null);
    findController.setDocument(null);
  }
  if (task) await task.destroy();
}

// A document opens at the device's zoom: a preset's name, or a scale.
async function open({ data, location, scale }) {
  const opened = ++openCount;
  await close();
  if (opened !== openCount) return;
  // No standardFontDataUrl: given one, PDF.js adds a url() fallback to each
  // system font's @font-face, a fetch the CSP refuses. The Symbol and
  // Dingbats data it needs regardless still comes through HostBinaryData.
  const task = pdfjs.getDocument({
    data,
    BinaryDataFactory: HostBinaryData,
    useWorkerFetch: false,
    cMapUrl: "pragma/cmaps/",
    wasmUrl: "pragma/wasm/",
  });
  loadingTask = task;
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (opened === openCount) {
      post({ type: "error", reason: error?.name === "PasswordException" ? "password" : "unreadable" });
    }
    return;
  }
  if (opened !== openCount) return;
  pendingLocation = location ?? null;
  pendingScale = scale === "page-width" || (typeof scale === "number" && scale > 0) ? scale : "page-width";
  viewer.setDocument(pdf);
  linkService.setDocument(pdf, null);
  findController.setDocument(pdf);
  const { info } = await pdf.getMetadata().catch(() => ({ info: {} }));
  if (opened !== openCount) return;
  post({ type: "loaded", pages: pdf.numPages, title: info?.Title || "", author: info?.Author || "" });
}

function zoom(action, origin) {
  if (!viewer?.pdfDocument) return;
  if (action === "fit") viewer.currentScaleValue = "page-width";
  else viewer.updateScale({ steps: action === "in" ? 1 : -1, origin });
}

function find({ query, again, previous, caseSensitive, entireWord }) {
  if (!eventBus) return;
  eventBus.dispatch("find", {
    source: null,
    type: again ? "again" : "",
    query,
    caseSensitive: caseSensitive === true,
    entireWord: entireWord === true,
    highlightAll: true,
    findPrevious: previous === true,
    matchDiacritics: false,
  });
}

// The host's tokens the frame's stylesheets read, by their own names.
function setTokens(tokens) {
  if (!tokens || typeof tokens !== "object") return;
  const root = document.documentElement.style;
  for (const [name, value] of Object.entries(tokens)) {
    if (name.startsWith("--") && typeof value === "string") root.setProperty(name, value);
  }
}

const commands = {
  init,
  open,
  close,
  zoom: ({ action, scale }) => {
    if (typeof scale !== "number") zoom(action);
    else if (viewer?.pdfDocument) viewer.currentScale = scale;
  },
  page: ({ page }) => {
    if (viewer?.pdfDocument && Number.isInteger(page)) viewer.currentPageNumber = page;
  },
  find,
  findclose: () => eventBus?.dispatch("findbarclose", { source: null }),
  theme: ({ scheme, tokens }) => {
    document.documentElement.style.colorScheme = scheme;
    setTokens(tokens);
  },
};

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.source !== HOST) return;
  if (typeof data.requestId === "number") {
    const entry = pending.get(data.requestId);
    if (!entry) return;
    pending.delete(data.requestId);
    if (data.error) entry.reject(new Error(data.error));
    else entry.resolve(data.result);
    return;
  }
  const command = Object.hasOwn(commands, data.type) ? commands[data.type] : undefined;
  if (!command) return;
  Promise.resolve(command(data)).catch((error) => {
    post({ type: "error", reason: "viewer", message: error?.message ?? String(error) });
  });
});

// An internal destination's href is a fragment, which PDF.js scrolls to
// itself; anything else is the outside world, and goes to the host.
function onLinkActivation(event) {
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || (anchor.getAttribute("href") ?? "").startsWith("#")) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (event.type === "click" || event.button === 1) post({ type: "link", url: anchor.href });
}
document.addEventListener("click", onLinkActivation, true);
document.addEventListener("auxclick", onLinkActivation, true);

// Copy and select-all stay with the frame's own selection; find and zoom are
// the pane's. Every other key the app lets a person bind goes up to be
// replayed where its shortcuts listen: one with Ctrl, Alt or Meta held, or a
// function key, as keybindings.ts's rule has it.
const FRAME_KEYS = new Set(["a", "c", "x", "z", "y"]);
document.addEventListener(
  "keydown",
  (event) => {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const chord = event.ctrlKey || event.metaKey;
    if (chord && key === "f") {
      event.preventDefault();
      // The selection, to start the search with: the host can't read it.
      post({ type: "find-shortcut", selection: String(window.getSelection() ?? "") });
    } else if (chord && (key === "=" || key === "+" || key === "-" || key === "0")) {
      event.preventDefault();
      zoom(key === "0" ? "fit" : key === "-" ? "out" : "in");
    } else if (key === "Escape" || /^F\d{1,2}$/.test(key) || ((chord || event.altKey) && !FRAME_KEYS.has(key))) {
      if (key !== "Escape") event.preventDefault();
      const { code, ctrlKey, metaKey, shiftKey, altKey } = event;
      post({ type: "key", key: event.key, code, ctrlKey, metaKey, shiftKey, altKey });
    }
  },
  true,
);

// Pinch and Ctrl+wheel zoom the document, not the whole app.
container.addEventListener(
  "wheel",
  (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    zoom(event.deltaY < 0 ? "in" : "out", [event.clientX, event.clientY]);
  },
  { passive: false },
);

post({ type: "ready" });
