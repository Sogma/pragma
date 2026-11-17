// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppletFileResponse, FileResponse } from "../../../../web/core/apiClient.ts";
import { appletPane, createAppletPane, isAppletPane } from "../../../../web/view/panes/appletPane.ts";

function file(overrides: Partial<AppletFileResponse> = {}): AppletFileResponse {
  return {
    kind: "applet",
    path: "tools/hello.applet.html",
    revision: "r1",
    manifest: { version: "1.0", meta: { name: "Hello" } },
    html: "<html><body>hi</body></html>",
    contentHash: "h1",
    imports: [],
    ...overrides,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

function setup(onDisk: FileResponse = file()) {
  const deps = {
    loadFile: vi.fn(async (_path: string) => onDisk),
    saveQueue: { noteRevision: vi.fn(), flush: vi.fn(async (_path?: string) => true) },
    injectRuntime: vi.fn((html: string) => `<!--rt-->${html}`),
    onRendered: vi.fn(),
  };
  const pane = createAppletPane(deps);
  document.body.append(pane.element);
  return { pane, deps };
}

const current = { isCurrent: () => true };
const tab = { kind: "applet" as const, path: "tools/hello.applet.html" };

function frameOf(pane: { element: HTMLElement }): HTMLIFrameElement {
  const frame = pane.element.querySelector("iframe");
  if (!frame?.contentWindow) throw new Error("no frame");
  return frame;
}

// Posts as the applet's own frame would, and captures what the host posts back.
function connect(pane: { element: HTMLElement }) {
  const frame = frameOf(pane);
  const replies = vi.fn();
  (frame.contentWindow as Window).postMessage = replies as never;
  return {
    send: (data: Record<string, unknown>, source: MessageEventSource | null = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent("message", { source, data: { source: "pragma-applet", ...data } })),
    replies,
  };
}

describe("appletPane", () => {
  it("mounts the applet in a fresh sandboxed frame and names itself from the manifest", async () => {
    const { pane, deps } = setup();
    const before = frameOf(pane);
    await pane.setInput(tab, current);

    const frame = frameOf(pane);
    expect(frame).not.toBe(before);
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toBe("<!--rt--><html><body>hi</body></html>");
    expect(pane.title()).toBe("Hello");
    expect(pane.titleHost?.()).toBe(pane.element.querySelector(".editor-applet-scroll"));
    expect(deps.onRendered).toHaveBeenCalledTimes(1);
    expect(isAppletPane(pane)).toBe(true);
    expect(appletPane(deps).kind).toBe("applet");
  });

  it("sizes the frame to the height it reports, and answers no other message", async () => {
    const { pane } = setup();
    await pane.setInput(tab, current);
    const { send, replies } = connect(pane);
    send({ type: "resize", height: 300.4 });
    expect(frameOf(pane).style.height).toBe("300px");

    send({ type: "resize", height: 50 }, window);
    expect(frameOf(pane).style.height).toBe("300px");

    send({ type: "read", requestId: 1, targetPath: "notes/a.md" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replies).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 1, error: "Unknown request type: read" }),
      "*",
    );
  });

  it("shows why it can't run an Applet that declares capabilities, or one whose import can't be read", async () => {
    const { pane, deps } = setup();
    const notice = () => pane.element.querySelector<HTMLElement>(".editor-applet-notice") as HTMLElement;
    expect(notice().hidden).toBe(true);

    await pane.setInput(tab, current, file({ manifest: { version: "1.0", declaresCapabilities: true } }));
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toMatch(/declares capabilities.*Rebuild it as a Flow/);
    expect(frameOf(pane).getAttribute("srcdoc")).toBeNull();

    await pane.setInput(tab, current, file({ importError: 'Import "three" isn\'t there.' }));
    expect(notice().textContent).toBe('Import "three" isn\'t there.');
    expect(frameOf(pane).getAttribute("srcdoc")).toBeNull();
    expect(deps.onRendered).toHaveBeenCalledTimes(2);

    await pane.setInput(tab, current, file());
    expect(notice().hidden).toBe(true);
    expect(frameOf(pane).getAttribute("srcdoc")).toBe("<!--rt--><html><body>hi</body></html>");
  });

  it("records the revision each mount runs, refused or not, for outside edits to be checked against", async () => {
    const { pane, deps } = setup();
    const { noteRevision } = deps.saveQueue;
    await pane.setInput(tab, { isCurrent: () => false });
    expect(noteRevision).not.toHaveBeenCalled();

    await pane.setInput(tab, current);
    expect(noteRevision).toHaveBeenLastCalledWith("tools/hello.applet.html", "r1");

    await pane.setInput(tab, current, file({ revision: "r2" }));
    expect(noteRevision).toHaveBeenLastCalledWith("tools/hello.applet.html", "r2");

    await pane.setInput(tab, current, file({ revision: "r3", importError: 'Import "three" isn\'t there.' }));
    expect(noteRevision).toHaveBeenLastCalledWith("tools/hello.applet.html", "r3");
    expect(noteRevision).toHaveBeenCalledTimes(3);
  });

  it("Reload saves the file first, then runs it again in a fresh frame", async () => {
    const { pane, deps } = setup();
    await pane.setInput(tab, current);
    const before = frameOf(pane);
    deps.loadFile.mockResolvedValue(file({ revision: "r2", html: "<html><body>edited</body></html>" }));

    expect(pane.toolbar?.getAttribute("aria-label")).toBe("Reload");
    expect(pane.toolbar?.textContent).toBe("");
    (pane.toolbar as HTMLButtonElement).click();
    await vi.waitFor(() => expect(frameOf(pane)).not.toBe(before));

    expect(deps.saveQueue.flush).toHaveBeenCalledWith("tools/hello.applet.html");
    const [flushed] = deps.saveQueue.flush.mock.invocationCallOrder;
    expect(flushed).toBeLessThan(deps.loadFile.mock.invocationCallOrder[1]);
    expect(frameOf(pane).getAttribute("srcdoc")).toBe("<!--rt--><html><body>edited</body></html>");
    expect(deps.saveQueue.noteRevision).toHaveBeenLastCalledWith("tools/hello.applet.html", "r2");
  });

  it("Reload runs nothing it couldn't save or read first, and says why", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { pane, deps } = setup();
    await pane.setInput(tab, current);
    const before = frameOf(pane);
    const reload = pane.toolbar as HTMLButtonElement;

    deps.saveQueue.flush.mockResolvedValueOnce(false);
    reload.click();
    await vi.waitFor(() =>
      expect(alert).toHaveBeenCalledWith("Couldn't save before reloading. The status bar says why."),
    );
    expect(deps.loadFile).toHaveBeenCalledTimes(1);

    deps.loadFile.mockRejectedValueOnce(new Error('No file at "tools/hello.applet.html"'));
    reload.click();
    await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('No file at "tools/hello.applet.html"'));
    expect(frameOf(pane)).toBe(before);
    alert.mockRestore();
  });

  it("drops a Reload still loading when the pane is given another file", async () => {
    const { pane, deps } = setup();
    await pane.setInput(tab, current);
    let finish: (stale: FileResponse) => void = () => {};
    deps.loadFile.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    (pane.toolbar as HTMLButtonElement).click();
    await vi.waitFor(() => expect(deps.loadFile).toHaveBeenCalledTimes(2));

    const other = file({ path: "tools/other.applet.html", html: "<html><body>other</body></html>" });
    await pane.setInput({ kind: "applet", path: "tools/other.applet.html" }, current, other);
    finish(file({ revision: "r2", html: "<html><body>stale</body></html>" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(frameOf(pane).getAttribute("srcdoc")).toBe("<!--rt--><html><body>other</body></html>");
  });

  it("clearInput blanks the frame and forgets the title", async () => {
    const { pane, deps } = setup();
    await pane.setInput(tab, current, file());
    expect(deps.loadFile).not.toHaveBeenCalled();

    pane.clearInput();

    expect(frameOf(pane).getAttribute("srcdoc")).toBeNull();
    expect(pane.title()).toBeUndefined();
  });

  it("shows the manifest's description in its Info-tab section, hidden without one or once cleared", async () => {
    const { pane } = setup();
    expect(pane.inspector?.hidden).toBe(true);

    await pane.setInput(tab, current, file());
    const rows = () => [...(pane.inspector?.querySelectorAll(".meta-row") ?? [])].map((row) => row.textContent);
    expect(pane.inspector?.hidden).toBe(true);
    expect(rows()).toEqual([]);

    const described = file();
    described.manifest.meta = { name: "Hello", description: "Says hi" };
    await pane.setInput(tab, current, described);
    expect(pane.inspector?.hidden).toBe(false);
    expect(rows()).toEqual(["DescriptionSays hi"]);

    pane.clearInput();
    expect(pane.inspector?.hidden).toBe(true);
    expect(rows()).toEqual([]);
  });
});
