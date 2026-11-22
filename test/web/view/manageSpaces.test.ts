// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ListItemTarget } from "../../../web/lib/listItemMenu.ts";
import { createCommands } from "../../../web/services/commands.ts";
import type { DialogService } from "../../../web/services/dialog.ts";
import type { MenuRegistry } from "../../../web/services/menus.ts";
import { createManageSpacesContent, createSpaceManager } from "../../../web/view/manageSpaces.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(withBridge = false) {
  const bridge = withBridge
    ? {
        browseSpaceLocation: vi.fn(async () => "/picked"),
        createSpaceAt: vi.fn(async () => undefined),
        openSpaceFolder: vi.fn(async () => undefined),
        relocateSpace: vi.fn(async () => "/relocated"),
      }
    : undefined;
  const deps = {
    fetchSpaceList: vi.fn(async () => ({
      current: { id: "spc_current", name: "Current", path: "/spaces/current" },
      // Server-sorted; this dialog renders the order it is given.
      spaces: [
        { id: "spc_other", name: "Other", path: "/spaces/other", trusted: true },
        { id: "spc_gone", name: "Gone", path: "/spaces/gone", missing: true },
        { id: "spc_current", name: "Current", path: "/spaces/current" },
      ],
      recent: [{ id: "spc_current", name: "Current", path: "/spaces/current" }],
    })),
    switchSpace: vi.fn(async () => undefined),
    createMenuButton: vi.fn((label: string, _target: ListItemTarget) => {
      const node = document.createElement("button");
      node.className = "list-item-menu";
      node.setAttribute("aria-label", label);
      return node;
    }),
    bridge,
  };
  const content = createManageSpacesContent(deps);
  document.body.append(content.element);
  return { content, deps, bridge };
}

describe("manageSpaces", () => {
  it("lists the spaces with the current one marked and not clickable, and switches on click", async () => {
    const { content, deps } = setup();
    await tick();
    const items = [...content.element.querySelectorAll<HTMLElement>(".list-item")];
    expect(items.map((item) => item.querySelector(".list-item-title")?.textContent)).toEqual([
      "Other",
      "Gone",
      "Current",
    ]);
    expect(items[2].classList.contains("active")).toBe(true);
    expect(items[2].getAttribute("aria-selected")).toBe("true");
    // Not focusable and not wired to switch — but never aria-disabled, which
    // would mark its own "⋮" disabled along with it.
    expect(items[2].hasAttribute("tabindex")).toBe(false);
    expect(items[2].hasAttribute("aria-disabled")).toBe(false);
    items[2].click();
    expect(deps.switchSpace).not.toHaveBeenCalled();

    items[0].click();
    expect(deps.switchSpace).toHaveBeenCalledWith("/spaces/other");
  });

  it("marks a space whose folder is gone, refuses to switch to it, and still offers its menu", async () => {
    const { content, deps } = setup();
    await tick();
    const gone = [...content.element.querySelectorAll<HTMLElement>(".list-item")][1];

    expect(gone.classList.contains("is-missing")).toBe(true);
    expect(gone.querySelector(".list-item-subtitle")?.textContent).toBe("/spaces/gone (folder not found)");
    expect(gone.hasAttribute("aria-disabled")).toBe(false);

    gone.click();
    expect(deps.switchSpace).not.toHaveBeenCalled();
    // Locate lives on this menu, so it has to stay reachable.
    expect(gone.querySelector(".list-item-menu")).not.toBeNull();
  });

  it("gives every row a menu keyed by registry id, flagging the current and missing ones", async () => {
    const { deps } = setup();
    await tick();
    const targets = deps.createMenuButton.mock.calls.map((call) => call[1]);
    expect(targets).toEqual([
      { kind: "space", id: "spc_other", label: "Other", missing: false, isCurrent: false, trusted: true },
      { kind: "space", id: "spc_gone", label: "Gone", missing: true, isCurrent: false, trusted: false },
      { kind: "space", id: "spc_current", label: "Current", missing: false, isCurrent: true, trusted: false },
    ]);
  });

  // Making a space takes a folder only the desktop app can ask for, so a
  // browser gets no form, only where to do it instead.
  it("points to the command line instead of a form without the desktop bridge", () => {
    const { content } = setup();

    expect(content.element.querySelector(".space-form")).toBeNull();
    expect(content.initialFocus).toBeUndefined();
    expect(content.element.querySelector(".manage-spaces-hint")?.textContent).toBe(
      "To add a space, run pragma init or pragma space add on the computer running Pragma.",
    );
  });

  // Whoever opens this already has a space, so the examples start off; the
  // form reports in its own note, the ⋮ actions' row staying for them.
  it("offers the create and open pages with the bridge, Example projects off", async () => {
    const { content, bridge } = setup(true);
    const button = (label: string) =>
      [...content.element.querySelectorAll<HTMLButtonElement>(".space-form button")].find(
        (node) => node.textContent === label,
      ) as HTMLButtonElement;
    bridge?.createSpaceAt.mockRejectedValueOnce(new Error("There’s already a folder named “Desk” in picked."));

    expect(content.element.querySelector(".manage-spaces-hint")).toBeNull();
    expect(content.initialFocus).toBe(button("Create…"));
    button("Create…").click();
    button("Browse…").click();
    await tick();
    (content.element.querySelector(".space-form-create input") as HTMLInputElement).value = "Desk";
    button("Create").click();
    await tick();

    expect(bridge?.createSpaceAt).toHaveBeenCalledWith("Desk", "/picked", false);
    expect(content.element.querySelector(".space-form-create .settings-group-note")?.textContent).toBe(
      "There’s already a folder named “Desk” in picked.",
    );
    expect(content.element.querySelector<HTMLElement>(".manage-spaces-error")?.hidden).toBe(true);
  });
});

// The "⋮" actions run through `commands.run`, which its callers invoke with
// `void` — so a rejection that escapes is a silent no-op, not a visible
// failure. These pin that each one reports into the open dialog instead.
describe("manageSpaces row actions", () => {
  function managerSetup() {
    const { deps } = setup();
    const commands = createCommands();
    const open = vi.fn((options: { content: HTMLElement; title?: string | Node; icon?: unknown }) => {
      opened = options.content;
      return { closed: new Promise<void>(() => {}), close: vi.fn() };
    });
    let opened: HTMLElement | undefined;
    const dialog = {
      open,
      confirm: vi.fn(async () => true),
      prompt: vi.fn(async () => "Renamed"),
    } as unknown as DialogService;
    const menus = { register: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as MenuRegistry;
    const onRenamed = vi.fn();
    const trust = { ask: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined) };
    createSpaceManager({ ...deps, commands, menus, dialog, onRenamed, trust }).open();
    // The panel the manager actually opened — not the unrelated one `setup`
    // put in the document, which would make either assertion below vacuous.
    if (!opened) throw new Error("the manager never opened its dialog");
    return { commands, content: opened, onRenamed, trust, open };
  }

  const target: ListItemTarget = { kind: "space", id: "spc_other", label: "Other", isCurrent: false } as ListItemTarget;
  const context = { tab: { kind: "empty" as const }, pane: undefined };

  it("titles its dialog with the Space icon", () => {
    const { open } = managerSetup();
    const [options] = open.mock.calls[0];
    expect(options.title).toBe("Manage Spaces");
    expect(options.icon).toBe("space");
  });

  it("shows a failed reset in the dialog rather than dropping it", async () => {
    const { commands, content } = managerSetup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not a known space", { status: 400 })),
    );
    await commands.run("space.resetGrants", context, target);
    expect(content.querySelector(".manage-spaces-error")?.textContent).toBe("Not a known space");
    vi.unstubAllGlobals();
  });

  it("clears a failed action's message as the next action starts", async () => {
    const { commands, content } = managerSetup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Not a known space", { status: 400 })),
    );
    await commands.run("space.resetGrants", context, target);
    const row = content.querySelector<HTMLElement>(".manage-spaces-error");
    expect(row?.hidden).toBe(false);
    await commands.run("space.trust", context, { ...target, trusted: false } as ListItemTarget);
    expect(row?.hidden).toBe(true);
    vi.unstubAllGlobals();
  });

  it("shows a failed rename in the dialog rather than dropping it", async () => {
    const { commands, content, onRenamed } = managerSetup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    await commands.run("space.rename", context, target);
    expect(content.querySelector(".manage-spaces-error")?.textContent).toBe("Failed to rename space: 500");
    expect(onRenamed).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("offers trusting an untrusted space and revoking a trusted one, never both", async () => {
    const { commands, trust } = managerSetup();
    const untrusted = { ...target, trusted: false } as ListItemTarget;
    const trusted = { ...target, trusted: true } as ListItemTarget;

    expect(commands.isEnabled("space.trust", context, untrusted)).toBe(true);
    expect(commands.isEnabled("space.untrust", context, untrusted)).toBe(false);
    expect(commands.isEnabled("space.trust", context, trusted)).toBe(false);
    expect(commands.isEnabled("space.untrust", context, trusted)).toBe(true);

    await commands.run("space.trust", context, untrusted);
    expect(trust.ask).toHaveBeenCalledWith(untrusted);
    await commands.run("space.untrust", context, trusted);
    expect(trust.revoke).toHaveBeenCalledWith("spc_other");
  });

  it("reports a landed rename so the name shown outside the dialog can follow", async () => {
    const { commands, onRenamed } = managerSetup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await commands.run("space.rename", context, target);
    expect(onRenamed).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});

describe("closing Manage Spaces", () => {
  it("is reported, for a list of spaces kept outside the dialog", async () => {
    const { deps } = setup();
    let close = () => {};
    const dialog = {
      open: vi.fn(() => ({ closed: new Promise<void>((resolve) => (close = resolve)), close: vi.fn() })),
    } as unknown as DialogService;
    const menus = { register: vi.fn(() => ({ dispose: vi.fn() })) } as unknown as MenuRegistry;
    const onClosed = vi.fn();
    const trust = { ask: vi.fn(async () => undefined), revoke: vi.fn(async () => undefined) };
    createSpaceManager({
      ...deps,
      commands: createCommands(),
      menus,
      dialog,
      onRenamed: vi.fn(),
      onClosed,
      trust,
    }).open();
    await tick();
    expect(onClosed).not.toHaveBeenCalled();

    close();
    await tick();
    expect(onClosed).toHaveBeenCalledOnce();
  });
});
