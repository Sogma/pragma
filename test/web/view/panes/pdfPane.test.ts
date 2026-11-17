// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommands } from "../../../../web/services/commands.ts";
import { COMMAND_PALETTE, createMenus } from "../../../../web/services/menus.ts";
import type { PdfZoom } from "../../../../web/services/settings.ts";
import { createPdfPane, linkToOpen, type PdfPaneDeps, pdfPane } from "../../../../web/view/panes/pdfPane.ts";
import { memorySetting } from "../../support/editorLayout.ts";

const RUNTIME = { lib: "lib-source", viewer: "viewer-source", worker: "worker-source", css: "viewer-css" };
const PDF_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d];

const fileResponse = (status = 200) =>
  ({
    ok: status === 200,
    status,
    arrayBuffer: async () => new Uint8Array(PDF_BYTES).buffer,
  }) as Response;

function setup(overrides: Partial<PdfPaneDeps> = {}) {
  const deps: PdfPaneDeps = {
    loadRuntime: vi.fn(async () => RUNTIME),
    binaryAsset: vi.fn(async () => new Uint8Array([1, 2, 3])),
    fetchFile: vi.fn(async () => fileResponse()),
    openLink: vi.fn(),
    reportReadout: vi.fn(),
    zoom: memorySetting<PdfZoom>("fit"),
    ...overrides,
  };
  const pane = createPdfPane(deps);
  document.body.append(pane.element);
  const frame = pane.element.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame");
  // What the pane posts into the frame: [message, targetOrigin, transfer].
  const posted = vi.fn();
  (frame.contentWindow as Window).postMessage = posted as never;
  const send = (data: Record<string, unknown>, source: Window | null = frame.contentWindow) =>
    window.dispatchEvent(new MessageEvent("message", { source, data: { source: "pragma-pdf", ...data } }));
  const sent = (type: string) => posted.mock.calls.filter(([message]) => message.type === type);
  return { pane, deps, frame, send, sent, posted };
}

const current = { isCurrent: () => true };
const tab = { kind: "pdf" as const, path: "refs/paper.pdf" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// The frame announces itself, takes the runtime, and says it's ready.
async function boot(send: (data: Record<string, unknown>) => void): Promise<void> {
  send({ type: "ready" });
  await tick();
  send({ type: "initialized" });
}

describe("the PDF pane's frame", () => {
  it("has an opaque origin and a CSP that lets it fetch nothing", () => {
    const { frame } = setup();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("default-src 'none'");
    expect(frame.srcdoc).toContain("worker-src blob:");
    expect(frame.srcdoc).not.toMatch(/connect-src|allow-same-origin|allow-popups|allow-top-navigation/);
  });

  it("draws the app's own scrollbars, handed the token they read with the theme", async () => {
    const { frame, send, sent } = setup();
    expect(frame.srcdoc).toContain("::-webkit-scrollbar-thumb");
    expect(frame.srcdoc).toContain("--scrollbar-thumb-mix");
    send({ type: "ready" });
    await tick();
    expect(Object.keys(sent("theme")[0][0].tokens)).toContain("--border-input");
  });

  // The frame reloads whenever the pane's element leaves the page, so every
  // announcement gets the runtime and the open document again — the bytes
  // are a copy each time, since a transferred buffer is gone from the pane.
  it("replays the runtime and the open document each time the frame announces itself", async () => {
    const { pane, deps, send, sent } = setup();
    await pane.setInput(tab, current);
    expect(deps.fetchFile).toHaveBeenCalledWith("refs/paper.pdf");

    await boot(send);
    expect(sent("init")[0][0]).toMatchObject({ source: "pragma-host", ...RUNTIME });
    const [first] = sent("open");
    expect([...new Uint8Array(first[0].data)]).toEqual(PDF_BYTES);
    expect(first[2]).toEqual([first[0].data]);

    await boot(send);
    expect(sent("init")).toHaveLength(2);
    expect([...new Uint8Array(sent("open")[1][0].data)]).toEqual(PDF_BYTES);
  });

  it("hands back where the reader was when the document opens again, at the device's zoom", async () => {
    const { pane, send, sent } = setup();
    await pane.setInput(tab, current);
    await boot(send);
    expect(sent("open").at(-1)?.[0].scale).toBe("page-width");
    const location = { pageNumber: 3, top: 412, left: 0 };
    send({ type: "location", location });

    pane.clearInput();
    await pane.setInput(tab, current);
    expect(sent("open").at(-1)?.[0].location).toEqual(location);
  });

  it("opens every PDF at the zoom this device keeps, and a pick reaches every PDF pane", async () => {
    const zoom = memorySetting<PdfZoom>(150);
    const one = setup({ zoom });
    const other = setup({ zoom });
    await one.pane.setInput(tab, current);
    await boot(one.send);
    expect(one.sent("open").at(-1)?.[0].scale).toBe(1.5);

    zoom.set("fit");
    expect(one.sent("zoom").at(-1)?.[0]).toMatchObject({ action: "fit" });
    expect(other.sent("zoom").at(-1)?.[0]).toMatchObject({ action: "fit" });
  });

  it("answers the worker's data-file requests, and nothing from another window", async () => {
    const { deps, send, posted } = setup();
    send({ type: "binary", requestId: 7, kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" });
    await tick();
    expect(deps.binaryAsset).toHaveBeenCalledWith("cMapUrl", "UniJIS-UCS2-H.bcmap");
    expect(posted).toHaveBeenCalledWith(
      { source: "pragma-host", requestId: 7, result: new Uint8Array([1, 2, 3]), error: undefined },
      "*",
    );

    send({ type: "link", url: "https://example.com/" }, window);
    expect(deps.openLink).not.toHaveBeenCalled();
  });

  it("opens the web and mail links a reader follows, and no other kind", () => {
    const { deps, send } = setup();
    send({ type: "link", url: "https://example.com/paper" });
    send({ type: "link", url: "javascript:alert(1)" });
    send({ type: "link", url: "file:///etc/passwd" });
    expect(deps.openLink).toHaveBeenCalledTimes(1);
    expect(deps.openLink).toHaveBeenCalledWith("https://example.com/paper");
    expect(linkToOpen("mailto:someone@example.com")).toBe("mailto:someone@example.com");
    expect(linkToOpen("not a url")).toBeUndefined();
  });
});

describe("the PDF pane", () => {
  it("fills the floating toolbar, the status bar and the Info tab from the open document", async () => {
    const { pane, deps, send } = setup();
    await pane.setInput(tab, current);
    send({ type: "loaded", pages: 12, title: "On Paper", author: "" });
    send({ type: "page", page: 4 });
    send({ type: "scale", scale: 1.25 });

    // Page and zoom are the ⋮ menu's, so the toolbar holds only ⋮.
    expect(pane.toolbar).toBeUndefined();
    expect(deps.reportReadout).toHaveBeenLastCalledWith("4 of 12");
    const rows = [...(pane.inspector?.querySelectorAll(".meta-row") ?? [])].map((row) => row.textContent);
    expect(rows).toEqual(["Pages12", "TitleOn Paper", "AuthorNone"]);

    send({ type: "loaded", pages: 1, title: "", author: "" });
    send({ type: "page", page: 1 });
    expect(deps.reportReadout).toHaveBeenLastCalledWith("1 of 1");
  });

  it("says when the file has gone", async () => {
    const { pane, sent } = setup({ fetchFile: vi.fn(async () => fileResponse(404)) });
    await pane.setInput(tab, current);
    const message = pane.element.querySelector<HTMLElement>(".editor-pdf-message");
    expect(message?.hidden).toBe(false);
    expect(message?.textContent).toContain("isn't there any more");
    expect(sent("open")).toHaveLength(0);
  });

  it("says when PDF.js can't read the file, or it needs a password", async () => {
    const { pane, send } = setup();
    await pane.setInput(tab, current);
    const message = pane.element.querySelector<HTMLElement>(".editor-pdf-message");
    send({ type: "error", reason: "unreadable" });
    expect(message?.textContent).toContain("couldn't be read as a PDF");
    send({ type: "error", reason: "password" });
    expect(message?.textContent).toContain("password-protected");
  });

  // Focus inside the frame would otherwise swallow every app shortcut.
  it("replays a shortcut pressed in the frame where the app's keybindings listen", () => {
    const { send } = setup();
    const heard = vi.fn();
    document.addEventListener("keydown", heard);
    send({ type: "key", key: "p", code: "KeyP", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false });
    document.removeEventListener("keydown", heard);
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0][0]).toMatchObject({ key: "p", ctrlKey: true });
  });

  it("refuses any other kind of tab", async () => {
    const { pane } = setup();
    await expect(pane.setInput({ kind: "image", path: "a.png" }, current)).rejects.toThrow(/can't show/);
  });
});

// Find is the editor's card, driving PDF.js's own search in the frame.
describe("the PDF pane's find", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  async function opened() {
    const context = setup();
    await context.pane.setInput(tab, current);
    await boot(context.send);
    context.send({ type: "loaded", pages: 12, title: "", author: "" });
    const aside = context.pane.toolbarAside;
    if (!aside) throw new Error("the PDF pane has no toolbar aside");
    document.body.append(aside);
    const field = () => aside.querySelector<HTMLInputElement>(".find-card:not(.is-closing) .find-card-input");
    const count = () => aside.querySelector(".find-card:not(.is-closing) .find-card-count")?.textContent;
    const type = (value: string) => {
      const input = field();
      if (!input) throw new Error("the card isn't open");
      input.value = value;
      input.dispatchEvent(new Event("input"));
    };
    const press = (key: string, init: KeyboardEventInit = {}) =>
      field()?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    return { ...context, aside, field, count, type, press };
  }

  it("offers Find once a document is open, with Match case and whole word but no regular expression", async () => {
    const empty = setup();
    expect(empty.pane.findable?.()).toBeUndefined();

    const { pane, aside } = await opened();
    expect(pane.findable?.()).toBe("find");
    pane.openFind?.(false);
    expect(aside.querySelector(".find-card-case")).not.toBeNull();
    expect(aside.querySelector(".find-card-word")).not.toBeNull();
    expect(aside.querySelector(".find-card-regex")).toBeNull();
    expect(aside.querySelector<HTMLElement>(".find-card-reveal")?.hidden).toBe(true);
  });

  it("searches in the frame as Find changes, and counts what the frame reports", async () => {
    const { pane, send, sent, type, press, count } = await opened();
    pane.openFind?.(false);
    type("paper");
    expect(sent("find").at(-1)?.[0]).toMatchObject({ query: "paper", again: false, caseSensitive: false });
    expect(count()).toBe("");

    send({ type: "find", state: 3, current: 0, total: 0 });
    expect(count()).toBe("");
    send({ type: "find", current: 1, total: 3 });
    expect(count()).toBe("1 of 3");

    press("Enter");
    expect(sent("find").at(-1)?.[0]).toMatchObject({ query: "paper", again: true, previous: false });
    press("Enter", { shiftKey: true });
    expect(sent("find").at(-1)?.[0]).toMatchObject({ again: true, previous: true });

    press("c", { altKey: true });
    expect(sent("find").at(-1)?.[0]).toMatchObject({ again: false, caseSensitive: true, entireWord: false });
    press("r", { altKey: true });
    expect(sent("find").at(-1)?.[0]).toMatchObject({ caseSensitive: true });

    type("zebra");
    send({ type: "find", state: 1, current: 0, total: 0 });
    expect(count()).toBe("No matches");
  });

  it("opens from Ctrl+F in the frame with the text selected there, and closes on Escape", async () => {
    const { pane, send, sent, field, press } = await opened();
    send({ type: "find-shortcut", selection: "On Paper" });
    expect(field()?.value).toBe("On Paper");
    expect(document.activeElement).toBe(field());
    expect(sent("find").at(-1)?.[0]).toMatchObject({ query: "On Paper" });

    press("Escape");
    expect(pane.hasTransient?.()).toBe(false);
    expect(sent("findclose").length).toBeGreaterThan(0);
  });

  it("searches again once a document opens under an open card", async () => {
    const { pane, send, sent, type } = await opened();
    pane.openFind?.(false);
    type("paper");
    const before = sent("find").length;
    send({ type: "loaded", pages: 12, title: "", author: "" });
    expect(sent("find")).toHaveLength(before + 1);
  });
});

describe("the PDF pane's zoom", () => {
  it("is the ⋮ menu's Zoom, as a screenplay's is: Fit to width, then the steps, what shows checked", async () => {
    const commands = createCommands();
    const menus = createMenus(commands);
    pdfPane(commands, menus);
    const { pane, deps, send, sent } = setup();
    await pane.setInput(tab, current);
    const context = { tab, pane };
    const pageZoom = () =>
      menus.resolve("editor.toolbar", context).find((item) => item.label === "Zoom")?.submenu ?? [];

    send({ type: "scale", scale: 0.89, preset: "page-width" });
    expect(pageZoom().map((row) => [row.label, row.checked, row.detail])).toEqual([
      ["Fit to width", true, "89%"],
      ...["50%", "75%", "100%", "125%", "150%", "200%", "300%", "400%"].map((label) => [label, false, undefined]),
    ]);

    await pageZoom()
      .find((row) => row.label === "125%")
      ?.run?.(context, undefined);
    expect(sent("zoom").at(-1)?.[0]).toMatchObject({ scale: 1.25 });
    expect(deps.zoom.get()).toBe(125);
    send({ type: "scale", scale: 1.25 });
    expect(
      pageZoom()
        .filter((row) => row.checked)
        .map((row) => row.label),
    ).toEqual(["125%"]);

    await pageZoom()[0].run?.(context, undefined);
    expect(sent("zoom").at(-1)?.[0]).toMatchObject({ action: "fit" });
    expect(deps.zoom.get()).toBe("fit");
    expect(menus.resolve("editor.toolbar", { tab: { kind: "image", path: "a.png" }, pane: undefined })).toEqual([]);
  });
});

// Go to page: a card in Find's look and place, from ⋮ or the palette.
describe("the PDF pane's Go to page", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  async function opened() {
    const commands = createCommands();
    const menus = createMenus(commands);
    pdfPane(commands, menus);
    const context = setup();
    const { pane, send } = context;
    const fresh = { tab, pane };
    const offeredFresh = commands.isEnabled("pdf.goToPage", fresh);
    await pane.setInput(tab, current);
    await boot(send);
    send({ type: "loaded", pages: 106, title: "", author: "" });
    send({ type: "page", page: 4 });
    const aside = pane.toolbarAside;
    if (!aside) throw new Error("the PDF pane has no toolbar aside");
    document.body.append(aside);
    const card = () => aside.querySelector<HTMLElement>(".page-card:not(.is-closing)");
    const field = () => {
      const input = card()?.querySelector<HTMLInputElement>(".page-card-input");
      if (!input) throw new Error("the card isn't open");
      return input;
    };
    const type = (value: string) => {
      field().value = value;
      field().dispatchEvent(new Event("input"));
    };
    const press = (key: string) =>
      field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    const goToPage = () => commands.run("pdf.goToPage", { tab, pane });
    return { ...context, commands, menus, aside, card, field, type, press, goToPage, offeredFresh };
  }

  it("is in ⋮ before Zoom and in the palette once a document is open", async () => {
    const { menus, pane, offeredFresh } = await opened();
    expect(offeredFresh).toBe(false);
    const labels = menus.resolve("editor.toolbar", { tab, pane }).map((item) => item.label);
    expect(labels).toEqual(["Go to page…", "Zoom"]);
    expect(menus.resolve(COMMAND_PALETTE, { tab, pane }).map((item) => item.label)).toContain("PDF: Go to page…");
  });

  it("opens a card in Find's place with the page selected, out of the document's count", async () => {
    const { card, field, goToPage } = await opened();
    await goToPage();
    expect(card()?.getAttribute("aria-label")).toBe("Go to page");
    expect(field().value).toBe("4");
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 1]);
    expect(document.activeElement).toBe(field());
    expect(card()?.querySelector(".page-card-count")?.textContent).toBe("of 106");
  });

  it("goes to a page on Enter and stays, the page selected, and marks a page the document hasn't", async () => {
    const { card, field, type, press, sent, pane, goToPage } = await opened();
    await goToPage();
    type("200");
    expect(card()?.querySelector(".page-card-count")?.classList.contains("is-invalid")).toBe(true);
    press("Enter");
    expect(sent("page")).toHaveLength(0);
    expect(pane.hasTransient?.()).toBe(true);

    type("17");
    expect(card()?.querySelector(".page-card-count")?.classList.contains("is-invalid")).toBe(false);
    press("Enter");
    expect(sent("page").at(-1)?.[0]).toMatchObject({ page: 17 });
    expect(card()).not.toBeNull();
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 2]);
  });

  it("follows the page showing, selected for the next, unless a page typed waits for Enter", async () => {
    const { send, field, type, goToPage } = await opened();
    await goToPage();
    send({ type: "page", page: 9 });
    expect(field().value).toBe("9");
    expect([field().selectionStart, field().selectionEnd]).toEqual([0, 1]);

    type("3");
    send({ type: "page", page: 10 });
    expect(field().value).toBe("3");
  });

  it("sits left of Find's card, which keeps its search, and closes first on Escape", async () => {
    const { aside, pane, sent, press, goToPage } = await opened();
    pane.openFind?.(false);
    const closes = sent("findclose").length;
    await goToPage();
    const cards = [...aside.querySelectorAll(".page-card, .find-card")].map((each) => each.className);
    expect(cards).toEqual(["floating-toolbar page-card is-opening", "floating-toolbar find-card is-opening"]);
    expect(sent("findclose")).toHaveLength(closes);

    press("Escape");
    expect(aside.querySelector(".page-card:not(.is-closing)")).toBeNull();
    expect(pane.hasTransient?.()).toBe(true);
    pane.dismissTransient?.();
    expect(pane.hasTransient?.()).toBe(false);
  });
});
