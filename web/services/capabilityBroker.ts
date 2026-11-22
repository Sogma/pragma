// The sandbox broker's client half: the first-use permission prompt, the
// one-at-a-time chain for a surface's broker dialogs, the Permissions panel
// that revokes, and the dispatcher that routes a frame's requests and posts
// each reply.
//
// One instance per surface — a flow view, the toolkit runner — so its chain
// and open dialog belong to that surface, never to a global active document.

import { localDay, localDayAfter, parseLocalDay } from "../../src/protocol/localDay.ts";
import { basenameOf, isLibraryPath } from "../../src/protocol/rootedPath.ts";
import type { SandboxKind } from "../core/apiClient.ts";
import { type EntryIcon, folderTitle, stripExtension, treePath } from "../core/paths.ts";
import { pathNames } from "../core/spaceTree.ts";
import { dateLabel } from "../lib/dateText.ts";
import { type Disposable, listen } from "../lib/disposable.ts";
import { el } from "../lib/dom.ts";
import { createPathLabel } from "../lib/pathLabel.ts";
import type { DialogHandle, DialogService } from "./dialog.ts";
import type { ContextMenuService, MenuItem } from "./menus.ts";

// One declared capability as the broker sees it: the grant key, and the
// type, target, and description the prompt text is built from.
export interface BrokerCapability {
  key: string;
  type: string;
  path?: string;
  description?: string;
}

// The document a broker instance acts for.
export interface BrokerSubject {
  readonly kind: SandboxKind;
  readonly path: string;
  // The document's own name, the subject of every prompt; empty falls back
  // to its file name (subjectName), as the editor's title does.
  readonly name: string;
  // Declared capabilities, read fresh each time: a flow's follow its graph.
  capabilities(): BrokerCapability[];
  // Grown in place as the writer approves prompts this session.
  readonly grantedCapabilities: Set<string>;
  // A Flow's leave to run with nobody watching, which the Permissions panel
  // shows beside its capabilities. Absent for a kind that has no such run.
  readonly unattended?: UnattendedGrant;
}

export interface UnattendedGrant {
  granted: boolean;
  // The last day it was given, `YYYY-MM-DD`, passed or not. Absent for a
  // leave given until revoked, and for none.
  until?: string;
  // `until` absent grants it until revoked.
  set(allowed: boolean, until?: string): Promise<void>;
}

// How long Allow can let a flow run unattended, in days, ahead of Until
// revoked.
const UNATTENDED_DAYS = [1, 30, 90];

// A last day that doesn't parse shows as stored.
const dayLabel = (day: string): string => {
  const date = parseLocalDay(day);
  return date ? dateLabel(date) : day;
};

export function subjectName(subject: Pick<BrokerSubject, "name" | "path">): string {
  return subject.name.trim() || stripExtension(basenameOf(subject.path));
}

// A path as the tree spells it: a space file without the `space:` its key
// carries, a library's with its `lib:` as the one thing marking its root.
const shown = (path: string | undefined): string | undefined => (path === undefined ? undefined : treePath(path));

// A root's path is empty, so it is named as the status bar names it.
const rootTitle = (path: string | undefined): string | undefined =>
  path !== undefined && treePath(path) === "" ? folderTitle(path) : undefined;

// What each capability asks for, in the writer's terms: the words after
// "Grant permission to". A path it names goes on the line below. A kind adds
// its vocabulary here, not a prompt of its own.
const PROMPT_ACTIONS: Record<string, string> = {
  readFile: "read",
  writeDocument: "write",
  generateText: "run an AI generation",
  readCurrentDocument: "read the currently open document",
  searchContext: "send files to an AI model from",
  generateImage: "Generate Image in",
  generateVideo: "Generate Video in",
};

// A paragraph after the prompt's sentence, for a kind that spends credits or
// sends files out. Which provider gets them isn't known when the grant is
// asked (a wired model picks it), and each keeps them on its own terms, so
// the writer is pointed at those terms.
const GENERATION_NOTE =
  "Each generation consumes AI credits. Images are sent to the model provider for processing. Each provider handles them according to its own data retention and privacy policies. Review the provider's terms before sending sensitive or confidential images.";
const CONTEXT_NOTE =
  "Each run sends the model provider this folder's AGENTS.md, the README nearest the connected document and the notes that document names. The model may also search the folder and read any other file in it. Private files are never sent.";
const PROMPT_NOTES: Record<string, string> = {
  generateImage: GENERATION_NOTE,
  generateVideo: GENERATION_NOTE,
  searchContext: CONTEXT_NOTE,
};

// The Permissions panel's row labels. The panel's title names the document,
// so a row is only the verb; the target follows it, muted. The prompt keeps
// PROMPT_ACTIONS' full sentence, since it stands alone.
const ROW_ACTIONS: Record<string, string> = {
  readFile: "Read",
  writeDocument: "Write",
  generateText: "Generate with AI",
  readCurrentDocument: "Read the open document",
  searchContext: "Send files to AI from",
  generateImage: "Generate images into",
  generateVideo: "Generate videos into",
};

// A read of a library's file is named as one, not left to the path: a prompt
// is the one moment a person decides whether reaching outside the space is
// meant.
const readsLibrary = (capability: BrokerCapability): boolean =>
  capability.type === "readFile" && capability.path !== undefined && isLibraryPath(capability.path);

// The subject's icon before a prompt's or its Permissions' title, as the tree
// draws it: a Flow and an Applet can share a name.
function subjectIcon(subject: Pick<BrokerSubject, "path">): EntryIcon | undefined {
  const entry = pathNames.icon(treePath(subject.path), "file");
  return entry.glyph ? entry : undefined;
}

/** A grant's prompt: the subject asking in the title, after its icon. Then
 * the sentence, any path on a line of its own drawn as every path in running
 * text is, and any note as a paragraph of its own. */
export function capabilityPrompt(
  subject: Pick<BrokerSubject, "name" | "path">,
  capability: BrokerCapability,
): { title: string; icon?: EntryIcon; message: [HTMLElement, ...string[]] } {
  const action = readsLibrary(capability)
    ? "read from a library"
    : (PROMPT_ACTIONS[capability.type] ?? capability.type);
  const description = capability.description ? ` (${capability.description})` : "";
  const message = document.createElement("span");
  const path = shown(capability.path);
  if (path === undefined) message.append(`Grant permission to ${action}${description}.`);
  else {
    message.append(
      `Grant permission to ${action}:`,
      document.createElement("br"),
      rootTitle(capability.path) ?? createPathLabel(path, pathNames),
      description,
    );
  }
  const note = PROMPT_NOTES[capability.type];
  return {
    title: `${subjectName(subject)} needs permission`,
    icon: subjectIcon(subject),
    message: note ? [message, note] : [message],
  };
}

// The consent half of the sandbox client (apiClient.ts), kind-first.
export interface SandboxGrantClient {
  grant(kind: SandboxKind, path: string, capabilityKey: string): Promise<void>;
  revoke(kind: SandboxKind, path: string, capabilityKey: string): Promise<void>;
}

export interface CapabilityBrokerDeps extends SandboxGrantClient {
  dialog: DialogService;
  // For the Permissions panel's menu of how long to allow unattended runs.
  contextMenu: ContextMenuService;
}

export interface CapabilityBroker {
  // Binds the broker to a document, closing whatever the previous one had
  // open; `host` scopes its dialogs to that element (none: top level).
  mount(subject: BrokerSubject, host?: HTMLElement): void;
  unmount(): void;
  current(): BrokerSubject | undefined;
  // Lazy, first-use consent: true at once when granted; otherwise prompts in
  // turn and resolves false — never rejects — on Deny or when the subject
  // moved on meanwhile. A failed grant shows in the dialog and leaves it open.
  // `subject` defaults to the current one.
  //
  // `consented` skips the prompt for a capability the writer already granted
  // by a physical act naming that exact target (dragging a file onto a
  // canvas — docs/protocol.md, Permission model); it still writes a normal,
  // revocable grant.
  ensure(capability: BrokerCapability, subject?: BrokerSubject, consented?: boolean): Promise<boolean>;
  // Any other dialog of the surface, on the same chain, so no two ever
  // show at once. The shown dialog should be passed to `track`.
  queue<T>(show: () => Promise<T>): Promise<T>;
  // Registers a dialog of this surface: unmount and the next prompt close it.
  track(handle: DialogHandle): void;
  closeDialogs(): void;
  // The revocation panel: every declared capability, granted or not.
  showPermissions(): void;
  dispose(): void;
}

export function createCapabilityBroker(deps: CapabilityBrokerDeps): CapabilityBroker {
  let subject: BrokerSubject | undefined;
  let host: HTMLElement | undefined;
  let chain: Promise<void> = Promise.resolve();
  let openDialog: DialogHandle | undefined;
  // Settles when the Permissions panel closes; a queued prompt waits for
  // it rather than replacing it, since opening the panel while prompts
  // are queued is exactly when the writer wants to see what's granted.
  let panelClosed: Promise<void> = Promise.resolve();

  function closeDialogs(): void {
    openDialog?.close();
    openDialog = undefined;
  }

  function track(handle: DialogHandle): void {
    openDialog = handle;
  }

  function queue<T>(show: () => Promise<T>): Promise<T> {
    const result = chain.then(show);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // Writes the grant down. Reached only from a human act — the prompt's
  // Allow, or a `consented` caller naming the same target the writer just
  // pointed at — never from a document asking on its own behalf.
  async function record(target: BrokerSubject, capability: BrokerCapability): Promise<void> {
    await deps.grant(target.kind, target.path, capability.key);
    target.grantedCapabilities.add(capability.key);
  }

  // Grants are lazy and first-use, never bulk or install-time: this is only
  // reached the moment a document tries to use a capability it doesn't hold.
  function ensure(
    capability: BrokerCapability,
    target: BrokerSubject | undefined = subject,
    consented = false,
  ): Promise<boolean> {
    if (!target) return Promise.resolve(false);
    if (target.grantedCapabilities.has(capability.key)) return Promise.resolve(true);
    // No dialog and no queue: there is no question to serialize behind the
    // surface's other prompts, and a failure just leaves it ungranted — the
    // next read asks normally.
    if (consented) {
      return record(target, capability).then(
        () => true,
        () => false,
      );
    }
    return queue(async () => {
      await panelClosed;
      if (subject !== target) return false;
      // Granted while this waited its turn — two nodes asking for the same
      // read at once prompt once, not twice.
      if (target.grantedCapabilities.has(capability.key)) return true;
      closeDialogs();
      return deps.dialog.confirm({
        host,
        ...capabilityPrompt(target, capability),
        confirmLabel: "Allow",
        cancelLabel: "Deny",
        danger: true,
        failureMessage: "Failed to grant capability.",
        onOpen: track,
        action: () => record(target, capability),
      });
    });
  }

  // A row's button sits in a .dialog-actions, as the prompt's do, so it
  // lines up at the row's end.
  function actionsFor(button: HTMLButtonElement): HTMLElement {
    const actions = el("div", "dialog-actions");
    actions.append(button);
    return actions;
  }

  // A row's text: the label, with a muted target when there is one, over an
  // optional quiet second line. A description is written to follow a prompt's
  // sentence in parentheses, so a line of its own capitalizes it.
  function rowText(label: string, target?: string, description?: string): HTMLElement {
    const text = el("div", "field-row-text");
    const title = el("div", "field-row-title");
    title.textContent = label;
    if (target) {
      const muted = el("span", "permission-target");
      muted.textContent = target;
      title.append(" ", muted);
    }
    text.append(title);
    if (description) {
      const detail = el("div", "field-row-description");
      detail.textContent = description.charAt(0).toUpperCase() + description.slice(1);
      text.append(detail);
    }
    return text;
  }

  // Lists every declared capability, not just the granted ones — an
  // ungranted one shows "Not granted" with nothing to revoke, so the panel
  // is the full picture of what the document could ask for. It has no Allow:
  // a capability is granted only when a run asks for it.
  function renderPermissions(target: BrokerSubject, list: HTMLElement, error: HTMLElement): void {
    list.replaceChildren();
    for (const capability of target.capabilities()) {
      const row = el("div", "field-row");
      row.append(
        rowText(
          readsLibrary(capability) ? "Read from a library" : (ROW_ACTIONS[capability.type] ?? capability.type),
          rootTitle(capability.path) ?? shown(capability.path),
          capability.description,
        ),
      );
      if (target.grantedCapabilities.has(capability.key)) {
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "btn btn-large";
        revoke.textContent = "Revoke";
        revoke.addEventListener("click", () => {
          void (async () => {
            revoke.disabled = true;
            error.hidden = true;
            try {
              await deps.revoke(target.kind, target.path, capability.key);
              target.grantedCapabilities.delete(capability.key);
              if (subject === target) renderPermissions(target, list, error);
            } catch (thrown) {
              revoke.disabled = false;
              error.textContent = thrown instanceof Error ? thrown.message : "Failed to revoke capability.";
              error.hidden = false;
            }
          })();
        });
        row.append(actionsFor(revoke));
      } else {
        const status = el("span", "field-row-value");
        status.textContent = "Not granted";
        status.dataset.tooltip = "Asked the first time it's needed";
        row.append(status);
      }
      list.append(row);
    }
    if (target.unattended) list.append(unattendedRow(target, target.unattended, list, error));
  }

  // Granted here and nowhere else: the one place a person is looking at what
  // this Flow does, rather than a global switch blessing every Flow at once.
  function unattendedRow(
    target: BrokerSubject,
    grant: UnattendedGrant,
    list: HTMLElement,
    error: HTMLElement,
  ): HTMLElement {
    // Set apart from the capabilities: it is not something a run may touch
    // but whether one may start at all.
    const row = el("div", "field-row permission-standing");
    // Checked against the clock here too, so a panel opened after the last
    // day says so without the file being read again.
    const allowed = grant.granted && (grant.until === undefined || grant.until >= localDay(new Date()));
    const ending = grant.until === undefined ? undefined : `${allowed ? "until" : "expired"} ${dayLabel(grant.until)}`;
    const label = rowText("Run unattended", ending, "Lets the agent API start this flow when nobody is watching.");
    const date = label.querySelector<HTMLElement>(".permission-target");
    if (date && allowed) date.dataset.tooltip = "Through the end of that day";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-large";

    async function change(allow: boolean, until?: string): Promise<void> {
      button.disabled = true;
      error.hidden = true;
      // The row is drawn again with a new button; focus moves to it rather
      // than falling out of the dialog.
      const refocus = row.contains(document.activeElement);
      try {
        await grant.set(allow, until);
        grant.granted = allow;
        grant.until = allow ? until : undefined;
        if (subject !== target) return;
        renderPermissions(target, list, error);
        if (refocus) list.querySelector<HTMLElement>(".permission-standing button")?.focus();
      } catch (thrown) {
        button.disabled = false;
        error.textContent = thrown instanceof Error ? thrown.message : "Failed to change unattended runs.";
        error.hidden = false;
      }
    }

    // Styled as the first-use prompt's pair: Allow is its danger grant, Revoke
    // its plain Deny, so the same act looks the same in both places.
    if (allowed) {
      button.textContent = "Revoke";
      button.addEventListener("click", () => void change(false));
    } else {
      button.className = "btn btn-large dialog-primary danger permission-allow";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      const chevron = el("span", "picker-chevron");
      chevron.setAttribute("aria-hidden", "true");
      button.append("Allow", chevron);
      button.addEventListener("click", () => {
        if (deps.contextMenu.isOpen(button)) {
          deps.contextMenu.close();
          return;
        }
        const now = new Date();
        const items: MenuItem[] = [
          { label: "Allow for" },
          ...UNATTENDED_DAYS.map((days) => {
            const until = localDayAfter(now, days);
            return {
              label: days === 1 ? "1 day" : `${days} days`,
              detail: `until ${dayLabel(until)}`,
              run: () => change(true, until),
            };
          }),
          { label: "Until revoked", group: "revoked", run: () => change(true) },
        ];
        deps.contextMenu.open({ anchor: button, align: "end", ariaLabel: "Allow for", items });
      });
    }
    row.append(label, actionsFor(button));
    return row;
  }

  return {
    mount(next, nextHost) {
      closeDialogs(); // a pending dialog of what was open before must not resolve into this one
      subject = next;
      host = nextHost;
    },
    unmount() {
      closeDialogs();
      subject = undefined;
      host = undefined;
    },
    current: () => subject,
    ensure,
    queue,
    track,
    closeDialogs,
    showPermissions() {
      if (!subject) return;
      const target = subject;
      closeDialogs();
      const content = el("div", "dialog-body");
      const list = el("div", "permissions-list");
      const error = el("div", "inline-error");
      error.hidden = true;
      content.append(list, error);
      renderPermissions(target, list, error);
      const handle = deps.dialog.open({
        host,
        title: `Permissions: ${subjectName(target)}`,
        icon: subjectIcon(target),
        content,
        className: "dialog-wide",
        // The dialog's Escape outranks a menu's, so the Allow menu open over
        // the panel is closed here, not the panel under it.
        onEscape: () => {
          if (!deps.contextMenu.isOpen()) return false;
          deps.contextMenu.close();
          return true;
        },
      });
      track(handle);
      panelClosed = handle.closed;
    },
    dispose() {
      closeDialogs();
      subject = undefined;
    },
  };
}

// A request a frame posts. Everything with a requestId gets a reply; the
// rest are notices (an applet's resize).
export interface FrameRequest {
  source?: string;
  type?: string;
  requestId?: number;
  [field: string]: unknown;
}

// A handler's return value is posted back as the reply; a throw is posted
// as its error.
export type FrameHandlers = Record<string, (data: FrameRequest) => Promise<unknown>>;

export interface FrameDispatchOptions {
  // Read per message: a surface replaces its frame on every mount.
  frame(): HTMLIFrameElement;
  // The injected client's `source` tag.
  source: string;
  handlers: FrameHandlers;
  onNotice?(data: FrameRequest): void;
}

// Routes each request the frame posts to its handler and posts the result,
// or the error, back to the window that asked. Scoped to messages from
// that exact frame, so an unrelated sender can't be mistaken for a broker
// request.
export function dispatchFrameRequests(options: FrameDispatchOptions): Disposable {
  return listen(window, "message", (event) => {
    const message = event as MessageEvent;
    if (!message.source || message.source !== options.frame().contentWindow) return;
    const data = message.data as FrameRequest | null;
    if (!data || typeof data !== "object" || data.source !== options.source) return;
    if (typeof data.requestId !== "number") {
      options.onNotice?.(data);
      return;
    }
    const requestId = data.requestId;
    const asker = message.source as Window;
    const respond = (result?: unknown, error?: string) => {
      asker.postMessage({ source: "pragma-host", requestId, result, error }, "*");
    };
    const type = typeof data.type === "string" ? data.type : "";
    const handler = Object.keys(options.handlers).includes(type) ? options.handlers[type] : undefined;
    void (async () => {
      try {
        if (!handler) throw new Error(`Unknown request type: ${String(data.type)}`);
        respond(await handler(data));
      } catch (error) {
        respond(undefined, error instanceof Error ? error.message : "Request failed");
      }
    })();
  });
}
