// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { localDayAfter, parseLocalDay } from "../../../src/protocol/localDay.ts";
import {
  type BrokerSubject,
  capabilityPrompt,
  createCapabilityBroker,
  dispatchFrameRequests,
} from "../../../web/services/capabilityBroker.ts";
import { type CommandContext, createCommands } from "../../../web/services/commands.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";
import { createMenus } from "../../../web/services/menus.ts";
import { createContextMenu } from "../../../web/view/contextMenu.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.replaceChildren();
});

function subjectOf(overrides: Partial<BrokerSubject> = {}): BrokerSubject {
  return {
    kind: "flow",
    path: "a.flow.html",
    name: "Hello",
    capabilities: () => [
      { key: "readFile:n.md", type: "readFile", path: "n.md", description: "needs it" },
      { key: "generateText", type: "generateText" },
    ],
    grantedCapabilities: new Set(),
    ...overrides,
  };
}

function setup() {
  const commands = createCommands();
  const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };
  const deps = {
    dialog: createDialogService(),
    contextMenu: createContextMenu({
      commands,
      menus: createMenus(commands),
      keybindings: createKeybindings(commands, { mac: false }),
      context: () => context,
    }),
    grant: vi.fn(async () => undefined),
    revoke: vi.fn(async () => undefined),
  };
  const host = document.createElement("div");
  document.body.append(host);
  return { broker: createCapabilityBroker(deps), deps, host };
}

// An element's text, each line break in it as a newline.
function lines(element: Element | null | undefined): string | undefined {
  if (!element) return undefined;
  const copy = element.cloneNode(true) as Element;
  for (const br of copy.querySelectorAll("br")) br.replaceWith("\n");
  return copy.textContent ?? undefined;
}

const panel = () => document.querySelector<HTMLElement>(".dialog-panel");
const message = () => lines(panel()?.querySelector(".dialog-message"));

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

describe("capabilityPrompt", () => {
  // A Flow asking, by its name.
  const flow = (name: string) => ({ name, path: "tools/a.flow.html" });
  const text = (name: string, capability: Parameters<typeof capabilityPrompt>[1]) =>
    lines(capabilityPrompt(flow(name), capability).message[0]);

  it("names the document in its title after its icon, then the action, the path below it and the description", () => {
    const prompt = capabilityPrompt(flow("Hello"), {
      key: "k",
      type: "readFile",
      path: "n.md",
      description: "needs it",
    });
    expect(prompt.title).toBe("Hello needs permission");
    // A Flow and an Applet can share a name; the icon says which is asking.
    expect(prompt.icon?.glyph).toBe("flow");
    const applet = capabilityPrompt(
      { name: "", path: "space:tools/stage.applet.html" },
      { key: "k", type: "generateText" },
    );
    expect(applet.title).toBe("stage needs permission");
    expect(applet.icon?.glyph).toBe("applet");
    expect(prompt.message).toHaveLength(1);
    expect(lines(prompt.message[0])).toBe("Grant permission to read:\nn.md (needs it)");
    expect(text("Hello", { key: "k", type: "writeDocument", path: "o.md" })).toBe("Grant permission to write:\no.md");
    expect(text("Hello", { key: "k", type: "generateText", description: "needs it" })).toBe(
      "Grant permission to run an AI generation (needs it).",
    );
    expect(text("Hello", { key: "k", type: "generateText" })).toBe("Grant permission to run an AI generation.");
    expect(text("Tools", { key: "k", type: "readCurrentDocument" })).toBe(
      "Grant permission to read the currently open document.",
    );
    expect(text("Tools", { key: "k", type: "mystery" })).toBe("Grant permission to mystery.");
  });

  it("draws the path as a path label on a line of its own, the full path in its tooltip", () => {
    const [message] = capabilityPrompt(flow("Casting"), {
      key: "k",
      type: "generateVideo",
      path: "space:projects/pre-prod/casting",
    }).message;
    expect(lines(message)).toBe("Grant permission to Generate Video in:\nprojects/pre-prod/casting");
    const label = message.querySelector<HTMLElement>(".path-label");
    expect(label?.dataset.tooltip).toBe("projects/pre-prod/casting");
    expect(label?.textContent).toBe("projects/pre-prod/casting");
  });

  // Which provider gets the images isn't known when the grant is asked.
  it("says in a paragraph after an image or video generation's sentence that it spends credits and images leave for the provider", () => {
    const note =
      "Each generation consumes AI credits. Images are sent to the model provider for processing. Each provider handles them according to its own data retention and privacy policies. Review the provider's terms before sending sensitive or confidential images.";
    const [sentence, ...rest] = capabilityPrompt(flow("Art"), {
      key: "k",
      type: "generateImage",
      path: "renders",
    }).message;
    expect(lines(sentence)).toBe("Grant permission to Generate Image in:\nrenders");
    expect(rest).toEqual([note]);
    expect(
      capabilityPrompt(flow("Shots"), { key: "k", type: "generateVideo", path: "clips" }).message.slice(1),
    ).toEqual([note]);
  });

  it("asks to send files from a scope's folder, the space's own named as the status bar names it, and says what goes", () => {
    const [sentence, ...rest] = capabilityPrompt(flow("Shots"), {
      key: "k",
      type: "searchContext",
      path: "space:projects/story",
    }).message;
    expect(lines(sentence)).toBe("Grant permission to send files to an AI model from:\nprojects/story");
    expect(rest).toEqual([
      "Each run sends the model provider this folder's AGENTS.md, the README nearest the connected document and the notes that document names. The model may also search the folder and read any other file in it. Private files are never sent.",
    ]);
    const [root] = capabilityPrompt(flow("Shots"), { key: "k", type: "searchContext", path: "space:" }).message;
    expect(lines(root)).toBe("Grant permission to send files to an AI model from:\nSpace");
  });
});

describe("ensure", () => {
  it("is true at once for a granted key, and otherwise prompts in the host and grants on Allow", async () => {
    const { broker, deps, host } = setup();
    const subject = subjectOf({ grantedCapabilities: new Set(["generateText"]) });
    broker.mount(subject, host);
    await expect(broker.ensure({ key: "generateText", type: "generateText" })).resolves.toBe(true);
    expect(panel()).toBeNull();

    const pending = broker.ensure(subject.capabilities()[0]);
    await tick();
    expect(panel()?.parentElement?.classList.contains("dialog-scoped")).toBe(true);
    expect(host.contains(panel())).toBe(true);
    expect(panel()?.querySelector(".dialog-title")?.textContent).toBe("Hello needs permission");
    expect(panel()?.querySelector<HTMLElement>(".dialog-title .dialog-title-icon")?.dataset.entryIcon).toBe("flow");
    expect(message()).toBe("Grant permission to read:\nn.md (needs it)");
    expect(buttonNamed(panel() as HTMLElement, "Allow").classList.contains("danger")).toBe(true);

    buttonNamed(panel() as HTMLElement, "Allow").click();
    await expect(pending).resolves.toBe(true);
    expect(deps.grant).toHaveBeenCalledWith("flow", "a.flow.html", "readFile:n.md");
    expect(subject.grantedCapabilities.has("readFile:n.md")).toBe(true);
    expect(panel()).toBeNull();
  });

  it("resolves false on Deny, with nothing mounted, and for a subject that moved on while it waited", async () => {
    const { broker, deps, host } = setup();
    await expect(broker.ensure({ key: "generateText", type: "generateText" })).resolves.toBe(false);

    const first = subjectOf();
    broker.mount(first, host);
    const denied = broker.ensure({ key: "generateText", type: "generateText" });
    await tick();
    buttonNamed(panel() as HTMLElement, "Deny").click();
    await expect(denied).resolves.toBe(false);
    expect(deps.grant).not.toHaveBeenCalled();

    const stale = broker.ensure({ key: "generateText", type: "generateText" }, first);
    broker.mount(subjectOf({ name: "Other" }), host);
    await expect(stale).resolves.toBe(false);
    expect(panel()).toBeNull();
  });

  it("shows one dialog at a time: a second prompt waits for the first", async () => {
    const { broker, host } = setup();
    broker.mount(subjectOf(), host);
    const first = broker.ensure({ key: "readFile:n.md", type: "readFile", path: "n.md" });
    const second = broker.ensure({ key: "generateText", type: "generateText" });
    await tick();
    expect(document.querySelectorAll(".dialog-panel")).toHaveLength(1);
    expect(message()).toBe("Grant permission to read:\nn.md");
    buttonNamed(panel() as HTMLElement, "Allow").click();
    await expect(first).resolves.toBe(true);
    await tick();
    expect(message()).toBe("Grant permission to run an AI generation.");
    buttonNamed(panel() as HTMLElement, "Deny").click();
    await expect(second).resolves.toBe(false);
  });

  it("two requests for the same key made back to back prompt once", async () => {
    const { broker, deps, host } = setup();
    broker.mount(subjectOf(), host);
    const capability = { key: "generateText", type: "generateText" };
    const first = broker.ensure(capability);
    const second = broker.ensure(capability);
    await tick();
    buttonNamed(panel() as HTMLElement, "Allow").click();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    await tick();
    expect(panel()).toBeNull();
    expect(deps.grant).toHaveBeenCalledTimes(1);
  });

  it("a prompt queued behind the Permissions panel waits for the panel to close", async () => {
    const { broker, host } = setup();
    broker.mount(subjectOf(), host);
    const first = broker.ensure({ key: "readFile:n.md", type: "readFile", path: "n.md" });
    const second = broker.ensure({ key: "generateText", type: "generateText" });
    await tick();
    broker.showPermissions(); // answers the showing prompt with a close (Deny) and takes its place
    await expect(first).resolves.toBe(false);
    await tick();
    expect(panel()?.querySelector(".dialog-title")?.textContent).toBe("Permissions: Hello");
    // The prompt's icon too: the panel holds what those prompts allowed.
    expect(panel()?.querySelector<HTMLElement>(".dialog-title .dialog-title-icon")?.dataset.entryIcon).toBe("flow");

    const scrim = (panel() as HTMLElement).parentElement as HTMLElement;
    scrim.click();
    await tick();
    await tick();
    expect(message()).toBe("Grant permission to run an AI generation.");
    buttonNamed(panel() as HTMLElement, "Deny").click();
    await expect(second).resolves.toBe(false);
  });

  it("a failed grant shows in the dialog and leaves it open", async () => {
    const { broker, deps, host } = setup();
    deps.grant.mockRejectedValueOnce(new Error("disk full"));
    broker.mount(subjectOf(), host);
    void broker.ensure({ key: "generateText", type: "generateText" });
    await tick();
    buttonNamed(panel() as HTMLElement, "Allow").click();
    await tick();
    await tick();
    expect(panel()).not.toBeNull();
    expect(panel()?.querySelector(".dialog-error")?.textContent).toBe("disk full");
  });
});

describe("showPermissions", () => {
  it("lists every declared capability, revokes a granted one, and shows a failed revoke inline", async () => {
    const { broker, deps, host } = setup();
    const subject = subjectOf({ grantedCapabilities: new Set(["readFile:n.md"]) });
    broker.mount(subject, host);
    broker.showPermissions();
    const rows = () => [...(panel() as HTMLElement).querySelectorAll(".field-row")];
    expect(panel()?.querySelector(".dialog-title")?.textContent).toBe("Permissions: Hello");
    expect(rows()).toHaveLength(2);
    // The title names the document, so a row is the verb, the target muted
    // after it, and a declared description on its own line.
    expect(rows()[0].querySelector(".field-row-title")?.textContent).toBe("Read n.md");
    expect(rows()[0].querySelector(".permission-target")?.textContent).toBe("n.md");
    // Written to follow a prompt in parentheses, so a line of its own
    // capitalizes it.
    expect(rows()[0].querySelector(".field-row-description")?.textContent).toBe("Needs it");
    expect(rows()[1].querySelector(".field-row-title")?.textContent).toBe("Generate with AI");
    expect(rows()[0].querySelector("button")?.textContent).toBe("Revoke");
    expect(rows()[0].querySelector("button")?.className).toBe("btn btn-large");
    expect(rows()[1].querySelector(".field-row-value")?.textContent).toBe("Not granted");

    rows()[0].querySelector("button")?.click();
    await tick();
    expect(deps.revoke).toHaveBeenCalledWith("flow", "a.flow.html", "readFile:n.md");
    expect(subject.grantedCapabilities.size).toBe(0);
    expect((panel() as HTMLElement).querySelectorAll(".field-row button")).toHaveLength(0);

    subject.grantedCapabilities.add("generateText");
    deps.revoke.mockRejectedValueOnce(new Error("nope"));
    broker.showPermissions(); // replaces the open panel
    expect(document.querySelectorAll(".dialog-panel")).toHaveLength(1);
    const revoke = rows()[1].querySelector("button") as HTMLButtonElement;
    revoke.click();
    await tick();
    expect(panel()?.querySelector(".inline-error")?.textContent).toBe("nope");
    expect(revoke.disabled).toBe(false);
    expect(subject.grantedCapabilities.has("generateText")).toBe(true);

    broker.unmount();
    expect(panel()).toBeNull();
  });
});

// A document with no name of its own is called by its file name, as the
// editor's title calls it, never by a placeholder.
it("titles an unnamed document's panel with its file name", () => {
  const { broker, host } = setup();
  broker.mount(subjectOf({ name: "", path: "art/character-sheet.flow.html" }), host);
  broker.showPermissions();
  expect(panel()?.querySelector(".dialog-title")?.textContent).toBe("Permissions: character-sheet");
});

describe("the unattended row", () => {
  const row = () => [...(panel() as HTMLElement).querySelectorAll(".field-row")].at(-1) as HTMLElement;
  const title = () => row().querySelector(".field-row-title")?.textContent;
  const menu = () => document.querySelector<HTMLElement>(".context-menu");
  const choice = (label: string) => buttonNamed(menu() as HTMLElement, label);
  const dayLabel = (day: string) => parseLocalDay(day)?.toLocaleDateString(undefined, { dateStyle: "medium" });
  const inDays = (days: number) => localDayAfter(new Date(), days);

  function open(unattended: BrokerSubject["unattended"]): BrokerSubject {
    const { broker, host } = setup();
    const subject = subjectOf({ unattended });
    broker.mount(subject, host);
    broker.showPermissions();
    return subject;
  }

  it("appears only for a subject that carries the grant", () => {
    const { broker, host } = setup();
    broker.mount(subjectOf(), host);
    broker.showPermissions();
    expect((panel() as HTMLElement).textContent).not.toMatch(/Run unattended/);

    broker.mount(subjectOf({ unattended: { granted: false, set: vi.fn() } }), host);
    broker.showPermissions();
    expect(title()).toBe("Run unattended");
    expect(row().classList.contains("permission-standing")).toBe(true);
  });

  // buttonNamed matches whole text, and a menu row's text runs its label
  // into its detail.
  it("allows it from a menu of how long, each choice naming its last day", async () => {
    const set = vi.fn(async () => undefined);
    const subject = open({ granted: false, set });
    const allow = buttonNamed(row(), "Allow");
    expect(allow.className).toBe("btn btn-large primary dialog-primary danger permission-allow");
    expect(allow.getAttribute("aria-haspopup")).toBe("menu");

    allow.click();
    const rows = [...(menu() as HTMLElement).querySelectorAll("button")];
    expect(rows.map((item) => item.firstChild?.textContent)).toEqual(["1 day", "30 days", "90 days", "Until revoked"]);
    expect(rows.map((item) => item.querySelector(".context-menu-detail")?.textContent)).toEqual([
      `until ${dayLabel(inDays(1))}`,
      `until ${dayLabel(inDays(30))}`,
      `until ${dayLabel(inDays(90))}`,
      undefined,
    ]);

    rows[1].click();
    await tick();
    expect(set).toHaveBeenCalledWith(true, inDays(30));
    expect(subject.unattended).toMatchObject({ granted: true, until: inDays(30) });
    expect(title()).toBe(`Run unattended until ${dayLabel(inDays(30))}`);
    expect(row().querySelector(".permission-target")?.getAttribute("data-tooltip")).toBe("Through the end of that day");
    expect(buttonNamed(row(), "Revoke").className).toBe("btn btn-large");
  });

  it("allows it until revoked with no last day", async () => {
    const set = vi.fn(async () => undefined);
    open({ granted: false, set });
    buttonNamed(row(), "Allow").click();
    choice("Until revoked").click();
    await tick();
    expect(set).toHaveBeenCalledWith(true, undefined);
    expect(title()).toBe("Run unattended");
    expect(buttonNamed(row(), "Revoke")).toBeTruthy();
  });

  // The file was read before the day ran out: the panel still says so.
  it("names the last day of one that expired, and offers Allow again", () => {
    open({ granted: true, until: "2020-01-31", set: vi.fn() });
    expect(title()).toBe(`Run unattended expired ${dayLabel("2020-01-31")}`);
    expect(row().querySelector(".permission-target")?.hasAttribute("data-tooltip")).toBe(false);
    expect(buttonNamed(row(), "Allow")).toBeTruthy();
  });

  it("revokes it, dropping its last day", async () => {
    const set = vi.fn(async () => undefined);
    const subject = open({ granted: true, until: inDays(5), set });
    buttonNamed(row(), "Revoke").click();
    await tick();
    expect(set).toHaveBeenCalledWith(false, undefined);
    expect(subject.unattended).toMatchObject({ granted: false, until: undefined });
    expect(title()).toBe("Run unattended");
  });

  it("shows a failed change inline and leaves the grant as it was", async () => {
    const subject = open({ granted: false, set: vi.fn(async () => Promise.reject(new Error("refused"))) });
    buttonNamed(row(), "Allow").click();
    choice("Until revoked").click();
    await tick();
    expect(panel()?.querySelector(".inline-error")?.textContent).toBe("refused");
    expect(subject.unattended?.granted).toBe(false);
    expect(buttonNamed(row(), "Allow").disabled).toBe(false);
  });

  // The dialog's Escape outranks the menu's.
  it("closes the menu on Escape before the panel", () => {
    const { broker, host, deps } = setup();
    broker.mount(subjectOf({ unattended: { granted: false, set: vi.fn() } }), host);
    broker.showPermissions();
    buttonNamed(row(), "Allow").click();
    expect(menu()).not.toBeNull();

    deps.dialog.escape();
    expect(menu()).toBeNull();
    expect(panel()).not.toBeNull();
    deps.dialog.escape();
    expect(panel()).toBeNull();
  });
});

describe("dispatchFrameRequests", () => {
  function frameSetup() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const replies = vi.fn();
    (frame.contentWindow as Window).postMessage = replies as never;
    const onNotice = vi.fn();
    const disposable = dispatchFrameRequests({
      frame: () => frame,
      source: "pragma-x",
      handlers: {
        echo: async (data) => ({ got: data.value }),
        boom: async () => {
          throw new Error("bad");
        },
      },
      onNotice,
    });
    const send = (data: Record<string, unknown>, source: Window | null = frame.contentWindow) =>
      window.dispatchEvent(new MessageEvent("message", { source, data }));
    return { replies, onNotice, send, disposable };
  }

  it("replies to the frame that asked with the handler's result, or its error", async () => {
    const { replies, onNotice, send } = frameSetup();
    send({ source: "pragma-x", type: "echo", requestId: 1, value: "v" });
    send({ source: "pragma-x", type: "boom", requestId: 2 });
    send({ source: "pragma-x", type: "nope", requestId: 3 });
    await tick();
    // Replies land as each handler settles, not in request order.
    const byId = replies.mock.calls.map((call) => call[0]).sort((a, b) => a.requestId - b.requestId);
    expect(byId).toEqual([
      { source: "pragma-host", requestId: 1, result: { got: "v" }, error: undefined },
      { source: "pragma-host", requestId: 2, result: undefined, error: "bad" },
      { source: "pragma-host", requestId: 3, result: undefined, error: "Unknown request type: nope" },
    ]);
    expect(onNotice).not.toHaveBeenCalled();
  });

  it("hands notices on, and ignores other senders, other sources, and everything after dispose", async () => {
    const { replies, onNotice, send, disposable } = frameSetup();
    send({ source: "pragma-x", type: "resize", height: 10 });
    expect(onNotice).toHaveBeenCalledWith({ source: "pragma-x", type: "resize", height: 10 });
    send({ source: "pragma-other", type: "echo", requestId: 4 });
    send({ source: "pragma-x", type: "echo", requestId: 5 }, window);
    send({ source: "pragma-x", type: "echo", requestId: 6 }, null);
    disposable.dispose();
    send({ source: "pragma-x", type: "echo", requestId: 7 });
    await tick();
    expect(replies).not.toHaveBeenCalled();
    expect(onNotice).toHaveBeenCalledTimes(1);
  });
});
