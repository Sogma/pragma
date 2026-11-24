// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupError } from "../../../src/protocol/setupNeed.ts";
import type { Disposable } from "../../../web/lib/disposable.ts";
import { createCommands } from "../../../web/services/commands.ts";
import { createDialogService, type DialogIcon } from "../../../web/services/dialog.ts";
import { createKeybindings } from "../../../web/services/keybindings.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
}

function panels(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".dialog-panel")];
}

function buttonNamed(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found;
}

// Escape reaches a dialog through the keybinding dispatcher, so each
// service gets registries of its own, attached to the document for the
// test and detached after it.
let attached: Disposable[] = [];

function service(root?: HTMLElement) {
  const commands = createCommands();
  const keybindings = createKeybindings(commands);
  attached.push(keybindings.attach(document, () => ({ tab: { kind: "empty" }, pane: undefined })));
  return createDialogService(root, { commands, keybindings });
}

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const disposable of attached) disposable.dispose();
  attached = [];
});

describe("dialog service", () => {
  describe("confirm", () => {
    it("opens a titled panel over a scrim, focuses the primary button, and resolves true on confirm", async () => {
      const trigger = document.createElement("button");
      document.body.append(trigger);
      trigger.focus();
      const dialog = service();

      const answer = dialog.confirm({ title: "Delete?", message: "Sure?", confirmLabel: "Delete", danger: true });

      const [panel] = panels();
      expect(panel.getAttribute("role")).toBe("dialog");
      expect(panel.querySelector(".dialog-title")?.textContent).toBe("Delete?");
      expect(panel.querySelector(".dialog-message")?.textContent).toBe("Sure?");
      expect(panel.parentElement?.classList.contains("dialog-backdrop")).toBe(true);
      expect(dialog.isOpen()).toBe(true);
      const primary = buttonNamed(panel, "Delete");
      expect(primary.classList.contains("danger")).toBe(true);
      expect(document.activeElement).toBe(primary);

      primary.click();
      await expect(answer).resolves.toBe(true);
      expect(panels()).toHaveLength(0);
      expect(dialog.isOpen()).toBe(false);
      expect(document.activeElement).toBe(trigger); // focus returned to the trigger
    });

    it("resolves false on Cancel, the close button, the scrim, and Escape", async () => {
      const dialog = service();
      const ways = [
        (panel: HTMLElement) => buttonNamed(panel, "Cancel").click(),
        (panel: HTMLElement) => panel.querySelector<HTMLButtonElement>(".dialog-close")?.click(),
        (panel: HTMLElement) => (panel.parentElement as HTMLElement).click(),
        () => pressEscape(),
      ];
      for (const dismiss of ways) {
        const answer = dialog.confirm({ title: "T", message: "M" });
        dismiss(panels()[0]);
        await expect(answer).resolves.toBe(false);
        expect(panels()).toHaveLength(0);
      }
    });

    it("runs the action with the dialog held open, shows a failure inline, and closes on success", async () => {
      const dialog = service();
      let release: (error?: Error) => void = () => undefined;
      const action = vi.fn(
        () =>
          new Promise<void>((resolve, reject) => {
            release = (error) => (error ? reject(error) : resolve());
          }),
      );
      const answer = dialog.confirm({
        title: "T",
        message: "M",
        confirmLabel: "Delete",
        busyLabel: "Deleting…",
        action,
      });
      const [panel] = panels();
      const primary = buttonNamed(panel, "Delete");
      primary.click();
      await tick();

      expect(action).toHaveBeenCalledTimes(1);
      expect(primary.textContent).toBe("Deleting…");
      expect(primary.disabled).toBe(true);
      expect(buttonNamed(panel, "Cancel").disabled).toBe(true);

      release(new Error("nope"));
      await tick();
      expect(panels()).toHaveLength(1); // still open
      expect(panel.querySelector<HTMLElement>(".dialog-error")?.hidden).toBe(false);
      expect(panel.querySelector(".dialog-error")?.textContent).toBe("nope");
      expect(primary.textContent).toBe("Delete");
      expect(primary.disabled).toBe(false);

      primary.click();
      await tick();
      expect(panel.querySelector<HTMLElement>(".dialog-error")?.hidden).toBe(true);
      release();
      await expect(answer).resolves.toBe(true);
      expect(panels()).toHaveLength(0);
    });

    it("links a failure a setting fixes to that setting, under its message", async () => {
      const dialog = service();
      void dialog.confirm({
        title: "T",
        message: "M",
        confirmLabel: "Publish",
        action: () => Promise.reject(new SetupError("No publisher configured.", { kind: "publisher" })),
      });
      const [panel] = panels();
      buttonNamed(panel, "Publish").click();
      await tick();
      const error = panel.querySelector(".dialog-error") as HTMLElement;
      expect(error.querySelector(".inline-error-message")?.textContent).toBe("No publisher configured.");
      expect(error.querySelector(".setting-link")?.textContent).toBe("Go to Publishing settings");
    });

    it("draws the icon it's named before the title, hidden from assistive tech", () => {
      const dialog = service();
      const drawn = (icon: DialogIcon) => {
        void dialog.confirm({ title: "T", message: "M", icon });
        const title = panels().at(-1)?.querySelector(".dialog-title");
        expect(title?.textContent).toBe("T");
        const element = title?.firstElementChild;
        expect(element?.classList.contains("dialog-title-icon")).toBe(true);
        expect(element?.getAttribute("aria-hidden")).toBe("true");
        return element;
      };
      expect((drawn({ glyph: "flow" }) as HTMLElement).dataset.entryIcon).toBe("flow");
      expect(drawn("space")?.querySelector(".space-icon-face-top")).not.toBeNull();
      expect(drawn("pragma")?.getAttribute("src")).toBe("/images/mark.svg");
    });

    it("a warning renders as its own block", () => {
      const dialog = service();
      void dialog.confirm({ title: "T", message: "M", warning: "Careful" });
      expect(panels()[0].querySelector(".inline-warning")?.textContent).toBe("Careful");
    });

    it("draws a message of several paragraphs as a paragraph each", () => {
      const dialog = service();
      void dialog.confirm({ title: "T", message: ["First.", "Second."] });
      const paragraphs = [...panels()[0].querySelectorAll(".dialog-message")].map((p) => p.textContent);
      expect(paragraphs).toEqual(["First.", "Second."]);
    });
  });

  describe("prompt", () => {
    it("draws its icon before the title, through the form it opens", () => {
      const dialog = service();
      void dialog.prompt({ title: "Rename", icon: { glyph: "library" }, value: "x" });
      const icon = panels()[0].querySelector(".dialog-title")?.firstElementChild as HTMLElement | null;
      expect(icon?.dataset.entryIcon).toBe("library");
    });

    it("focuses and selects the current value, submits on Enter, and resolves the entered text", async () => {
      const dialog = service();
      const answer = dialog.prompt({ title: "Rename", value: "old", submitLabel: "Rename" });
      const input = panels()[0].querySelector<HTMLInputElement>(".dialog-input");
      if (!input) throw new Error("no input");
      expect(document.activeElement).toBe(input);
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(3);

      input.value = "new";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await expect(answer).resolves.toBe("new");
    });

    it("validation and a submit message keep it open; cancel resolves null", async () => {
      const dialog = service();
      const submit = vi.fn(async (value: string) => (value === "taken" ? "Already used." : undefined));
      const answer = dialog.prompt({
        title: "Rename",
        value: "",
        submitLabel: "Rename",
        validate: (value) => (value.trim() ? undefined : "Enter a name."),
        submit,
      });
      const [panel] = panels();
      const input = panel.querySelector<HTMLInputElement>(".dialog-input") as HTMLInputElement;
      const primary = buttonNamed(panel, "Rename");

      primary.click();
      await tick();
      // A refused field shows as any refused submit does.
      expect(panel.querySelector(".dialog-error .inline-error")?.textContent).toBe("Enter a name.");
      expect(submit).not.toHaveBeenCalled();

      input.value = "taken";
      primary.click();
      await tick();
      expect(submit).toHaveBeenCalledWith("taken");
      expect(panel.querySelector(".dialog-error")?.textContent).toBe("Already used.");
      expect(panels()).toHaveLength(1);

      buttonNamed(panel, "Cancel").click();
      await expect(answer).resolves.toBeNull();
    });
  });

  describe("form", () => {
    it("collects every field, submits a textarea on Ctrl+Enter, and can relabel the primary button on failure", async () => {
      const dialog = service();
      let attempt = 0;
      const answer = dialog.form({
        title: "New Site",
        message: "in projects",
        fields: [
          { id: "name", placeholder: "Site name" },
          { id: "notes", label: "Notes", multiline: true, rows: 3 },
        ],
        submitLabel: "Create",
        submit: async () => (attempt++ === 0 ? { message: "Sogma said no.", submitLabel: "Retry" } : undefined),
      });
      const [panel] = panels();
      expect(panel.querySelector(".dialog-message")?.textContent).toBe("in projects");
      const name = panel.querySelector<HTMLInputElement>("input.dialog-input") as HTMLInputElement;
      const notes = panel.querySelector<HTMLTextAreaElement>("textarea.dialog-textarea") as HTMLTextAreaElement;
      expect(document.activeElement).toBe(name);
      expect(notes.rows).toBe(3);
      expect(panel.querySelector(".dialog-field-label")?.textContent).toBe("Notes");

      name.value = "Blog";
      notes.value = "line";
      notes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); // a plain Enter in a textarea is a newline
      await tick();
      expect(attempt).toBe(0);

      notes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));
      await tick();
      expect(attempt).toBe(1);
      expect(panel.querySelector(".dialog-error")?.textContent).toBe("Sogma said no.");
      const primary = buttonNamed(panel, "Retry");
      expect(primary.classList.contains("dialog-primary")).toBe(true);

      primary.click();
      await expect(answer).resolves.toEqual({ name: "Blog", notes: "line" });
    });

    it("caps what a text field takes at its maxLength, and leaves a dropdown uncapped", () => {
      service().form({
        title: "Library properties",
        fields: [
          { id: "description", label: "Description", maxLength: 80 },
          { id: "notes", multiline: true, maxLength: 12 },
          { id: "access", choices: [{ value: "read-only", label: "Read only" }], maxLength: 5 },
          { id: "name" },
        ],
      });
      const [panel] = panels();
      const control = (id: string) =>
        panel.querySelector(`#dialog-field-${id}`) as HTMLElement & { maxLength?: number };
      expect(control("description").maxLength).toBe(80);
      expect(control("notes").maxLength).toBe(12);
      expect(control("access").hasAttribute("maxlength")).toBe(false);
      expect(control("name").hasAttribute("maxlength")).toBe(false);
    });

    // Save frame's: the frame, a name before its extension, and a folder field.
    it("shows a figure above its fields, fixed text after a field, and a control the caller draws", async () => {
      const picture = document.createElement("canvas");
      const folder = document.createElement("button");
      let chosen = "a/stills";
      const answer = service().form({
        title: "Save frame",
        figure: picture,
        fields: [
          { id: "name", label: "Name", value: "one 00-00-01-00", suffix: ".png" },
          { id: "folder", label: "Folder", control: { element: folder, value: () => chosen } },
        ],
        submitLabel: "Save",
      });
      const [panel] = panels();
      const body = panel.querySelector(".dialog-body") as HTMLElement;
      expect(body.firstElementChild?.className).toBe("dialog-figure");
      expect(body.firstElementChild?.firstElementChild).toBe(picture);
      const name = panel.querySelector<HTMLInputElement>("#dialog-field-name") as HTMLInputElement;
      expect(name.parentElement?.className).toBe("dialog-input-row");
      expect(name.nextElementSibling?.textContent).toBe(".png");
      expect(document.activeElement).toBe(name);
      expect(folder.id).toBe("dialog-field-folder");
      expect(folder.getAttribute("aria-labelledby")).toBe("dialog-field-folder-label dialog-field-folder");
      expect(panel.querySelector("#dialog-field-folder-label")?.textContent).toBe("Folder");
      expect(panel.querySelector<HTMLLabelElement>("label[for='dialog-field-name']")?.textContent).toBe("Name");

      chosen = "b";
      name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      await expect(answer).resolves.toEqual({ name: "one 00-00-01-00", folder: "b" });
    });
  });

  describe("pick", () => {
    it("resolves the chosen option's id, or null on Escape", async () => {
      const dialog = service();
      const options = [
        { id: "a", label: "Alpha", description: "first" },
        { id: "b", label: "Beta" },
      ];
      const answer = dialog.pick({ title: "Choose", options });
      const items = panels()[0].querySelectorAll<HTMLButtonElement>(".dialog-option");
      expect(items).toHaveLength(2);
      expect(items[0].querySelector(".dialog-option-description")?.textContent).toBe("first");
      items[1].click();
      await expect(answer).resolves.toBe("b");

      const second = dialog.pick({ title: "Choose", options });
      pressEscape();
      await expect(second).resolves.toBeNull();
    });
  });

  describe("open", () => {
    it("hands back a handle whose close() resolves `closed`, with no header when untitled", async () => {
      const dialog = service();
      const content = document.createElement("div");
      content.textContent = "body";
      const handle = dialog.open({ content, className: "wide" });
      expect(handle.panel.classList.contains("wide")).toBe(true);
      expect(handle.panel.querySelector(".dialog-header")).toBeNull();
      expect(handle.panel.hasAttribute("aria-labelledby")).toBe(false);
      expect(handle.panel.contains(content)).toBe(true);
      expect(document.activeElement).toBe(handle.panel); // nothing focusable inside

      let resolved = false;
      void handle.closed.then(() => {
        resolved = true;
      });
      handle.close();
      handle.close(); // idempotent
      await tick();
      expect(resolved).toBe(true);
      expect(panels()).toHaveLength(0);
    });

    it("names a titled panel by its title, each stacked one by its own", () => {
      const dialog = service();
      const first = dialog.open({ title: "One", content: document.createElement("div") });
      const second = dialog.open({ title: "Two", content: document.createElement("div") });
      for (const [handle, name] of [
        [first, "One"],
        [second, "Two"],
      ] as const) {
        const id = handle.panel.getAttribute("aria-labelledby") ?? "";
        expect(document.getElementById(id)?.textContent).toBe(name);
      }
    });

    it("Escape addresses the topmost dialog only, and one that handles Escape itself stays open", () => {
      const dialog = service();
      const bottom = dialog.open({ content: document.createElement("div") });
      let handled = 0;
      const top = dialog.open({
        content: document.createElement("div"),
        onEscape: () => {
          handled++;
          return handled === 1; // the first Escape steps back, the second closes
        },
      });
      expect(panels()).toHaveLength(2);

      pressEscape();
      expect(panels()).toHaveLength(2);
      pressEscape();
      expect(panels()).toHaveLength(1);
      expect(top.panel.isConnected).toBe(false);
      expect(bottom.panel.isConnected).toBe(true);
      pressEscape();
      expect(panels()).toHaveLength(0);
    });

    it("a dialog scoped to a host is anchored inside it, and closeOnBackdrop can be turned off", () => {
      const dialog = service();
      const host = document.createElement("div");
      document.body.append(host);
      const handle = dialog.open({ content: document.createElement("div"), host, closeOnBackdrop: false });
      const backdrop = handle.panel.parentElement as HTMLElement;
      expect(backdrop.parentElement).toBe(host);
      expect(backdrop.classList.contains("dialog-scoped")).toBe(true);
      backdrop.click();
      expect(handle.panel.isConnected).toBe(true);
    });

    it("closes on a backdrop press, but not on a selection dragged out of the panel", () => {
      const dialog = service();
      const press = (target: HTMLElement) => target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      // A click's target is the common ancestor of press and release, so a
      // drag that starts in the panel and ends over the backdrop reports the
      // backdrop either way — the press is what tells them apart.
      const release = (backdrop: HTMLElement) => backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      const dragged = dialog.open({ content: document.createElement("div") });
      const draggedBackdrop = dragged.panel.parentElement as HTMLElement;
      press(dragged.panel);
      release(draggedBackdrop);
      expect(dragged.panel.isConnected).toBe(true);

      // The same release, after a press that did start on the backdrop.
      press(draggedBackdrop);
      release(draggedBackdrop);
      expect(dragged.panel.isConnected).toBe(false);
    });
  });
});
