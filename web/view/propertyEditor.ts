// Properties as editable rows, one per key: a note's frontmatter or an HTML
// kind's metadata block.
import { isListFrontmatterKey, PUBLICATION_DATE_KEY } from "../../src/protocol/frontmatter.ts";
import { illegalTagNameReason, sameTag, tagNameOf, tagsOf } from "../../src/protocol/tags.ts";
import { coerceScalarPropertyValue } from "../core/documentContent.ts";
import { openDatePicker, parseDatePrefix } from "../lib/datePicker.ts";
import { propertyIcon } from "../lib/propertyIcon.ts";
import { createPill, createTagPill, paintTagPills } from "../lib/tagPill.ts";
import { attachTagSuggestions, type TagSource } from "../lib/tagSuggestions.ts";
import { createWrappingField } from "../lib/wrappingField.ts";
import type { ContextMenuService } from "../services/menus.ts";

// How far a press on a row's icon travels before it drags the property
// rather than clicking to open its menu.
const DRAG_THRESHOLD_PX = 4;

export interface PropertyEditorOptions {
  onStructuralChange?: () => void;
  // Draws the menu a removable row's icon opens.
  contextMenu: ContextMenuService;
  // The space's tag vocabulary: a `tags` row's pills take their tag's color
  // and its add-tag input suggests tags. Absent, both stay plain.
  tags?: TagSource;
  // The document's path, for the `pragma` key's scope mark.
  path?: string;
  // A metadata block holds only text, so a typed `3` stays the text it is
  // rather than becoming a number the file can't store.
  textValues?: boolean;
  // Keys Pragma sets itself, as a Table's dates: shown as facts, never
  // edited, renamed or removed, and no other property may take their names.
  readOnlyKeys?: readonly string[];
  // The context a scope's AGENTS.md opens: the card its `pragma` row shows
  // under it, read-only, and the Context dialog its menu opens. A context's
  // settings are edited only there, so that row has no field of its own,
  // whose text would flatten the block into a string.
  context?: { card(data: Record<string, unknown>): HTMLElement | undefined; open(): void };
}

// Generic key/value + tag-pill property editor, shared by a document's
// properties section and an HTML kind's metadata block. It keeps no state
// beyond closures over `container`/`data`, so a fresh instance per render
// has nothing to go stale.
//
// `data` is mutated in place, never reassigned — a rename clears and
// re-assigns it — so a caller can hold one reference across renders.
// `onChange` fires after every mutation; `onStructuralChange` only after an
// add or delete, for callers watching the zero-properties boundary.
export function createPropertyEditor(
  container: HTMLElement,
  data: Record<string, unknown>,
  onChange: () => void,
  { onStructuralChange, contextMenu, tags, path, textValues, readOnlyKeys, context }: PropertyEditorOptions,
): { render: () => void; addProperty: () => HTMLElement | undefined } {
  // Set as a drag ends, for the click its release sends, which must not open
  // the icon's menu. It runs in the same task, before the timeout clears this.
  let swallowClick = false;

  // Refills `data` in place, in the entries' order, rather than pointing it
  // at a fresh object, so a caller's own reference to it stays valid.
  function refill(entries: [string, unknown][]): void {
    for (const key of Object.keys(data)) delete data[key];
    Object.assign(data, Object.fromEntries(entries));
  }

  // Rebuilds just one row's value cell in place, for a chip add/remove, so
  // typing several tags in a row (Enter, Enter, Enter) doesn't lose the
  // add-tag input's focus to a full rebuild on each Enter. Structural edits
  // (add/delete/rename a property) take the full rebuild, since they move
  // focus somewhere new anyway.
  function refreshRowValue(key: string, focusAddInput: boolean): void {
    const row = container.querySelector<HTMLElement>(`.property-editor-row[data-key="${CSS.escape(key)}"]`);
    const oldCell = row?.querySelector<HTMLElement>(".property-editor-value");
    if (!row || !oldCell) return;
    const newCell = buildValueCell(key);
    oldCell.replaceWith(newCell);
    if (focusAddInput) newCell.querySelector<HTMLInputElement>(".property-editor-tag-input")?.focus();
  }

  // A value is saved with its type as it is typed, so a `3` turns the row's
  // icon from text to number without waiting for a rebuild.
  function refreshRowIcon(key: string): void {
    container
      .querySelector(`.property-editor-row[data-key="${CSS.escape(key)}"] .property-icon`)
      ?.replaceWith(propertyIcon(key, data, path));
  }

  // A property's value cell, keyed off the value's *shape* — an array
  // renders as pills + an add-tag input, anything else a text field —
  // the rule markdownRender.ts follows too, since frontmatter parsing is
  // deliberately schema-less.
  //
  // The exception is a recognized list key (`tags`): it gets the list UI
  // before it holds a YAML sequence, so a fresh `tags` property isn't a text
  // box the user must hand-edit the file to escape.
  function buildValueCell(key: string): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "property-editor-value";

    // Migrate a `tags`-style key that's holding a non-empty scalar (e.g. a
    // hand-written `tags: poetry`) to a one-item array, and persist the
    // fix. An empty/absent one is left as-is — the add-tag input below
    // creates the array on the first tag, so an untouched `tags` property
    // never writes an empty `tags: []` back to the file.
    if (isListFrontmatterKey(key) && !Array.isArray(data[key])) {
      const scalar = data[key];
      if (scalar !== null && scalar !== undefined && String(scalar).trim() !== "") {
        data[key] = [typeof scalar === "object" ? JSON.stringify(scalar) : String(scalar)];
        onChange();
      }
    }

    const value = data[key];

    if (Array.isArray(value) || isListFrontmatterKey(key)) {
      const items = Array.isArray(value) ? value : [];
      for (const item of items) {
        const pill = key === "tags" ? createTagPill(String(item), tags?.known()) : createPill(String(item));
        pill.classList.add("property-editor-pill");

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "property-editor-pill-remove";
        remove.dataset.tooltip = "Remove";
        remove.setAttribute("aria-label", `Remove ${String(item)}`);
        remove.addEventListener("click", () => {
          const current = data[key];
          if (!Array.isArray(current)) return;
          current.splice(current.indexOf(item), 1);
          onChange();
          refreshRowValue(key, false);
        });
        pill.appendChild(remove);
        cell.appendChild(pill);
      }

      const addInput = document.createElement("input");
      addInput.type = "text";
      addInput.className = "form-input form-input-quiet property-editor-tag-input";
      addInput.placeholder = "Add…";
      const add = (item: string): void => {
        // Create the array here rather than up front, so a recognized
        // `tags` key that was never actually given a tag doesn't leave an
        // empty `tags: []` in the frontmatter (see the value cell's note).
        const existing = data[key];
        const current: unknown[] = Array.isArray(existing) ? existing : [];
        data[key] = current;
        // A tag applied in another case, or with its `#`, is applied: one
        // tag, two spellings.
        const applied = key === "tags" ? tagsOf(current).some((each) => sameTag(each, item)) : current.includes(item);
        if (!applied) current.push(item);
        onChange();
        refreshRowValue(key, true);
      };
      const suggestions =
        key === "tags" && tags
          ? attachTagSuggestions(addInput, { source: tags, applied: () => tagsOf(items), onPick: add })
          : undefined;
      addInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== ",") return;
        event.preventDefault();
        const item = suggestions?.highlighted() ?? addInput.value.trim();
        if (!item) return;
        // A tag goes in by its name, `#` aside. One that names no tag is
        // refused and stays in the field to fix.
        const name = key === "tags" ? tagNameOf(item) : item;
        if (name === undefined) window.alert(illegalTagNameReason(item));
        else add(name);
      });
      cell.appendChild(addInput);
      return cell;
    }

    const shown =
      value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (key === PUBLICATION_DATE_KEY) {
      const input = document.createElement("input");
      input.type = "text";
      input.className = "form-input form-input-quiet property-editor-value-input";
      input.value = shown;
      appendDatePicker(cell, input, key);
      return cell;
    }
    // Saved as it is typed, like the note's body, so nothing typed waits on
    // the field losing focus before the note reloads or closes. Text shown
    // back as it first was keeps the value it was, so Escape restores a
    // number, an object or a multi-line string exactly.
    const field = createWrappingField({
      value: shown,
      label: key,
      saves: "typing",
      save: (text) => {
        data[key] = text === shown ? value : textValues ? text : coerceScalarPropertyValue(text);
        onChange();
        refreshRowIcon(key);
      },
    });
    cell.appendChild(field);
    return cell;
  }

  // A removable row's icon is its menu button: a click, a right-click or the
  // keyboard opens the menu under it. Remove lives there, two clicks away,
  // since nothing undoes it. The icon is also what the property is dragged by,
  // and Alt+Up and Alt+Down move it, as Alt+arrows move an App mode tile.
  function buildIcon(key: string): HTMLElement {
    const icon = propertyIcon(key, data, path);
    if (readOnlyKeys?.includes(key)) return icon;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button property-menu-button";
    button.dataset.tooltip = "Property options";
    button.setAttribute("aria-label", `Property options for ${key}`);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(icon);
    const remove = { label: "Remove", danger: true, group: "remove", run: () => removeProperty(key) };
    const open = (): void =>
      contextMenu.open({
        anchor: button,
        ariaLabel: "Property options",
        items:
          key === "pragma" && context
            ? [{ label: "Context…", group: "context", run: () => context.open() }, remove]
            : [remove],
      });
    button.addEventListener("click", () => {
      if (swallowClick) return;
      if (contextMenu.isOpen(button)) contextMenu.close();
      else open();
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      open();
    });
    button.addEventListener("pointerdown", (event) => {
      if (event.button === 0) dragFrom(button, key, event);
    });
    button.addEventListener("keydown", (event) => {
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      if (!step || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      moveProperty(key, Object.keys(data).indexOf(key) + step);
    });
    return button;
  }

  // A press that travels past the threshold lifts the property's row: a copy
  // follows the pointer while the row itself, hidden behind a tinted slot,
  // moves through the list to where it would land, and the list scrolls near
  // its edges. Escape puts it back, though the release still clicks nothing.
  function dragFrom(button: HTMLElement, key: string, down: PointerEvent): void {
    const form = button.closest<HTMLElement>(".property-editor");
    const row = button.closest<HTMLElement>(".property-editor-row");
    const rows = () => [...(form?.querySelectorAll<HTMLElement>(":scope > .property-editor-row") ?? [])];
    if (!form || !row || rows().length < 2) return;
    const home = row.nextElementSibling;
    const scroller = scrollParent(form);
    let ghost: HTMLElement | undefined;
    let grab = { x: 0, y: 0, height: 0 };
    let origin = { x: 0, y: 0 };
    let pointer = { x: down.clientX, y: down.clientY };
    let cancelled = false;
    let frame = 0;

    // The form holds the pointer rather than the icon: moving the row through
    // the list would take a hold on anything inside it away.
    const lift = () => {
      const box = row.getBoundingClientRect();
      grab = { x: down.clientX - box.left, y: down.clientY - box.top, height: box.height };
      ghost = row.cloneNode(true) as HTMLElement;
      ghost.className = "property-editor-drag-ghost";
      ghost.removeAttribute("data-key");
      ghost.setAttribute("aria-hidden", "true");
      ghost.inert = true;
      const grid = getComputedStyle(form);
      Object.assign(ghost.style, {
        width: `${box.width}px`,
        height: `${box.height}px`,
        gridTemplateColumns: grid.gridTemplateColumns,
        columnGap: grid.columnGap,
        alignItems: grid.alignItems,
        left: "0px",
        top: "0px",
      });
      form.append(ghost);
      // Where 0, 0 lands: an ancestor with a transform holds a fixed box.
      const at = ghost.getBoundingClientRect();
      origin = { x: at.left, y: at.top };
      row.classList.add("dragging");
      form.classList.add("dragging");
      form.setPointerCapture(down.pointerId);
      window.getSelection()?.removeAllRanges();
      if (scroller) frame = requestAnimationFrame(scrollNearEdge);
    };
    // The row goes before the first other row whose middle lies below the
    // lifted copy's, so a row passed over moves out of its way.
    const follow = () => {
      if (!ghost) return;
      ghost.style.left = `${pointer.x - grab.x - origin.x}px`;
      ghost.style.top = `${pointer.y - grab.y - origin.y}px`;
      const middle = pointer.y - grab.y + grab.height / 2;
      const others = rows().filter((each) => each !== row);
      const next = others.find((each) => {
        const { top, bottom } = each.getBoundingClientRect();
        return (top + bottom) / 2 > middle;
      });
      const before = next ?? others.at(-1)?.nextElementSibling ?? null;
      if (before !== row && row.nextElementSibling !== before) form.insertBefore(row, before);
    };
    // The list scrolls under a lifted copy near its top or bottom edge, faster
    // the nearer the copy is.
    const scrollNearEdge = () => {
      if (!scroller) return;
      const edge = scroller.getBoundingClientRect();
      const reach = Math.min(50, edge.height / 3);
      const top = pointer.y - grab.y;
      const bottom = top + grab.height;
      const lean =
        top < edge.top + reach
          ? (top - edge.top - reach) / reach
          : bottom > edge.bottom - reach
            ? (bottom - edge.bottom + reach) / reach
            : 0;
      if (lean !== 0) {
        scroller.scrollTop += Math.round(10 * Math.max(-1, Math.min(1, lean)));
        follow();
      }
      frame = requestAnimationFrame(scrollNearEdge);
    };
    const settle = () => {
      if (frame) cancelAnimationFrame(frame);
      ghost?.remove();
      row.classList.remove("dragging");
      form.classList.remove("dragging");
      if (form.hasPointerCapture(down.pointerId)) form.releasePointerCapture(down.pointerId);
    };
    const putBack = () => {
      form.insertBefore(row, home);
      settle();
      button.focus({ preventScroll: true });
    };
    const onMove = (event: PointerEvent) => {
      if (cancelled) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!ghost) {
        if (Math.hypot(pointer.x - down.clientX, pointer.y - down.clientY) < DRAG_THRESHOLD_PX) return;
        lift();
      }
      follow();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ghost || cancelled) return;
      event.preventDefault();
      event.stopPropagation();
      cancelled = true;
      putBack();
    };
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey, true);
      if (!ghost) return;
      swallowClick = true;
      setTimeout(() => {
        swallowClick = false;
      });
      if (cancelled) return;
      if (!drop) return putBack();
      settle();
      moveProperty(key, rows().indexOf(row));
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey, true);
  }

  // Moves `key` to place `to` among the keys and saves. Focus goes back to
  // its icon, which the rebuild replaces.
  function moveProperty(key: string, to: number): void {
    const keys = Object.keys(data);
    const from = keys.indexOf(key);
    if (from === -1 || to === from || to < 0 || to >= keys.length) return;
    keys.splice(to, 0, ...keys.splice(from, 1));
    refill(keys.map((each) => [each, data[each]]));
    onChange();
    render();
    container
      .querySelector<HTMLElement>(`.property-editor-row[data-key="${CSS.escape(key)}"] .property-menu-button`)
      ?.focus();
  }

  // Focus moves to the row that takes the removed one's place, or to Add
  // property: the rebuild takes the menu's button with it, which would drop
  // focus back to the top of the page.
  function removeProperty(key: string): void {
    const index = Object.keys(data).indexOf(key);
    delete data[key];
    onChange();
    onStructuralChange?.();
    render();
    const buttons = container.querySelectorAll<HTMLElement>(".property-menu-button");
    (buttons[index] ?? buttons[index - 1] ?? container.querySelector<HTMLElement>(".data-table-add-row"))?.focus();
  }

  // The publication date keeps its text input, so a full timestamp stays
  // editable by hand, and adds a calendar button beside it. The value is
  // always kept a string: coerced, a bare year would become a number. A pick
  // replaces only the leading date, so a timestamp keeps its time and offset.
  function appendDatePicker(cell: HTMLElement, input: HTMLInputElement, key: string): void {
    input.placeholder = "YYYY-MM-DD";
    input.addEventListener("input", () => {
      data[key] = input.value;
      onChange();
    });

    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button property-editor-date-button";
    button.setAttribute("aria-label", "Pick a date");
    button.addEventListener("click", () =>
      openDatePicker({
        anchor: button,
        value: input.value,
        onPick: (picked) => {
          const rest = parseDatePrefix(input.value) && picked ? input.value.trim().slice(10) : "";
          input.value = picked + rest;
          data[key] = input.value;
          onChange();
        },
      }),
    );
    cell.append(input, button);
  }

  // One property's row: its icon, which opens its menu, its renamable key,
  // and its value cell — the properties-panel counterpart to a table row,
  // with an extra editable key column a table's fixed columns don't need.
  function buildRow(key: string): HTMLElement {
    const row = document.createElement("div");
    row.className = "property-editor-row";
    row.dataset.key = key;

    const keyCell = document.createElement("span");
    keyCell.className = "property-editor-key-cell";
    keyCell.appendChild(buildIcon(key));
    row.appendChild(keyCell);

    const readOnly = readOnlyKeys?.includes(key) ?? false;

    if (readOnly) {
      const keyLabel = document.createElement("span");
      keyLabel.className = "property-editor-key property-editor-key-fixed";
      keyLabel.textContent = key;
      keyCell.appendChild(keyLabel);
    } else {
      const keyInput = document.createElement("input");
      keyInput.type = "text";
      keyInput.className = "form-input form-input-quiet property-editor-key";
      keyInput.dataset.tooltipOverflow = "";
      keyInput.value = key;
      keyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") keyInput.blur();
      });
      keyInput.addEventListener("blur", () => {
        const nextKey = keyInput.value.trim();
        if (!nextKey || nextKey === key || nextKey in data || readOnlyKeys?.includes(nextKey)) {
          keyInput.value = key;
          return;
        }
        // Rebuilt rather than delete-then-set, which would move the renamed
        // property to the end.
        refill(Object.entries(data).map(([each, value]) => [each === key ? nextKey : each, value]));
        onChange();
        render();
      });
      keyCell.appendChild(keyInput);
    }

    row.appendChild(
      readOnly ? buildReadOnlyValue(key) : key === "pragma" && context ? emptyValue() : buildValueCell(key),
    );
    return row;
  }

  function emptyValue(): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "property-editor-value";
    return cell;
  }

  function buildReadOnlyValue(key: string): HTMLElement {
    const cell = document.createElement("div");
    cell.className = "property-editor-value";
    const text = document.createElement("span");
    text.className = "property-editor-value-readonly";
    text.dataset.tooltipOverflow = "";
    const value = data[key];
    text.textContent = Array.isArray(value) ? value.join(", ") : String(value ?? "");
    cell.appendChild(text);
    return cell;
  }

  // Adds a new blank property (key "property", "property 2", ... on
  // collision) and focuses its key input for immediate renaming. Shared by
  // the "+ Add property" button below and the document pane's "Add property"
  // command, which flashes the row handed back: the button sits beside it.
  function addProperty(): HTMLElement | undefined {
    let key = "property";
    let suffix = 1;
    while (key in data) key = `property ${++suffix}`;
    data[key] = "";
    onChange();
    onStructuralChange?.();
    render();
    const row = container.querySelector<HTMLElement>(`.property-editor-row[data-key="${CSS.escape(key)}"]`);
    const keyInput = row?.querySelector<HTMLInputElement>(".property-editor-key");
    keyInput?.focus();
    keyInput?.select();
    return row ?? undefined;
  }

  // Renders `container` from `data`. Called on open/reload/tab-restore and
  // after every structural edit (add/delete a property, rename a key); a pill
  // add/remove or a scalar value's keystroke updates the DOM in place
  // instead, rather than tearing down every row on each keystroke.
  function render(): void {
    const form = document.createElement("div");
    form.className = "property-editor";

    for (const key of Object.keys(data)) {
      form.appendChild(buildRow(key));
      const card = key === "pragma" ? context?.card(data) : undefined;
      if (card) form.appendChild(card);
    }

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "action-button data-table-add-row";
    addButton.textContent = "+ Add property";
    addButton.addEventListener("click", addProperty);
    form.appendChild(addButton);

    container.replaceChildren(form);
    // Painted again once the vocabulary is read afresh, so a color changed
    // under Tags shows on the next render.
    if (tags) paintTagPills(container, tags);
  }

  return { render, addProperty };
}

// The nearest ancestor that scrolls, which a drag scrolls near its edges.
function scrollParent(from: HTMLElement): HTMLElement | undefined {
  for (let el = from.parentElement; el; el = el.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(el).overflowY)) return el;
  }
  return undefined;
}
