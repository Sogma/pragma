// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMode, ChatResponse } from "../../../src/protocol/api.ts";
import { parseRootedPath } from "../../../src/protocol/rootedPath.ts";
import { SetupError } from "../../../src/protocol/setupNeed.ts";
import { wikilinkFromRoot } from "../../../src/protocol/wikilink.ts";
import {
  type FileResponse,
  postChat,
  postCreateEntry,
  putFile,
  SaveConflictError,
} from "../../../web/core/apiClient.ts";
import type { ChatScreen } from "../../../web/core/chatContext.ts";
import { refresh as refreshSpaceTree } from "../../../web/core/spaceTree.ts";
import type { ProposalOutcome } from "../../../web/editProposal.ts";
import { installTextMenu } from "../../../web/lib/textMenu.ts";
import { createDialogService } from "../../../web/services/dialog.ts";
import { createFormats } from "../../../web/services/formats.ts";
import { CHAT_LINK_MENU, type Chat, type ChatDeps, wireChat } from "../../../web/view/chat.ts";

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  postChat: vi.fn(async () => ({ reply: "Noted." })),
  postCreateEntry: vi.fn(),
  putFile: vi.fn(),
}));

// What the writer sees, as a test sets it, and the chat following it.
let screen: ChatScreen;
let chat: Chat;

// The composer as web/index.html has it, trimmed to what the module reads,
// wired for a turn sent in `mode`.
function setup(mode: ChatMode = "suggesting", overrides: Partial<ChatDeps> = {}) {
  document.body.innerHTML = `
    <section id="assistant-chat">
      <div id="chat-messages"></div>
      <form id="chat-form">
        <textarea id="chat-input"></textarea>
        <div class="chat-composer-toolbar">
          <button id="chat-model-button" type="button"></button>
          <button id="chat-send" type="submit" disabled></button>
        </div>
      </form>
    </section>`;
  screen = { focused: { view: "none" }, scopes: { focused: undefined, shown: [] } };
  const deps: ChatDeps = {
    chatPick: { request: () => ({ model: "", effort: "high", mode }) },
    screen: () => screen,
    flushPendingSave: async () => {},
    proposeEdit: () => undefined,
    revealCreatedEntry: vi.fn(async () => {}),
    tabs: {
      openSpacePath: vi.fn(async () => {}),
      openEntryBeside: vi.fn(async () => {}),
      openFolder: vi.fn(async () => {}),
    },
    loadFile: vi.fn(
      async (path: string): Promise<FileResponse> => ({
        kind: "text",
        path,
        revision: "r1",
        content: "# Note\n\nAda climbs.\n",
        documentType: "note",
        toolkits: [],
        classLinks: [],
        fields: [],
      }),
    ),
    formats: createFormats(),
    contextMenu: { open: vi.fn(), close: vi.fn(), isOpen: () => false },
    dialog: createDialogService(),
    trashEntry: vi.fn(async () => ({})),
    ...overrides,
  };
  chat = wireChat(deps);
  return deps;
}

beforeEach(() => {
  vi.mocked(postChat).mockClear();
  vi.mocked(postCreateEntry).mockReset();
  vi.mocked(putFile).mockReset();
  setup();
});

const input = () => document.querySelector("#chat-input") as HTMLTextAreaElement;
const sendButton = () => document.querySelector("#chat-send") as HTMLButtonElement;

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input"));
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init });
  input().dispatchEvent(event);
  return event;
}

describe("the chat composer", () => {
  it("offers Send only while there is text to send", () => {
    expect(sendButton().disabled).toBe(true);
    type("  ");
    expect(sendButton().disabled).toBe(true);
    type("Tighten this");
    expect(sendButton().disabled).toBe(false);
  });

  it("sends on Enter and leaves Shift+Enter and a composing IME's Enter to the text", async () => {
    type("first line");
    expect(press({ shiftKey: true }).defaultPrevented).toBe(false);
    expect(press({ isComposing: true }).defaultPrevented).toBe(false);
    expect(postChat).not.toHaveBeenCalled();

    expect(press({}).defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(vi.mocked(postChat).mock.calls[0]?.[2]).toBe("first line");
    // The turn names the model, effort and mode the chips named when it was sent.
    expect(vi.mocked(postChat).mock.calls[0]?.[3]).toEqual({ model: "", effort: "high", mode: "suggesting" });
    expect(input().value).toBe("");
    expect(sendButton().disabled).toBe(true);
    expect(document.querySelector("#chat-messages .chat-message.assistant")?.textContent).toBe("Noted.");
  });

  it("shows a refused turn's message with the link to the setting that fixes it", async () => {
    const refusal = new SetupError("No model selected.", { kind: "defaultModel", output: "text" });
    vi.mocked(postChat).mockRejectedValueOnce(refusal);
    type("hello");
    press({});
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    const failure = [...document.querySelectorAll("#chat-messages .inline-error")].at(-1);
    expect(failure?.querySelector(".inline-error-message")?.textContent).toBe("No model selected.");
    expect(failure?.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
  });
});

// The last card's text, and its one button, if it still has one.
const lastCard = () => [...document.querySelectorAll<HTMLElement>("#chat-messages .chat-message.confirm")].at(-1);
const cardLabel = () => lastCard()?.firstElementChild?.textContent;
const cardButton = (label: string) =>
  [...(lastCard()?.querySelectorAll("button") ?? [])].find((button) => button.textContent === label);

async function sendTurn(): Promise<void> {
  type("go");
  press({});
  await vi.waitFor(() => expect(input().disabled).toBe(false));
}

const allApplied = (count: number): ProposalOutcome => ({ accepted: count, rejected: 0, dropped: 0, replaced: false });

describe("a turn in Editing", () => {
  it("creates the copilot's new file at once, and Undo moves it to the Trash", async () => {
    const deps = setup("editing");
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Made it.",
      proposedDocument: { parentPath: "notes", name: "aria.md", type: "file", content: "# Aria\n" },
    });
    vi.mocked(postCreateEntry).mockResolvedValueOnce({ path: "notes/aria.md", type: "file" });

    await sendTurn();
    expect(postCreateEntry).toHaveBeenCalledWith("notes", "aria.md", "file", "# Aria\n");
    expect(deps.revealCreatedEntry).toHaveBeenCalledWith({ path: "notes/aria.md", type: "file" });
    expect(cardLabel()).toBe("Created notes/aria.md.");

    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe("Moved notes/aria.md to the Trash."));
    expect(deps.trashEntry).toHaveBeenCalledWith("notes/aria.md");
    expect(cardButton("Undo")).toBeUndefined();
  });

  it("keeps Undo when the writer won't let the move to the Trash unpublish the page", async () => {
    const deps = setup("editing", { trashEntry: vi.fn(async () => undefined) });
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Made it.",
      proposedDocument: { parentPath: "site", name: "aria.md", type: "file", content: "# Aria\n" },
    });
    vi.mocked(postCreateEntry).mockResolvedValueOnce({ path: "site/aria.md", type: "file" });

    await sendTurn();
    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(deps.trashEntry).toHaveBeenCalledWith("site/aria.md"));
    await vi.waitFor(() => expect(cardButton("Undo")?.disabled).toBe(false));
    expect(cardLabel()).toBe("Created site/aria.md.");
  });

  it("says when an unpublish the move set off is still queued", async () => {
    const note = "1 published document couldn't be unpublished yet. It remains queued for later.";
    setup("editing", { trashEntry: vi.fn(async () => ({ unpublishNote: note })) });
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Made it.",
      proposedDocument: { parentPath: "site", name: "aria.md", type: "file", content: "# Aria\n" },
    });
    vi.mocked(postCreateEntry).mockResolvedValueOnce({ path: "site/aria.md", type: "file" });

    await sendTurn();
    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe(`Moved site/aria.md to the Trash. ${note}`));
  });

  it("writes an edit to a file that isn't open on the revision it was read at, and Undo writes it back", async () => {
    setup("editing");
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Fixed.",
      proposedEdit: { path: "b.md", before: "old\n", newContent: "new\n", revision: "r1" },
    });
    vi.mocked(putFile).mockResolvedValueOnce({ revision: "r2" }).mockResolvedValueOnce({ revision: "r3" });

    await sendTurn();
    expect(putFile).toHaveBeenCalledWith("b.md", "new\n", "r1", { source: "copilot" });
    expect(cardLabel()).toBe("Edited b.md.");

    // The writer's own undo, so History names it theirs.
    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe("Undid the edit to b.md."));
    expect(putFile).toHaveBeenLastCalledWith("b.md", "old\n", "r2");
  });

  it("leaves a file changed since alone, both when applying and when undoing", async () => {
    setup("editing");
    const conflict = () => new SaveConflictError("Changed on disk", 409);
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Fixed.",
      proposedEdit: { path: "b.md", before: "old\n", newContent: "new\n", revision: "r1" },
    });
    vi.mocked(putFile).mockRejectedValueOnce(conflict());
    await sendTurn();
    const failure = [...document.querySelectorAll("#chat-messages .inline-error")].at(-1);
    expect(failure?.textContent).toBe("The edit to b.md wasn't applied: it changed after the copilot read it.");

    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Fixed.",
      proposedEdit: { path: "b.md", before: "old\n", newContent: "new\n", revision: "r1" },
    });
    vi.mocked(putFile).mockResolvedValueOnce({ revision: "r2" }).mockRejectedValueOnce(conflict());
    await sendTurn();
    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe("Not undone: b.md has changed since this edit."));
  });

  it("applies an edit to the open document at once, and Undo applies its reverse", async () => {
    const proposeEdit = vi.fn<ChatDeps["proposeEdit"]>((_edit, onSettled, apply) => {
      if (apply) onSettled(allApplied(2));
      return 2;
    });
    setup("editing", { proposeEdit });
    const edit = { path: "a.md", before: "one\n", newContent: "two\n", revision: "r" };
    vi.mocked(postChat).mockResolvedValueOnce({ reply: "Done.", currentDocumentEdit: edit });

    await sendTurn();
    expect(proposeEdit).toHaveBeenCalledWith(edit, expect.any(Function), true);
    expect(cardLabel()).toBe("Applied 2 changes to a.md.");

    cardButton("Undo")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe("Undid the changes to a.md."));
    expect(proposeEdit).toHaveBeenLastCalledWith(
      { path: "a.md", before: "two\n", newContent: "one\n", revision: "r" },
      expect.any(Function),
      true,
    );
  });
});

describe("a turn in Suggesting", () => {
  it("writes nothing until the writer applies it", async () => {
    vi.mocked(postChat).mockResolvedValueOnce({
      reply: "Here's a fix.",
      proposedEdit: { path: "b.md", before: "old\n", newContent: "new\n", revision: "r1" },
    });

    await sendTurn();
    expect(putFile).not.toHaveBeenCalled();
    expect(cardLabel()).toBe("Apply this edit to b.md?");

    vi.mocked(putFile).mockResolvedValueOnce({ revision: "r2" });
    cardButton("Apply")?.click();
    await vi.waitFor(() => expect(cardLabel()).toBe("Applied edit to b.md."));
    expect(putFile).toHaveBeenCalledWith("b.md", "new\n", undefined, { source: "copilot" });
  });
});

describe("a turn about the screen", () => {
  it("sends the tab the other group shows along with the focused one", async () => {
    screen = { ...screen, focused: { view: "document", path: "a.md" }, beside: { view: "flow", path: "b.flow.html" } };
    await sendTurn();
    expect(vi.mocked(postChat).mock.calls[0]?.[0]).toEqual({ view: "document", path: "a.md" });
    expect(vi.mocked(postChat).mock.calls[0]?.[4]).toEqual({ view: "flow", path: "b.flow.html" });
  });

  it("draws an edit to another document on screen in its editor, not in a card", async () => {
    const proposeEdit = vi.fn<ChatDeps["proposeEdit"]>(() => 2);
    setup("suggesting", { proposeEdit });
    const edit = { path: "b.md", before: "old\n", newContent: "new\n", revision: "r1" };
    vi.mocked(postChat).mockResolvedValueOnce({ reply: "Here's a fix.", proposedEdit: edit });

    await sendTurn();
    expect(proposeEdit).toHaveBeenCalledWith(edit, expect.any(Function));
    expect(cardLabel()).toBe("2 proposed changes to b.md, shown in the editor.");
    expect(cardButton("Apply")).toBeUndefined();
  });

  it("says under the reply which images the copilot looked at", async () => {
    vi.mocked(postChat).mockResolvedValueOnce({ reply: "Two red dots.", lookedAt: ["shots/frame.png", "logo.png"] });

    await sendTurn();
    const reply = document.querySelector("#chat-messages .chat-message.assistant");
    expect(reply?.textContent).toBe("Two red dots.");
    const note = reply?.nextElementSibling;
    expect(note?.querySelector(".chat-looked-at-words")?.textContent).toBe("Looked at:");
    expect(note?.querySelector(".chat-looked-at")?.classList.contains("is-list")).toBe(true);
    const labels = [...(note?.querySelectorAll<HTMLElement>(".chat-looked-at-paths > .path-label") ?? [])];
    expect(labels.map((label) => label.dataset.tooltip)).toEqual(["shots/frame.png", "logo.png"]);
    expect(labels.map((label) => label.textContent)).toEqual(["shots/frame.png", "logo.png"]);
  });

  it("keeps one image on the line beside Looked at:", async () => {
    vi.mocked(postChat).mockResolvedValueOnce({ reply: "A red dot.", lookedAt: ["logo.png"] });

    await sendTurn();
    const note = document.querySelector("#chat-messages .chat-message.assistant")?.nextElementSibling;
    expect(note?.querySelector(".chat-looked-at")?.classList.contains("is-list")).toBe(false);
    expect(note?.querySelectorAll(".chat-looked-at-paths > .path-label")).toHaveLength(1);
  });
});

// The scopes on screen: the focused tab's, then every group's.
function look(focused: string | undefined, ...shown: string[]): void {
  screen = { ...screen, scopes: { focused, shown } };
  chat.follow();
}

async function say(text: string): Promise<void> {
  type(text);
  press({});
  await vi.waitFor(() => expect(input().disabled).toBe(false));
}

const transcript = () => [...document.querySelectorAll("#chat-messages .chat-message")].map((el) => el.textContent);
const scopeName = () => document.querySelector(".chat-scope-name")?.textContent;
const switchButton = () => document.querySelector(".chat-scope-switch") as HTMLButtonElement;
const newChatButton = () => document.querySelector(".chat-new") as HTMLButtonElement;
const historySent = (call: number) => vi.mocked(postChat).mock.calls[call]?.[1];

describe("a chat per scope", () => {
  it("keeps a scope's chat while it is on screen, and follows the focused tab once it leaves", async () => {
    expect(scopeName()).toBe("Space");
    look("projects/a", "projects/a");
    expect(scopeName()).toBe("a");
    await say("about a");

    look("projects/b", "projects/a", "projects/b");
    expect(scopeName()).toBe("a");
    expect(transcript()).toEqual(["about a", "Noted."]);
    expect(switchButton().hidden).toBe(false);
    expect(switchButton().textContent).toBe("b");
    expect(switchButton().getAttribute("aria-label")).toBe("Switch to b");

    look("projects/b", "projects/b");
    expect(scopeName()).toBe("b");
    expect(transcript()).toEqual([]);
    expect(switchButton().hidden).toBe(true);

    look("projects/a", "projects/a");
    expect(transcript()).toEqual(["about a", "Noted."]);
  });

  it("keeps the chat showing while the focused tab is in no scope", () => {
    look("projects/a", "projects/a");
    look(undefined);
    expect(scopeName()).toBe("a");
    expect(switchButton().hidden).toBe(true);
  });

  it("sends each chat only its own history", async () => {
    look("projects/a", "projects/a");
    await say("about a");
    look("projects/b", "projects/b");
    await say("about b");
    look("projects/a", "projects/a");
    await say("more on a");

    expect(historySent(1)).toEqual([]);
    expect(historySent(2)).toEqual([
      { role: "user", content: "about a" },
      { role: "assistant", content: "Noted." },
    ]);
  });

  it("offers the other group's scope while the focus is on the chat's own side", () => {
    look("projects/a", "projects/a", "projects/b");
    expect(scopeName()).toBe("a");
    expect(switchButton().hidden).toBe(false);
    expect(switchButton().getAttribute("aria-label")).toBe("Switch to b");

    switchButton().click();
    expect(scopeName()).toBe("b");
    expect(switchButton().getAttribute("aria-label")).toBe("Switch to a");
  });

  it("switches to the focused tab's chat on request, and keeps it while its scope is on screen", () => {
    look("projects/a", "projects/a");
    look("projects/b", "projects/a", "projects/b");
    switchButton().click();
    expect(scopeName()).toBe("b");
    expect(switchButton().hidden).toBe(false);
    expect(switchButton().textContent).toBe("a");

    look("projects/a", "projects/a", "projects/b");
    expect(scopeName()).toBe("b");
    expect(switchButton().textContent).toBe("a");
    expect(switchButton().getAttribute("aria-label")).toBe("Switch to a");
  });

  it("starts the scope's chat over with New chat, offered once there is something to clear", async () => {
    look("projects/a", "projects/a");
    expect(newChatButton().disabled).toBe(true);
    await say("about a");
    expect(newChatButton().disabled).toBe(false);

    newChatButton().click();
    expect(transcript()).toEqual([]);
    expect(newChatButton().disabled).toBe(true);
    await say("again");
    expect(historySent(1)).toEqual([]);
  });

  it("lands a reply, and what the writer decides in the editor, in the chat the turn was sent from", async () => {
    let settle: (outcome: ProposalOutcome) => void = () => {};
    setup("suggesting", {
      proposeEdit: (_edit, onSettled) => {
        settle = onSettled;
        return 1;
      },
    });
    let reply: (response: ChatResponse) => void = () => {};
    vi.mocked(postChat).mockImplementationOnce(() => new Promise((resolve) => (reply = resolve)));
    const edit = { path: "projects/a/x.md", before: "a\n", newContent: "b\n", revision: "r" };

    look("projects/a", "projects/a");
    type("tighten it");
    press({});
    await vi.waitFor(() => expect(postChat).toHaveBeenCalledTimes(1));
    look("projects/b", "projects/b");
    reply({ reply: "Tightened.", currentDocumentEdit: edit });
    await vi.waitFor(() => expect(input().disabled).toBe(false));
    expect(transcript()).toEqual([]);

    settle(allApplied(1));
    look("projects/a", "projects/a");
    expect(transcript()).toEqual(["tighten it", "Tightened.", "Applied the proposed changes to projects/a/x.md."]);
    await say("thanks");
    expect(historySent(1)).toEqual([
      { role: "user", content: "tighten it" },
      { role: "assistant", content: 'Tightened.\n\n(The writer accepted every proposed change to "projects/a/x.md".)' },
    ]);
  });
});

describe("links in a reply", () => {
  // The space as its listing has it, a scope opening over `story`.
  const listing = {
    files: ["note.md", "story/act.fountain", "projects/a.md"],
    folders: ["story", "projects"],
    scopes: ["story"],
  };
  const scopes = { has: (folder: string) => folder === "story" };
  // Each written as the copilot is handed it to copy.
  const link = (path: string, folder = false) => wikilinkFromRoot(parseRootedPath(path), scopes, folder);
  const replyLinks = () => [...document.querySelectorAll<HTMLElement>("#chat-messages .chat-message.assistant a")];

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => Response.json(String(url).startsWith("/api/space/paths") ? listing : [])),
    );
    await refreshSpaceTree();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("links each file the copilot copies a link for, read as from the space root, a scope's and a folder's too", async () => {
    const links = [link("note.md"), link("story/act.fountain"), link("projects/a.md"), link("projects", true)];
    vi.mocked(postChat).mockResolvedValueOnce({ reply: `See ${links.join(", ")} and [[elsewhere]].` });
    await sendTurn();

    expect(replyLinks().map((anchor) => [anchor.textContent, anchor.dataset.spacePath])).toEqual([
      ["note", "note.md"],
      ["act", "story/act.fountain"],
      ["a", "projects/a.md"],
      ["projects", "projects/"],
    ]);
    expect(document.querySelector(".chat-message.assistant .wikilink-unresolved")?.textContent).toBe("elsewhere");
  });

  it("puts a link's menu above the text menu's on a right-click, a folder link's as the folder's", async () => {
    const deps = setup();
    const textMenu = installTextMenu(deps.contextMenu);
    vi.mocked(postChat).mockResolvedValueOnce({ reply: `See ${link("note.md")} and ${link("projects", true)}.` });
    await sendTurn();
    const [file, folder] = replyLinks();

    const rightClick = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 3, clientY: 4 });
    file.dispatchEvent(rightClick);
    expect(rightClick.defaultPrevented).toBe(true);
    expect(deps.contextMenu.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ menu: CHAT_LINK_MENU, arg: { file: "note.md" }, at: { x: 3, y: 4 } }),
    );
    folder.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    expect(deps.contextMenu.open).toHaveBeenLastCalledWith(
      expect.objectContaining({ menu: CHAT_LINK_MENU, arg: { folder: "projects" } }),
    );
    textMenu.dispose();
  });

  it("opens a link in a new tab on a click, and shows its file while the pointer rests on it", async () => {
    const deps = setup();
    vi.mocked(postChat).mockResolvedValueOnce({ reply: `See ${link("note.md")}.` });
    await sendTurn();
    const [anchor] = replyLinks();

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    anchor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(deps.tabs.openEntryBeside).toHaveBeenCalledWith("note.md");

    for (const type of ["pointerover", "pointermove"]) {
      anchor.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse" }));
    }
    await vi.waitFor(() => expect(document.querySelector(".link-preview .editor-reading-content")).not.toBeNull());
    expect(deps.loadFile).toHaveBeenCalledWith("note.md");
    expect(document.querySelector("#assistant-chat > .link-preview-veil")?.classList.contains("is-shown")).toBe(true);
    document.querySelector<HTMLButtonElement>(".link-preview .preview-open")?.click();
    expect(deps.tabs.openEntryBeside).toHaveBeenLastCalledWith("note.md");
  });
});
