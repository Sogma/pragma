// The assistant rail's chat panel: the copilot conversation, plus the
// confirm cards that gate every document it proposes to create or edit, or in
// Editing mode the cards that report each applied change with its Undo.
// It owns the transcripts, one per scope for the session, which nothing
// outside reads.
//
// It deliberately does not own the space: the turn's document and what
// happens on accept arrive as dependencies, so an accepted proposal lands
// through the same tree refresh and open a hand-driven action would.
import type { ChatResponse, CreateEntryResponse, ProposedFileEdit } from "../../src/protocol/api.ts";
import { type SetupNeed, setupNeedOf } from "../../src/protocol/setupNeed.ts";
import {
  type ChatMessage,
  type ChatRequestBody,
  type FileResponse,
  postChat,
  postCreateEntry,
  putFile,
  SaveConflictError,
} from "../core/apiClient.ts";
import { type ChatScreen, chatScopeFor, switchScopeFor } from "../core/chatContext.ts";
import { folderTitle, joinSpacePath, linkedEntry } from "../core/paths.ts";
import { entryIconAt, pathNames, readingResolvers, readingResolversIn } from "../core/spaceTree.ts";
import type { ProposalOutcome } from "../editProposal.ts";
import { addCodeBlockCopyButtons, countText, must, setEntryIcon } from "../lib/dom.ts";
import { createFrostHeader } from "../lib/frostHeader.ts";
import { createInlineError } from "../lib/inlineError.ts";
import { createPathLabel } from "../lib/pathLabel.ts";
import { settingLinks } from "../lib/settingLink.ts";
import { leadTextMenu } from "../lib/textMenu.ts";
import { buildUpJuggle } from "../lib/typingJuggle.ts";
import { diffLines, renderLineDiff } from "../lineDiff.ts";
import { renderMarkdownInline } from "../markdownRender.ts";
import { installLinkPreview } from "../notePreview.ts";
import type { DialogService } from "../services/dialog.ts";
import type { FormatRegistry } from "../services/formats.ts";
import type { ContextMenuService } from "../services/menus.ts";
import type { Tabs } from "../services/tabs.ts";

/** The menu above the text menu's items on a link in a reply: its ways to
 * open the file, or with `{ folder }`, the folder. */
export const CHAT_LINK_MENU = "chat.link";

// What a card or note says, each path in it drawn as a path label.
type Sentence = (string | Node)[];

const named = (path: string, after?: string): HTMLElement => createPathLabel(path, pathNames, { after, compact: true });

// "Looked at:" and the image beside it, or with several, the images listed
// under it, one a line. Not a sentence: in running text a path too long for
// the rest of the line drops below the words whole (chat.css).
function lookedAtRow(paths: string[]): HTMLElement {
  const words = document.createElement("span");
  words.className = "chat-looked-at-words";
  words.textContent = "Looked at:";
  const images = document.createElement("div");
  images.className = "chat-looked-at-paths";
  images.append(...paths.map((path) => named(path)));
  const row = document.createElement("div");
  row.className = paths.length > 1 ? "chat-looked-at is-list" : "chat-looked-at";
  row.append(words, images);
  return row;
}

// The transcript's glide to a message that lands: the Find card's curve
// (--card-slide, find-card.css) over a longer run.
const GLIDE: KeyframeAnimationOptions = { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };

export interface ChatDeps {
  /** The model, effort and mode the composer's chips name for the next turn. */
  chatPick: { request(): Pick<ChatRequestBody, "model" | "effort" | "mode"> };
  /** What the writer sees: what the next turn is about, and which scope's
   * chat shows. */
  screen(): ChatScreen;
  /** Settles unsaved edits so the server reads the document as it looks on
   * screen, not as it was last written. */
  flushPendingSave(): Promise<unknown>;
  /** Draws the copilot's edit over the document it was made for, to be
   * decided change by change, or with `apply` applies all of it at once.
   * Returns how many changes that shows, or undefined when that document is
   * no longer the one on screen. */
  proposeEdit(
    edit: ProposedFileEdit,
    onSettled: (outcome: ProposalOutcome) => void,
    apply?: boolean,
  ): number | undefined;
  /** Refreshes the tree and opens the new entry there, exactly as the tree's
   * own New note flow does, so a copilot-created file arrives the same way a
   * hand-created one does. */
  revealCreatedEntry(created: CreateEntryResponse): Promise<void>;
  /** Where a file the copilot changed opens, in the tab's place, and a link
   * in a reply, in a new tab, so the chat and what it is about both stay. */
  tabs: Pick<Tabs, "openSpacePath" | "openEntryBeside" | "openFolder">;
  /** What a link's preview reads its file with, draws it by and opens its
   * menus and dialogs in. */
  loadFile(path: string): Promise<FileResponse>;
  formats: Pick<FormatRegistry, "get">;
  contextMenu: ContextMenuService;
  dialog: DialogService;
  /** Moves an entry the copilot created to the Trash, for its Undo: what a
   * failed unpublish left queued, or undefined when the writer kept it. */
  trashEntry(path: string): Promise<{ unpublishNote?: string } | undefined>;
}

/** The chat, kept on the scope the screen calls for. */
export interface Chat {
  /** Shows the chat of the scope the screen now calls for. */
  follow(): void;
}

// One scope's conversation. A turn keeps the chat it was sent from: its
// reply, its cards and the notes on what the writer decided, in a card or
// in the editor, land there, whichever chat shows by then.
interface Thread {
  readonly scope: string;
  history: ChatMessage[];
  // Kept whole while another chat shows, so its cards' buttons still work.
  readonly transcript: HTMLDivElement;
  scrollTop: number;
}

function newThread(scope: string): Thread {
  const transcript = document.createElement("div");
  transcript.className = "chat-thread";
  return { scope, history: [], transcript, scrollTop: 0 };
}

export function wireChat(deps: ChatDeps): Chat {
  const messages = must<HTMLDivElement>("#chat-messages");
  const form = must<HTMLFormElement>("#chat-form");
  const input = must<HTMLTextAreaElement>("#chat-input");
  const sendButton = must<HTMLButtonElement>("#chat-send");

  const header = createFrostHeader(messages, "chat-header");
  const scopeLabel = document.createElement("span");
  scopeLabel.className = "chat-scope";
  const scopeIcon = document.createElement("span");
  const scopeName = document.createElement("span");
  scopeName.className = "chat-scope-name";
  scopeLabel.append(scopeIcon, scopeName);
  const switchButton = document.createElement("button");
  switchButton.type = "button";
  switchButton.className = "flat-button chat-scope-switch";
  const switchIcon = document.createElement("span");
  switchIcon.className = "chat-scope-switch-icon";
  switchIcon.setAttribute("aria-hidden", "true");
  const switchName = document.createElement("span");
  switchName.className = "chat-scope-switch-name";
  switchButton.append(switchIcon, switchName);
  const newChatButton = document.createElement("button");
  newChatButton.type = "button";
  newChatButton.className = "icon-button chat-new";
  newChatButton.setAttribute("aria-label", "New chat");
  const newChatIcon = document.createElement("span");
  newChatIcon.className = "chat-new-icon";
  newChatIcon.setAttribute("aria-hidden", "true");
  newChatButton.append(newChatIcon);
  header.append(scopeLabel, switchButton, newChatButton);

  // Until the screen is first read, the space's own chat.
  const threads = new Map<string, Thread>();
  let showing = threadOf("");
  // The focused tab's scope while its chat isn't the one showing.
  let elsewhere: string | undefined;
  // The transcript's glide to its end while one runs.
  let glide: { clock: Animation; to: number; frame: number } | undefined;
  messages.replaceChildren(showing.transcript);
  renderHeader();

  function threadOf(scope: string): Thread {
    const thread = threads.get(scope) ?? newThread(scope);
    threads.set(scope, thread);
    return thread;
  }

  function show(thread: Thread): void {
    // A glide cut short by the switch leaves its chat where it was going.
    if (glide) messages.scrollTop = glide.to;
    stopGlide();
    showing.scrollTop = messages.scrollTop;
    showing = thread;
    messages.replaceChildren(thread.transcript);
    messages.scrollTop = thread.scrollTop;
    renderHeader();
  }

  function follow(): void {
    const { scopes } = deps.screen();
    const next = chatScopeFor(showing.scope, scopes);
    elsewhere = switchScopeFor(next, scopes);
    if (next === showing.scope) renderHeader();
    else show(threadOf(next));
  }

  function renderHeader(): void {
    setEntryIcon(scopeIcon, entryIconAt(showing.scope, "directory"));
    scopeName.textContent = folderTitle(showing.scope);
    if (showing.scope) scopeLabel.dataset.tooltip = showing.scope;
    else delete scopeLabel.dataset.tooltip;
    switchButton.hidden = elsewhere === undefined;
    if (elsewhere !== undefined) {
      switchName.textContent = folderTitle(elsewhere);
      switchButton.setAttribute("aria-label", `Switch to ${folderTitle(elsewhere)}`);
      switchButton.dataset.tooltip = `Switch to ${folderTitle(elsewhere)}`;
    }
    syncNewChat();
  }

  // Nothing to start over in an empty chat, nor while a reply is on its way.
  function syncNewChat(): void {
    newChatButton.disabled = input.disabled || showing.transcript.childElementCount === 0;
  }

  switchButton.addEventListener("click", () => {
    if (elsewhere === undefined) return;
    show(threadOf(elsewhere));
    follow();
  });

  // A turn still bound to the old chat lands there, out of sight.
  newChatButton.addEventListener("click", () => {
    const fresh = newThread(showing.scope);
    threads.set(fresh.scope, fresh);
    show(fresh);
    input.focus();
  });

  function append(thread: Thread, el: HTMLElement): void {
    thread.transcript.appendChild(el);
    arrive(el);
    if (thread === showing) glideToEnd();
    syncNewChat();
  }

  // The glide's clock is an animation with no keyframes, so the browser eases
  // its progress on the same curve CSS would. A wheel or a press on the
  // transcript stops it, so it never fights the writer's own scrolling.
  function glideToEnd(): void {
    stopGlide();
    const from = messages.scrollTop;
    const to = messages.scrollHeight - messages.clientHeight;
    const canGlide =
      typeof messages.animate === "function" && !window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!canGlide || to - from < 1) {
      messages.scrollTop = messages.scrollHeight;
      return;
    }
    const run = { clock: messages.animate([], GLIDE), to, frame: 0 };
    const step = (): void => {
      const progress = run.clock.effect?.getComputedTiming().progress ?? 1;
      messages.scrollTop = from + (to - from) * progress;
      if (run.clock.playState === "running") run.frame = requestAnimationFrame(step);
      else if (glide === run) glide = undefined;
    };
    glide = run;
    run.frame = requestAnimationFrame(step);
  }

  function stopGlide(): void {
    if (!glide) return;
    cancelAnimationFrame(glide.frame);
    glide.clock.cancel();
    glide = undefined;
  }

  messages.addEventListener("wheel", stopGlide, { passive: true });
  messages.addEventListener("pointerdown", stopGlide);

  // A link in a reply opens in a new tab, and shows its file while the
  // pointer rests on it, the rest of the chat muted. A path ending in `/`
  // names a folder, as a link writes one.
  const openBeside = (path: string) =>
    void (path.endsWith("/") ? deps.tabs.openFolder(path.slice(0, -1), true) : deps.tabs.openEntryBeside(path));
  messages.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-space-path]") : null;
    if (!link) return;
    event.preventDefault();
    openBeside(link.dataset.spacePath ?? "");
  });
  // A right-click on a link puts the link's menu above the text menu's
  // items, so it is left uncancelled for the text menu to open.
  messages.addEventListener("contextmenu", (event) => {
    const link = event.target instanceof Element ? event.target.closest<HTMLElement>("a[data-space-path]") : null;
    const path = link?.dataset.spacePath;
    if (path) leadTextMenu(event, { menu: CHAT_LINK_MENU, arg: linkedEntry(path), ariaLabel: "Link actions" });
  });
  installLinkPreview(messages, {
    loadFile: deps.loadFile,
    readingResolvers,
    formats: deps.formats,
    openPath: openBeside,
    openBeside,
    area: must<HTMLElement>("#assistant-chat"),
    runs: "left",
    contextMenu: deps.contextMenu,
    dialog: deps.dialog,
  });

  // A message plays its arrival only as it lands: the mark comes off once its
  // animations end or are cut short, so showing its chat again, which puts the
  // whole transcript back, doesn't replay them.
  function arrive(el: HTMLElement): void {
    el.classList.add("chat-arriving");
    const animations = el.getAnimations?.({ subtree: true }) ?? [];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      el.classList.remove("chat-arriving");
    });
  }

  // The assistant's replies are model-generated markdown, rendered through
  // the same renderer reading view uses, minus frontmatter handling; the
  // user's own turns stay plain text. A reply's paths are read as from a
  // document at the space root, since that is how the copilot is handed each
  // file's link to copy (chatHandler.ts): change one and the other breaks.
  //
  // `need`, on a failed turn's message, is the setting that fixes it.
  function appendMessage(thread: Thread, message: ChatMessage, need?: SetupNeed): void {
    const el = document.createElement("div");
    el.className = message.role === "assistant" ? "card prose chat-message assistant" : `chat-message ${message.role}`;
    if (message.role === "assistant") {
      const fragment = renderMarkdownInline(message.content, readingResolversIn(""));
      addCodeBlockCopyButtons(fragment);
      el.append(fragment, ...settingLinks(need));
    } else {
      el.textContent = message.content;
    }
    append(thread, el);
  }

  // Shared by the confirm cards below, whose buttons are identical but for
  // their label.
  function confirmButton(label: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "btn";
    node.textContent = label;
    return node;
  }

  // Appends a parenthetical to the chat's last assistant turn, rather than
  // pushing a fresh synthetic user turn (which would leave two user turns in
  // a row). This is how the copilot learns, on its next reply, whether the
  // proposal it just made was accepted — without it, a vibe-coding
  // back-and-forth would keep re-proposing against stale content.
  function noteProposalOutcome(thread: Thread, note: string): void {
    const last = thread.history[thread.history.length - 1];
    if (last?.role !== "assistant") return;
    thread.history = [...thread.history.slice(0, -1), { role: "assistant", content: `${last.content}\n\n${note}` }];
  }

  // Rendered when the copilot calls propose_create_document — nothing is
  // created until the writer clicks Create. When the proposal carries
  // `content` (scaffolding an applet), the card also shows it as an
  // all-add diff so the writer reviews the code before committing.
  function appendCreateConfirmCard(thread: Thread, proposed: NonNullable<ChatResponse["proposedDocument"]>): void {
    const displayPath = joinSpacePath(proposed.parentPath, proposed.name);
    const kind = proposed.type === "directory" ? "folder" : "file";

    const el = document.createElement("div");
    el.className = "card chat-message confirm";

    const label = document.createElement("div");
    label.append(`Create ${kind} `, named(displayPath, "?"));
    el.appendChild(label);

    if (proposed.type === "file" && proposed.content) {
      el.appendChild(renderLineDiff(diffLines("", proposed.content)));
    }

    const actions = document.createElement("div");
    actions.className = "chat-confirm-actions";

    const acceptButton = confirmButton("Create");

    const rejectButton = confirmButton("Don't create");

    acceptButton.addEventListener("click", () => {
      void (async () => {
        acceptButton.disabled = true;
        rejectButton.disabled = true;
        try {
          const created = await postCreateEntry(
            proposed.parentPath,
            proposed.name,
            proposed.type,
            proposed.type === "file" ? proposed.content : undefined,
          );
          await deps.revealCreatedEntry(created);
          label.replaceChildren("Created ", named(created.path, "."));
          actions.remove();
          noteProposalOutcome(thread, `(The writer created "${created.path}".)`);
        } catch (error) {
          acceptButton.disabled = false;
          rejectButton.disabled = false;
          window.alert(error instanceof Error ? error.message : `Failed to create ${kind}.`);
        }
      })();
    });

    rejectButton.addEventListener("click", () => {
      label.replaceChildren("Not created: ", named(displayPath, "."));
      actions.remove();
      noteProposalOutcome(thread, `(The writer declined creating "${displayPath}".)`);
    });

    actions.appendChild(acceptButton);
    actions.appendChild(rejectButton);
    el.appendChild(actions);

    append(thread, el);
  }

  // Rendered for a copilot edit to a file that isn't on screen — the edit
  // counterpart to the create confirm card. Nothing is written until the
  // writer clicks Apply, which then goes through the same /api/file PUT an
  // ordinary save uses, and opens the file so the result is visible.
  function appendEditConfirmCard(thread: Thread, proposed: { path: string; before: string; newContent: string }): void {
    const el = document.createElement("div");
    el.className = "card chat-message confirm";

    const label = document.createElement("div");
    label.append("Apply this edit to ", named(proposed.path, "?"));
    el.appendChild(label);

    el.appendChild(renderLineDiff(diffLines(proposed.before, proposed.newContent)));

    const actions = document.createElement("div");
    actions.className = "chat-confirm-actions";

    const acceptButton = confirmButton("Apply");

    const rejectButton = confirmButton("Don't apply");

    acceptButton.addEventListener("click", () => {
      void (async () => {
        acceptButton.disabled = true;
        rejectButton.disabled = true;
        try {
          await putFile(proposed.path, proposed.newContent, undefined, { source: "copilot" });
          label.replaceChildren("Applied edit to ", named(proposed.path, "."));
          actions.remove();
          noteProposalOutcome(
            thread,
            `(The writer applied this edit — "${proposed.path}" is now saved with the new contents.)`,
          );
          await deps.tabs.openSpacePath(proposed.path);
        } catch (error) {
          acceptButton.disabled = false;
          rejectButton.disabled = false;
          window.alert(error instanceof Error ? error.message : "Failed to apply the edit.");
        }
      })();
    });

    rejectButton.addEventListener("click", () => {
      label.replaceChildren("Edit not applied: ", named(proposed.path, "."));
      actions.remove();
      noteProposalOutcome(thread, `(The writer declined the proposed edit to "${proposed.path}".)`);
    });

    actions.appendChild(acceptButton);
    actions.appendChild(rejectButton);
    el.appendChild(actions);

    append(thread, el);
  }

  // What the writer made of an inline proposal, for the card and for the
  // model's next turn. A replaced one says nothing to the model: the newer
  // proposal's own card speaks for that document now.
  function describeOutcome(path: string, outcome: ProposalOutcome): { label: Sentence; note?: string } {
    if (outcome.replaced) return { label: ["Replaced by a newer proposal for ", named(path, ".")] };
    const { accepted, rejected, dropped } = outcome;
    const total = accepted + rejected + dropped;
    const overrun = dropped ? ` ${dropped} ran into the writer's own edits and were dropped.` : "";
    if (accepted === total) {
      return {
        label: ["Applied the proposed changes to ", named(path, ".")],
        note: `(The writer accepted every proposed change to "${path}".)`,
      };
    }
    if (accepted === 0 && dropped === 0) {
      return {
        label: ["Proposed changes to ", named(path), " not applied."],
        note: `(The writer rejected the proposed changes to "${path}".)`,
      };
    }
    return {
      label: [`Applied ${accepted} of ${total} proposed changes to `, named(path, "."), overrun],
      note: `(The writer applied ${accepted} of the ${total} proposed changes to "${path}" and rejected ${rejected}.${overrun})`,
    };
  }

  // The copilot's edit to a document on screen, the focused one or the one
  // beside it, drawn over it in the editor where each change is decided.
  // When that document has left the screen since the turn was sent, it falls
  // back to the confirm card.
  function appendInlineProposal(thread: Thread, edit: ProposedFileEdit): void {
    const el = document.createElement("div");
    el.className = "card chat-message confirm";
    const label = document.createElement("div");
    el.appendChild(label);

    const shown = deps.proposeEdit(edit, (outcome) => {
      const { label: text, note } = describeOutcome(edit.path, outcome);
      label.replaceChildren(...text);
      if (note) noteProposalOutcome(thread, note);
    });
    if (shown === undefined) {
      appendEditConfirmCard(thread, edit);
      return;
    }
    if (shown === 0) label.append("Nothing to change in ", named(edit.path, ":"), " the proposed text matches it.");
    else label.append(...proposedChanges(shown, edit.path));
    append(thread, el);
  }

  function proposedChanges(shown: number, path: string): Sentence {
    return [`${countText(shown, "proposed change")} to `, named(path, ","), " shown in the editor."];
  }

  // A card with no decision left in it: what happened, said once. Its words
  // sit in one block, as a card's label does, or the card's column would set
  // a path label on a line of its own.
  function appendNote(thread: Thread, ...sentence: Sentence): void {
    const el = document.createElement("div");
    el.className = "card chat-message confirm";
    const text = document.createElement("div");
    text.append(...sentence);
    el.appendChild(text);
    append(thread, el);
  }

  // The sentence wrapped whole: the card lays its children out as a column,
  // so a path chip left loose would break the line.
  function appendFailure(thread: Thread, ...sentence: Sentence): void {
    const el = document.createElement("div");
    el.className = "inline-error";
    el.setAttribute("role", "alert");
    const text = document.createElement("div");
    text.className = "inline-error-message";
    text.append(...sentence);
    el.appendChild(text);
    append(thread, el);
  }

  // A change Editing applied as the reply arrived: what it did, its diff when
  // there is one, and an Undo. An Undo that can't be done says why in place
  // of its button; one that fails outright, or that the writer called off,
  // leaves the button to try again.
  function appendAppliedCard(
    thread: Thread,
    text: Sentence,
    diff: HTMLElement | undefined,
    undo: () => Promise<Sentence | undefined>,
  ): void {
    const el = document.createElement("div");
    el.className = "card chat-message confirm";
    const label = document.createElement("div");
    label.append(...text);
    el.appendChild(label);
    if (diff) el.appendChild(diff);
    const actions = document.createElement("div");
    actions.className = "chat-confirm-actions";
    const undoButton = confirmButton("Undo");
    undoButton.addEventListener("click", () => {
      void (async () => {
        undoButton.disabled = true;
        try {
          const outcome = await undo();
          if (outcome === undefined) {
            undoButton.disabled = false;
            return;
          }
          label.replaceChildren(...outcome);
          actions.remove();
        } catch (error) {
          undoButton.disabled = false;
          window.alert(error instanceof Error ? error.message : "Undo failed.");
        }
      })();
    });
    actions.appendChild(undoButton);
    el.appendChild(actions);
    append(thread, el);
  }

  // Editing: the copilot's edit to a document on screen lands at once, as
  // one edit the editor's own undo reverts too. A document that has left the
  // screen is written as a file instead; a read-only one keeps the edit as a
  // proposal, decided as any other.
  async function applyInlineEdit(thread: Thread, edit: ProposedFileEdit): Promise<void> {
    let applying = true;
    let applied: ProposalOutcome | undefined;
    const el = document.createElement("div");
    el.className = "card chat-message confirm";
    const label = document.createElement("div");
    el.appendChild(label);
    const shown = deps.proposeEdit(
      edit,
      (outcome) => {
        if (applying) {
          applied = outcome;
          return;
        }
        const { label: text, note } = describeOutcome(edit.path, outcome);
        label.replaceChildren(...text);
        if (note) noteProposalOutcome(thread, note);
      },
      true,
    );
    applying = false;
    if (shown === undefined) return applyFileEdit(thread, edit);
    if (shown === 0) {
      return appendNote(thread, "Nothing to change in ", named(edit.path, ":"), " the copilot's text matches it.");
    }
    if (!applied) {
      label.append(...proposedChanges(shown, edit.path));
      append(thread, el);
      return;
    }
    const { accepted, dropped } = applied;
    if (dropped) {
      noteProposalOutcome(
        thread,
        `(${dropped} of your changes to "${edit.path}" ran into the writer's own edits and weren't applied.)`,
      );
    }
    appendAppliedCard(
      thread,
      dropped
        ? [
            `Applied ${accepted} of ${accepted + dropped} changes to `,
            named(edit.path, "."),
            " The rest ran into your own edits.",
          ]
        : [`Applied ${accepted === 1 ? "1 change" : `${accepted} changes`} to `, named(edit.path, ".")],
      undefined,
      () => undoInlineEdit(thread, edit),
    );
  }

  // Applies the reverse of the copilot's edit the way the edit was applied,
  // opening the document first if it has left the screen, so a change the
  // writer has since edited over stays theirs.
  async function undoInlineEdit(thread: Thread, edit: ProposedFileEdit): Promise<Sentence> {
    const reverse = { ...edit, before: edit.newContent, newContent: edit.before };
    let outcome: ProposalOutcome | undefined;
    const settle = (settled: ProposalOutcome) => {
      outcome ??= settled;
    };
    let shown = deps.proposeEdit(reverse, settle, true);
    if (shown === undefined) {
      await deps.tabs.openSpacePath(edit.path);
      shown = deps.proposeEdit(reverse, settle, true);
    }
    if (shown === undefined) return ["Not undone: ", named(edit.path), " couldn't be opened."];
    if (shown === 0) return ["Nothing left to undo in ", named(edit.path, ".")];
    if (!outcome) return ["The undo is shown in ", named(edit.path), " for you to accept."];
    noteProposalOutcome(thread, `(The writer undid your changes to "${edit.path}".)`);
    return outcome.dropped
      ? [
          `Undid ${outcome.accepted} of ${outcome.accepted + outcome.dropped} changes. The rest ran into your own edits.`,
        ]
      : ["Undid the changes to ", named(edit.path, ".")];
  }

  // Editing: a file that isn't open is written at once, based on the
  // revision the copilot read, so one changed since is refused rather than
  // overwritten. Undo writes the old text back on the same terms.
  async function applyFileEdit(thread: Thread, edit: ProposedFileEdit): Promise<void> {
    let revision: string;
    try {
      ({ revision } = await putFile(edit.path, edit.newContent, edit.revision, { source: "copilot" }));
    } catch (error) {
      const reason =
        error instanceof SaveConflictError
          ? "it changed after the copilot read it"
          : error instanceof Error
            ? error.message
            : "the write failed";
      noteProposalOutcome(thread, `(Your edit to "${edit.path}" wasn't applied: ${reason}.)`);
      return appendFailure(thread, "The edit to ", named(edit.path), ` wasn't applied: ${reason}.`);
    }
    appendAppliedCard(
      thread,
      ["Edited ", named(edit.path, ".")],
      renderLineDiff(diffLines(edit.before, edit.newContent)),
      async () => {
        try {
          await putFile(edit.path, edit.before, revision);
        } catch (error) {
          if (error instanceof SaveConflictError) {
            return ["Not undone: ", named(edit.path), " has changed since this edit."];
          }
          throw error;
        }
        noteProposalOutcome(thread, `(The writer undid your edit to "${edit.path}".)`);
        return ["Undid the edit to ", named(edit.path, ".")];
      },
    );
  }

  // Editing: a new entry is created at once and opened as a hand-made one
  // is. Undo moves it to the Trash, so nothing the writer added to it since
  // is lost for good.
  async function applyCreate(thread: Thread, proposed: NonNullable<ChatResponse["proposedDocument"]>): Promise<void> {
    const displayPath = joinSpacePath(proposed.parentPath, proposed.name);
    let created: CreateEntryResponse;
    try {
      created = await postCreateEntry(
        proposed.parentPath,
        proposed.name,
        proposed.type,
        proposed.type === "file" ? proposed.content : undefined,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "the create failed";
      noteProposalOutcome(thread, `("${displayPath}" wasn't created: ${reason}.)`);
      return appendFailure(thread, named(displayPath), ` wasn't created: ${reason}.`);
    }
    const diff =
      proposed.type === "file" && proposed.content ? renderLineDiff(diffLines("", proposed.content)) : undefined;
    appendAppliedCard(thread, ["Created ", named(created.path, ".")], diff, async () => {
      const trashed = await deps.trashEntry(created.path);
      if (!trashed) return undefined;
      noteProposalOutcome(thread, `(The writer undid creating "${created.path}"; it's in the Trash.)`);
      const unpublished = trashed.unpublishNote ? [` ${trashed.unpublishNote}`] : [];
      return ["Moved ", named(created.path), " to the Trash.", ...unpublished];
    });
    await deps.revealCreatedEntry(created);
  }

  // A reply takes a few seconds — this bubble stands in for it in the
  // meantime, in the same spot the real reply will land, so waiting reads
  // as "the assistant is about to answer" rather than a stalled UI.
  function appendTypingIndicator(thread: Thread): HTMLElement {
    const el = document.createElement("div");
    el.className = "chat-message assistant typing-indicator";
    el.innerHTML = "<span></span><span></span><span></span>";
    append(thread, el);
    buildUpJuggle(el);
    return el;
  }

  async function send(): Promise<void> {
    const { focused, beside } = deps.screen();
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    input.disabled = true;
    syncSendButton();

    const thread = showing;
    const historyBeforeThisTurn = thread.history;
    appendMessage(thread, { role: "user", content: text });
    thread.history = [...thread.history, { role: "user", content: text }];

    // Removed as soon as either branch below has something real to show in
    // its place, rather than in `finally`, which would leave it showing
    // alongside the real reply until the whole turn had settled.
    const typingIndicator = appendTypingIndicator(thread);

    try {
      await deps.flushPendingSave();
      const pick = deps.chatPick.request();
      const { reply, currentDocumentEdit, proposedDocument, proposedEdit, lookedAt } = await postChat(
        focused,
        historyBeforeThisTurn,
        text,
        pick,
        beside,
      );
      typingIndicator.remove();
      appendMessage(thread, { role: "assistant", content: reply });
      thread.history = [...thread.history, { role: "assistant", content: reply }];
      // Each image it looked at went to the model, which the writer is told.
      if (lookedAt) appendNote(thread, lookedAtRow(lookedAt));
      // The mode the turn was sent in, not the chip's now: the model was told
      // its changes were made, so they're applied even if the chip moved. An
      // edit to another file goes over it in the editor while it's on screen.
      if (pick.mode === "editing") {
        if (currentDocumentEdit) await applyInlineEdit(thread, currentDocumentEdit);
        if (proposedDocument) await applyCreate(thread, proposedDocument);
        if (proposedEdit) await applyInlineEdit(thread, proposedEdit);
      } else {
        if (currentDocumentEdit) appendInlineProposal(thread, currentDocumentEdit);
        if (proposedDocument) appendCreateConfirmCard(thread, proposedDocument);
        if (proposedEdit) appendInlineProposal(thread, proposedEdit);
      }
    } catch (error) {
      typingIndicator.remove();
      const message = error instanceof Error ? error.message : "Chat request failed.";
      append(thread, createInlineError({ message, need: setupNeedOf(error) }));
    } finally {
      input.disabled = false;
      syncSendButton();
      syncNewChat();
      input.focus();
    }
  }

  function syncSendButton(): void {
    sendButton.disabled = input.disabled || input.value.trim() === "";
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  input.addEventListener("input", syncSendButton);
  // Enter sends and Shift+Enter breaks the line. A key that confirms an IME
  // composition is the composition's, not a send.
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  // The box is the field, so a click on its empty space lands in the text.
  form.addEventListener("click", (event) => {
    if (!(event.target instanceof Element) || !event.target.closest("button")) input.focus();
  });

  return { follow };
}
