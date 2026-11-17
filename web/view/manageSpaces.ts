// Manage Spaces — the dialog's content: every registered space on the left
// (click to switch), and on the right, in the desktop app, the form that
// creates a space or opens a folder as one (spaceForm.ts); a browser, with no
// folder picker, says how the command line adds one. The dialog service owns
// the panel around this; this module owns what is in it.
import { type fetchSpaceList, postForgetSpace, postResetSpaceGrants, postSpaceLabel } from "../core/apiClient.ts";
import { DisposableStore } from "../lib/disposable.ts";
import { type ListItemTarget, locateSpaceCommand } from "../lib/listItemMenu.ts";
import { createSpaceForm, type SpaceFormBridge } from "../lib/spaceForm.ts";
import { createSpaceRow } from "../lib/spaceRow.ts";
import type { CommandRegistry } from "../services/commands.ts";
import type { DialogService } from "../services/dialog.ts";
import { COMMAND_PALETTE, type MenuRegistry } from "../services/menus.ts";
import type { SpaceTrust } from "./spaceTrust.ts";

// The Electron preload bridge's space half, when running in the desktop
// app; absent in the browser build, which has no native picker.
export interface SpaceLocationBridge extends SpaceFormBridge {
  // Repoints a registry entry at a moved folder, keeping its id. Resolves to
  // the chosen path, or undefined if the picker was cancelled.
  relocateSpace(id: string): Promise<string | undefined>;
}

export interface ManageSpacesDeps {
  fetchSpaceList(): ReturnType<typeof fetchSpaceList>;
  switchSpace(path: string): Promise<void>;
  // The row's "⋮" trigger, built by the caller so this module never reaches
  // for the context-menu service directly — the same seam the Websites and
  // Library accordions use.
  createMenuButton(label: string, target: ListItemTarget): HTMLButtonElement;
  bridge?: SpaceLocationBridge;
}

export interface ManageSpacesContent {
  element: HTMLElement;
  // The control to focus on open, where there is a form.
  initialFocus?: HTMLElement;
  // Re-reads the space list. Called after a ⋮ action changes the registry,
  // since those commands live outside this module.
  refresh(): Promise<void>;
  // Reports a failed ⋮ action in the panel's own error row. Those commands
  // are registered outside this module but have nowhere else to report: they
  // run from a context menu, which is gone by the time the call settles.
  showError(thrown: unknown, fallback: string): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// A browser can't pick a folder, and no route takes one, so a space is added
// on the computer Pragma runs on (docs/deployment.md).
function commandLineHint(): HTMLElement {
  const hint = el("p", "manage-spaces-hint");
  hint.append(
    "To add a space, run ",
    el("code", "", "pragma init"),
    " or ",
    el("code", "", "pragma space add"),
    " on the computer running Pragma.",
  );
  return hint;
}

export function createManageSpacesContent(deps: ManageSpacesDeps): ManageSpacesContent {
  const store = new DisposableStore();
  const element = el("div", "manage-spaces-main");

  const list = el("div", "manage-spaces-list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", "Your spaces");

  // The ⋮ actions report here; the form keeps its own messages.
  const detail = el("div", "manage-spaces-detail");
  const error = el("div", "inline-error manage-spaces-error");
  error.hidden = true;

  function showError(thrown: unknown, fallback: string): void {
    error.textContent = thrown instanceof Error ? thrown.message : fallback;
    error.hidden = false;
  }

  // Off: whoever has this open has a space already.
  const form = deps.bridge ? createSpaceForm(deps.bridge, { examples: false }) : undefined;
  if (form) store.add(form);
  detail.append(form ? form.element : commandLineHint(), error);
  element.append(list, detail);

  // Every registered space, alphabetically — never the switcher's recents
  // list. A space that has aged out of recents still holds approvals keyed
  // to its id, and this dialog is the only way to forget, rename, relocate
  // or reset one; listing recents here would put those spaces out of reach.
  //
  // The served space is marked and not clickable, and is merged in when it
  // has no registry entry of its own. Fetched fresh on every open so it
  // can't show a stale list after a switch made elsewhere.
  async function renderList(): Promise<void> {
    list.replaceChildren();
    try {
      const { current, spaces } = await deps.fetchSpaceList();
      const entries = spaces.some((space) => space.path === current.path) ? spaces : [current, ...spaces];
      for (const space of entries) {
        const isCurrent = space.path === current.path;
        // A space with no registry id can't be acted on — nothing to key
        // actions by — which in practice only happens for a served space the
        // config could not record.
        const menu = space.id
          ? deps.createMenuButton("Space options", {
              kind: "space",
              id: space.id,
              label: space.label || space.name,
              missing: space.missing === true,
              isCurrent,
              trusted: space.trusted === true,
            })
          : undefined;
        list.append(
          createSpaceRow({
            space,
            location: space.path,
            current: isCurrent,
            menu,
            open: () => void deps.switchSpace(space.path),
          }),
        );
      }
    } catch {
      list.append(el("div", "list-item-empty", "Failed to load spaces"));
    }
  }

  void renderList();
  return { element, initialFocus: form?.initialFocus, refresh: renderList, showError, dispose: () => store.dispose() };
}

export interface SpaceManagerDeps extends ManageSpacesDeps {
  commands: CommandRegistry;
  menus: MenuRegistry;
  dialog: DialogService;
  // After a rename lands. The open space's name is also shown outside this
  // dialog (atop the tree), which would otherwise keep the old one until reload.
  onRenamed(): void;
  // Once the dialog closes, for a list of spaces kept outside it: whatever
  // was renamed, removed or relocated in it has landed by then.
  onClosed?(): void;
  trust: Pick<SpaceTrust, "ask" | "revoke">;
}

export interface SpaceManager {
  open(): void;
}

/** Owns the Manage Spaces dialog: the "Manage Spaces…" command that opens it,
 * the dialog itself, and the row actions on its "⋮" menu.
 *
 * The commands register once at startup while the dialog's content is rebuilt
 * on every open, so the live content's refresh is held here rather than passed
 * in. Every action keys off the registry id rather than a path, which is what
 * lets them work on a space whose folder has moved or gone — see
 * docs/architecture.md's Space identity and state ownership section. */
export function createSpaceManager(deps: SpaceManagerDeps): SpaceManager {
  let refresh: (() => Promise<void>) | undefined;
  let showError: ManageSpacesContent["showError"] | undefined;

  // Each ⋮ action reports into the open dialog rather than letting the
  // rejection escape: these run through `commands.run`, which its callers
  // invoke with `void`, so an uncaught failure is a silent no-op.
  async function runSpaceAction(action: () => Promise<void>, fallback: string): Promise<void> {
    try {
      await action();
    } catch (thrown) {
      showError?.(thrown, fallback);
      return;
    }
    await refresh?.();
  }

  function open(): void {
    const content = createManageSpacesContent(deps);
    refresh = content.refresh;
    showError = content.showError;
    const handle = deps.dialog.open({
      title: "Manage Spaces",
      icon: "space",
      content: content.element,
      className: "dialog-manage-spaces dialog-flush",
      initialFocus: content.initialFocus,
    });
    void handle.closed.then(() => {
      refresh = undefined;
      showError = undefined;
      content.dispose();
      deps.onClosed?.();
    });
  }

  deps.commands.register({ id: "space.manage", label: "Manage Spaces…", run: () => open() });
  deps.menus.register(COMMAND_PALETTE, [{ command: "space.manage" }]);

  // The Manage Spaces row "⋮" actions. Each keys off the registry id, so
  // they work on a space whose folder has moved or gone. One menu id serves
  // every list, so each gates on the row kind — see lib/listItemMenu.ts.
  type SpaceMenuTarget = Extract<ListItemTarget, { kind: "space" }>;
  const spaceTarget = (arg: ListItemTarget): SpaceMenuTarget => arg as SpaceMenuTarget;

  deps.commands.register({
    id: "space.rename",
    label: "Rename…",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "space",
    run: async (_, arg: ListItemTarget) => {
      const target = spaceTarget(arg);
      const label = await deps.dialog.prompt({
        title: "Rename space",
        // Renaming changes only what pragma displays; it never touches the
        // folder, and never the id approvals are keyed by.
        message: "A display name for this space. The folder on disk is not renamed.",
        value: target.label,
        submitLabel: "Rename",
      });
      if (label === null) return;
      await runSpaceAction(async () => {
        await postSpaceLabel(target.id, label);
        deps.onRenamed();
      }, "Couldn't rename the space.");
    },
  });

  deps.commands.register({
    id: "space.resetGrants",
    label: "Reset approvals",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "space",
    run: async (_, arg: ListItemTarget) => {
      const target = spaceTarget(arg);
      const confirmed = await deps.dialog.confirm({
        title: "Reset approvals",
        message: `Every capability approved for “${target.label}” is revoked. Flows in it will ask again the next time they need one.`,
        confirmLabel: "Reset",
        danger: true,
      });
      if (!confirmed) return;
      await runSpaceAction(() => postResetSpaceGrants(target.id), "Couldn't reset the approvals.");
    },
  });

  deps.commands.register({
    id: "space.trust",
    label: "Trust space",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "space" && !arg.trusted,
    run: async (_, arg: ListItemTarget) => {
      const target = spaceTarget(arg);
      await runSpaceAction(() => deps.trust.ask(target), "Couldn't trust the space.");
    },
  });

  // No confirmation: revoking only turns git off, and asking again undoes it.
  deps.commands.register({
    id: "space.untrust",
    label: "Revoke trust",
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "space" && arg.trusted,
    run: async (_, arg: ListItemTarget) => {
      const target = spaceTarget(arg);
      await runSpaceAction(() => deps.trust.revoke(target.id), "Couldn't revoke the space's trust.");
    },
  });

  deps.commands.register({
    id: "space.forget",
    label: "Remove from list",
    // Never offered for the space being served: removing it would leave this
    // process serving something the registry no longer knows.
    when: (_, arg: ListItemTarget | undefined) => arg?.kind === "space" && !arg.isCurrent,
    run: async (_, arg: ListItemTarget) => {
      const target = spaceTarget(arg);
      const confirmed = await deps.dialog.confirm({
        title: "Remove from list",
        message: `Pragma stops listing “${target.label}” and discards the capabilities approved for it. The folder and its files are left alone.`,
        confirmLabel: "Remove",
        danger: true,
      });
      if (!confirmed) return;
      await runSpaceAction(() => postForgetSpace(target.id), "Couldn't remove the space from the list.");
    },
  });

  // Elsewhere than the desktop app, a moved space's entry is fixed by hand
  // in the config file.
  const bridge = deps.bridge;
  const relocate = bridge ? (id: string) => bridge.relocateSpace(id) : undefined;
  deps.commands.register(locateSpaceCommand(relocate, async () => await refresh?.()));

  // "Remove from list" sits in its own group so a separator divides it from
  // the edit actions above, and carries `danger` for the red every other
  // destructive item in this codebase uses.
  deps.menus.register("listItem", [
    { command: "space.locate" },
    { command: "space.rename" },
    { command: "space.resetGrants" },
    { command: "space.trust" },
    { command: "space.untrust" },
    { command: "space.forget", group: "destructive", danger: true },
  ]);

  return { open };
}
