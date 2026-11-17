// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSpaceForm } from "../../../web/lib/spaceForm.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// `picked` is the folder Browse returns; null cancels the picker.
function setup({ picked = "/home/me/Documents" as string | null, examples = true } = {}) {
  const bridge = {
    browseSpaceLocation: vi.fn(async () => picked ?? undefined),
    createSpaceAt: vi.fn(async (_name: string, _location: string, _examples: boolean) => undefined),
    openSpaceFolder: vi.fn(async () => undefined),
  };
  const form = createSpaceForm(bridge, { examples });
  document.body.replaceChildren(form.element);
  const start = form.element.querySelector<HTMLElement>(".space-form-start") as HTMLElement;
  const create = form.element.querySelector<HTMLElement>(".space-form-create") as HTMLElement;
  const named = (page: HTMLElement, label: string) =>
    [...page.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === label,
    ) as HTMLButtonElement;
  return {
    bridge,
    form,
    start,
    create,
    createOpen: named(start, "Create…"),
    open: named(start, "Open…"),
    back: named(create, "Back"),
    browse: named(create, "Browse…"),
    submit: named(create, "Create"),
    name: create.querySelector<HTMLInputElement>("input") as HTMLInputElement,
    examples: create.querySelector<HTMLButtonElement>(".toggle-switch") as HTMLButtonElement,
    startNote: start.querySelector<HTMLElement>(".settings-group-note") as HTMLElement,
    createNote: create.querySelector<HTMLElement>(".settings-group-note") as HTMLElement,
    location: create.querySelectorAll<HTMLElement>(".field-row-description")[1],
  };
}

describe("createSpaceForm", () => {
  it("starts on Create… and Open…, and Create… brings the Create page with the name to type", () => {
    const { form, start, create, createOpen, name } = setup();

    expect(start.hidden).toBe(false);
    expect(create.hidden).toBe(true);
    expect(form.initialFocus).toBe(createOpen);

    createOpen.click();

    expect(start.hidden).toBe(true);
    expect(create.hidden).toBe(false);
    expect(document.activeElement).toBe(name);
    expect(create.querySelector(".settings-subpage-title")?.textContent).toBe("Create new space");
  });

  it("goes back to the first page, keeping what was typed", () => {
    const { start, create, createOpen, back, name } = setup();

    createOpen.click();
    name.value = "Notes";
    back.click();

    expect(start.hidden).toBe(false);
    expect(create.hidden).toBe(true);
    expect(document.activeElement).toBe(createOpen);
    expect(name.value).toBe("Notes");
  });

  it("asks for a name, then a location, before creating anything", async () => {
    const { createOpen, submit, name, bridge, createNote, location } = setup();

    createOpen.click();
    expect(location.textContent).toBe("Choose where the space's folder goes.");
    submit.click();
    expect(createNote.textContent).toBe("Enter a space name.");
    name.value = "Notes";
    submit.click();
    await tick();

    expect(createNote.hidden).toBe(false);
    expect(createNote.textContent).toBe("Choose a location for the space.");
    expect(bridge.createSpaceAt).not.toHaveBeenCalled();
  });

  it("creates the space in the chosen folder, from the button or Enter, with the examples as switched", async () => {
    const { createOpen, submit, browse, name, bridge, location, examples } = setup();

    createOpen.click();
    browse.click();
    await tick();
    expect(examples.getAttribute("aria-checked")).toBe("true");
    examples.click();
    name.value = "  Notes ";
    name.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await tick();

    expect(location.textContent).toBe("Goes in /home/me/Documents");
    expect(location.querySelector(".space-form-path")?.textContent).toBe("/home/me/Documents");
    expect(bridge.createSpaceAt).toHaveBeenCalledWith("Notes", "/home/me/Documents", false);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toBe("Creating…");
  });

  it("starts the Example projects switch where it is told to", async () => {
    const { createOpen, submit, browse, name, bridge, examples } = setup({ examples: false });

    createOpen.click();
    browse.click();
    await tick();
    name.value = "Notes";
    submit.click();
    await tick();

    expect(examples.getAttribute("aria-checked")).toBe("false");
    expect(bridge.createSpaceAt).toHaveBeenCalledWith("Notes", "/home/me/Documents", false);
  });

  it("keeps the location as it was when Browse is cancelled", async () => {
    const { createOpen, browse, location } = setup({ picked: null });

    createOpen.click();
    browse.click();
    await tick();

    expect(location.textContent).toBe("Choose where the space's folder goes.");
  });

  it("reports a refused create under the card and lets the person try again", async () => {
    const { createOpen, submit, browse, name, bridge, createNote } = setup();
    bridge.createSpaceAt.mockRejectedValueOnce(new Error("There’s already a folder named “Notes” in Documents."));

    createOpen.click();
    browse.click();
    await tick();
    name.value = "Notes";
    submit.click();
    await tick();

    expect(createNote.hidden).toBe(false);
    expect(createNote.textContent).toBe("There’s already a folder named “Notes” in Documents.");
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe("Create");
  });

  it("opens a folder as a space, reporting a failure on the first page", async () => {
    const { open, bridge, startNote } = setup();
    bridge.openSpaceFolder.mockRejectedValueOnce(new Error("That folder is gone"));

    open.click();
    await tick();

    expect(bridge.openSpaceFolder).toHaveBeenCalled();
    expect(startNote.hidden).toBe(false);
    expect(startNote.textContent).toBe("That folder is gone");
    expect(open.disabled).toBe(false);
  });
});
