// Create new space and Open folder as space: Manage Spaces' right pane in the
// desktop app, and the welcome window (welcome.ts). Two pages in Settings'
// shape: a card with the two actions, and the Create page sliding over it as
// a Settings subpage does.
//
// Both take a folder from the native picker, which only the desktop app has,
// so there is no form in a browser; the main process does the filesystem work
// (electron/main.ts).
import { DisposableStore, listen } from "./disposable.ts";
import { Emitter } from "./emitter.ts";
import { canSlide, createPageSlide } from "./pageSlide.ts";
import { toggleSettingRow } from "./toggleRow.ts";

// The Electron preload bridge's space half (electron/preload.ts).
export interface SpaceFormBridge {
  // The folder picked, or undefined if the picker was cancelled.
  browseSpaceLocation(): Promise<string | undefined>;
  // Scaffolds the space, with the template's worked examples or without
  // them, and opens it, which reloads or closes this page.
  createSpaceAt(name: string, location: string, examples: boolean): Promise<void>;
  openSpaceFolder(): Promise<void>;
}

export interface SpaceFormOptions {
  /** Where the Example projects switch starts: on for a first space, off
   * once there are others. */
  examples: boolean;
}

export interface SpaceForm {
  element: HTMLElement;
  /** Create…, the first page's first control. */
  initialFocus: HTMLElement;
  dispose(): void;
}

let formCount = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string): HTMLButtonElement {
  const node = el("button", `btn space-form-button ${className}`.trim(), label);
  node.type = "button";
  return node;
}

// A Settings row: what it is and what it does, then its control.
function row(title: HTMLElement, description: HTMLElement, control: HTMLElement): HTMLDivElement {
  const text = el("div", "field-row-text");
  text.append(title, description);
  const node = el("div", "field-row");
  node.append(text, control);
  return node;
}

// A form's own message, under its card.
function note(): HTMLParagraphElement {
  const node = el("p", "settings-group-note inline-error");
  node.hidden = true;
  return node;
}

function group(card: HTMLElement[], message: HTMLElement): HTMLDivElement {
  const cardNode = el("div", "settings-card");
  cardNode.append(...card);
  const node = el("div", "settings-group");
  node.append(cardNode, message);
  return node;
}

function report(target: HTMLElement, message: string | null): void {
  target.textContent = message ?? "";
  target.hidden = message === null;
}

export function createSpaceForm(bridge: SpaceFormBridge, options: SpaceFormOptions): SpaceForm {
  const store = new DisposableStore();
  const id = `space-form-${++formCount}`;
  const element = el("div", "space-form settings-pages");

  // The first page.
  const createOpen = button("Create…", "primary");
  const open = button("Open…", "");
  const startNote = note();
  const start = el("section", "settings-category space-form-start");
  start.append(
    group(
      [
        row(
          el("div", "field-row-title", "Create new space"),
          el("div", "field-row-description", "Starts a space in a new folder."),
          createOpen,
        ),
        row(
          el("div", "field-row-title", "Open folder as space"),
          el("div", "field-row-description", "Choose an existing folder on this computer."),
          open,
        ),
      ],
      startNote,
    ),
  );

  // The Create page.
  const back = el("button", "flat-button section-label settings-subpage-back");
  back.type = "button";
  const backIcon = el("span", "settings-subpage-back-icon");
  backIcon.setAttribute("aria-hidden", "true");
  back.append(backIcon, "Back");
  const head = el("div", "settings-subpage-head");
  head.append(back, el("h2", "settings-subpage-title", "Create new space"));

  const nameLabel = el("label", "field-row-title", "Name");
  nameLabel.htmlFor = `${id}-name`;
  const nameInput = el("input", "form-input settings-input");
  nameInput.id = `${id}-name`;
  nameInput.type = "text";
  nameInput.autocomplete = "off";
  nameInput.placeholder = "Space name";

  // No default location: a space goes where its person chose, never into a
  // folder picked for them.
  const locationText = el("div", "field-row-description", "Choose where the space's folder goes.");
  const browse = button("Browse…", "");

  const examples = new Emitter(options.examples);
  const createNote = note();
  const submit = button("Create", "primary");
  const actions = el("div", "space-form-actions");
  actions.append(submit);

  const create = el("section", "settings-subpage space-form-create");
  create.hidden = true;
  create.append(
    head,
    group(
      [
        row(nameLabel, el("div", "field-row-description", "The new folder gets this name."), nameInput),
        row(el("div", "field-row-title", "Location"), locationText, browse),
        toggleSettingRow({
          title: "Example projects",
          description: "Adds Getting started and Translation, two small projects to learn from.",
          setting: examples,
        }),
      ],
      createNote,
    ),
    actions,
  );
  element.append(start, create);

  const slider = createPageSlide();
  store.add(() => slider.stop());
  function show(to: HTMLElement): void {
    const from = to === create ? start : create;
    if (!to.hidden) return;
    slider.stop();
    from.hidden = true;
    to.hidden = false;
    if (canSlide(to)) slider.run(from, to, to === create);
    (to === create ? nameInput : createOpen).focus({ preventScroll: true });
  }

  let location: string | undefined;

  async function createSpace(): Promise<void> {
    const name = nameInput.value.trim();
    if (!name) return report(createNote, "Enter a space name.");
    if (!location) return report(createNote, "Choose a location for the space.");
    submit.disabled = true;
    submit.textContent = "Creating…";
    report(createNote, null);
    try {
      await bridge.createSpaceAt(name, location, examples.get());
    } catch (thrown) {
      report(createNote, thrown instanceof Error ? thrown.message : "Failed to create space.");
      submit.disabled = false;
      submit.textContent = "Create";
    }
  }

  store.add(listen(createOpen, "click", () => show(create)));
  store.add(listen(back, "click", () => show(start)));
  store.add(listen(submit, "click", () => void createSpace()));
  store.add(
    listen(nameInput, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") void createSpace();
    }),
  );
  store.add(
    listen(browse, "click", () => {
      void (async () => {
        const picked = await bridge.browseSpaceLocation();
        if (!picked) return;
        location = picked;
        locationText.replaceChildren("Goes in ", el("span", "space-form-path", picked));
      })();
    }),
  );
  store.add(
    listen(open, "click", () => {
      void (async () => {
        open.disabled = true;
        report(startNote, null);
        try {
          // Resolves with nothing to report if the picker was cancelled; a
          // space actually opening reloads or closes this page.
          await bridge.openSpaceFolder();
        } catch (thrown) {
          report(startNote, thrown instanceof Error ? thrown.message : "Failed to open space.");
        } finally {
          open.disabled = false;
        }
      })();
    }),
  );

  return { element, initialFocus: createOpen, dispose: () => store.dispose() };
}
