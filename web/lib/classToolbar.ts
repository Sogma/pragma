// A Class's own controls in its pane's floating toolbar: Filter, Sort,
// Group, Fields and Links, each named for what it does and opening a popover
// that changes the Class as it is used, with no mode to enter first. The
// pane owns the Class and saves it; this only builds the controls and
// hands each change back.

import { cardWithField } from "../../src/protocol/card.ts";
import {
  CLASS_FIELD_TYPE_OPTIONS,
  type ClassLinkUse,
  canBeFieldKey,
  FILE_FIELDS,
  fieldLabel,
  holdsTags,
  isThisFolder,
  THIS_FOLDER,
  viewFields,
} from "../../src/protocol/class.ts";
import { isNamed } from "../../src/protocol/entryName.ts";
import {
  type ClassFile,
  type ClassRule,
  type ClassView,
  FILTER_TESTS,
  type TableColumn,
} from "../../src/protocol/types.ts";
import type { EntryIcon } from "../core/paths.ts";
import { el, setEntryIcon } from "./dom.ts";
import { createFieldPopover } from "./fieldPopover.ts";
import { type Flyout, openFlyout } from "./flyout.ts";

// "rows" marks a change to which rows the Class holds, its own filter,
// which the host reads again once the file is written.
export type ChangeScope = "view" | "rows";

export interface ClassToolbarDeps {
  // The Class as the pane holds it, the view showing, and whether
  // either may change now.
  current(): { file: ClassFile; view: ClassView; editable: boolean } | undefined;
  // The keys the rows' frontmatter uses, offered where a filter or a field
  // names one; `list` says whether any row holds a list there.
  keys(): { key: string; list: boolean }[];
  change(edit: (file: ClassFile, view: ClassView) => void, scope: ChangeScope): void;
  // A tree's folder row dropped on the popover, as the Folder value naming
  // it, or why it can't be one. Undefined for a drop that isn't a tree row's.
  droppedFolder(event: DragEvent): { folder: string } | { refused: string } | undefined;
  // Offers the files a Class can link at `anchor`, handing the one picked
  // to `pick` written from the Class's folder.
  pickFile(anchor: HTMLElement, pick: (link: string) => void): void;
  // A tree's file row dropped on Links, written from the Class's folder, or
  // why it can't be one. Undefined for a drop that isn't a tree row's.
  droppedFile(event: DragEvent): { link: string } | { refused: string } | undefined;
  // A link as Links shows it: what it gives the rows, and its file's icon,
  // name and path.
  describeLink(link: string): { use: ClassLinkUse; icon: EntryIcon; name: string; path: string };
}

export type ClassTool = "filter" | "sort" | "group" | "fields" | "links";

export interface ClassToolbar {
  readonly element: HTMLElement;
  // Re-reads the Class: what each button says, and whether they show.
  update(): void;
  // Opens Filter on this view's filters, as a chip under the title asks.
  openFilter(): void;
  // Fits the buttons to a pane `width` wide. Too narrow for them beside a
  // title, they leave the toolbar, and the pane's ⋮ menu offers them.
  fitTo(width: number): void;
  isFolded(): boolean;
  // Opens a button's panel, under the toolbar while the button is folded.
  openTool(tool: ClassTool): void;
  close(): void;
}

// What a title keeps at the toolbar's left, with the reading toggle and ⋮
// beside the buttons, before they fold.
const TITLE_ROOM = 320;

const TEST_LABELS: Record<string, string> = {
  has: "has",
  is: "is",
  contains: "contains",
  empty: "is empty",
  "not-empty": "is not empty",
  within: "is within",
};

/** A rule as a person reads it, for a chip: "status is approved". A file's
 * own fact is named as its field is, field or not. */
export function describeRule(rule: ClassRule, fields: readonly TableColumn[]): string {
  const named = (each: TableColumn) => each.id === rule.property;
  const property = fields.find(named)?.label ?? FILE_FIELDS.find(named)?.label ?? rule.property;
  const test = TEST_LABELS[rule.test] ?? rule.test;
  const values = rule.values.map((value) =>
    rule.property === "file.folder" && isThisFolder(value) ? "This folder" : value,
  );
  return values.length > 0 ? `${property} ${test} ${values.join(" or ")}` : `${property} ${test}`;
}

// Two spellings of one Folder value: a trailing `/` and a leading `./` aside,
// and names in any case, as Folder matches them.
function sameFolderValue(a: string, b: string): boolean {
  const bare = (value: string) =>
    value
      .trim()
      .replace(/^\.\/(?=.)/, "")
      .replace(/(.)\/+$/, "$1");
  return isNamed(bare(a), bare(b));
}

// The tests a line offers on `property`: "is within" on Folder alone, and a
// test this build doesn't offer kept as the file wrote it.
function testsFor(property: string, current: string): { value: string; label: string }[] {
  const offered: string[] = [...FILTER_TESTS];
  if (property.trim() === "file.folder") offered.push("within");
  if (!offered.includes(current)) offered.push(current);
  return offered.map((test) => ({ value: test, label: TEST_LABELS[test] ?? test }));
}

// A filter line being edited. The Class holds a line only once it says
// something — a property, and values unless its test needs none — so a line
// just added, or emptied while typing, filters nothing rather than every row.
interface Line {
  property: string;
  test: string;
  values: string;
}

function lineOf(rule: ClassRule): Line {
  return { property: rule.property, test: rule.test, values: rule.values.join(", ") };
}

function needsValues(test: string): boolean {
  return test === "has" || test === "is" || test === "contains" || test === "within";
}

function ruleOf(line: Line): ClassRule | undefined {
  const property = line.property.trim();
  const values = line.values
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!property || (needsValues(line.test) && values.length === 0)) return undefined;
  return { property, test: line.test, values: needsValues(line.test) ? values : [] };
}

function iconButton(label: string, icon: string): HTMLButtonElement {
  const button = el("button", "icon-button class-icon-button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.appendChild(el("span", `class-icon class-icon-${icon}`));
  return button;
}

function textButton(label: string, className = "class-popover-add"): HTMLButtonElement {
  const button = el("button", className, label);
  button.type = "button";
  return button;
}

type SelectOption = { value: string; label: string };

function setOptions(element: HTMLSelectElement, options: readonly SelectOption[], value: string): void {
  element.replaceChildren(
    ...options.map((option) => Object.assign(el("option", undefined, option.label), { value: option.value })),
  );
  element.value = value;
}

function select(label: string, options: readonly SelectOption[], value: string): HTMLSelectElement {
  const element = el("select", "form-input popover-input");
  element.setAttribute("aria-label", label);
  setOptions(element, options, value);
  return element;
}

function popover(label: string): HTMLElement {
  const element = el("div", "popover class-popover");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", label);
  return element;
}

// A datalist is tied to its input by id, so each needs one of its own.
let datalistCount = 0;

export function createClassToolbar(deps: ClassToolbarDeps): ClassToolbar {
  const element = el("div", "class-toolbar");
  const button = (label: string): HTMLButtonElement => {
    const each = el("button", "flat-button class-toolbar-button");
    each.type = "button";
    each.setAttribute("aria-haspopup", "dialog");
    each.appendChild(el("span", "class-toolbar-label", label));
    return each;
  };
  const filterButton = button("Filter");
  // Every filter on this view, its own and the Class's, in the pill a count
  // wears on any control.
  const filterCount = el("span", "count-badge");
  const filterDigits = el("span");
  filterCount.append(filterDigits);
  filterCount.hidden = true;
  filterButton.appendChild(filterCount);
  const sortButton = button("Sort");
  const groupButton = button("Group");
  const fieldsButton = button("Fields");
  // How many files the Class links, in the same pill as Filter's count.
  const linksButton = button("Links");
  const linksCount = el("span", "count-badge");
  const linksDigits = el("span");
  linksCount.append(linksDigits);
  linksCount.hidden = true;
  linksButton.appendChild(linksCount);
  element.append(filterButton, sortButton, groupButton, fieldsButton, linksButton);

  let flyout: Flyout | undefined;
  let openedFrom: HTMLButtonElement | undefined;
  let filterScope: "view" | "all" = "view";
  // The buttons' width, taken while they show, and the pane's last.
  let folded = false;
  let natural = 0;
  let width = Number.POSITIVE_INFINITY;

  function close(): void {
    flyout?.close();
  }

  // A second press on the button showing its panel closes it. A folded
  // button's panel hangs under the toolbar, where ⋮ is, as does one ⋮ opens.
  function open(button: HTMLButtonElement | undefined, panel: HTMLElement): void {
    if (button && openedFrom === button && flyout) {
      close();
      return;
    }
    close();
    openedFrom = button;
    const anchor = folded || !button ? (element.closest<HTMLElement>(".editor-toolbar-box") ?? element) : button;
    button?.setAttribute("aria-expanded", "true");
    flyout = openFlyout(anchor, panel, () => {
      button?.setAttribute("aria-expanded", "false");
      flyout = undefined;
      openedFrom = undefined;
    });
  }

  function fitTo(next: number): void {
    width = next;
    if (!folded && !element.hidden) natural = element.scrollWidth;
    const fold = natural > 0 && width < natural + TITLE_ROOM;
    if (fold === folded) return;
    folded = fold;
    element.classList.toggle("is-folded", folded);
    close();
  }

  // The Class's fields, the keys its rows use, then a file's own facts.
  function keyList(): HTMLDataListElement {
    const list = el("datalist");
    list.id = `class-keys-${++datalistCount}`;
    const state = deps.current();
    const keys = new Set([
      ...(state?.file.fields.map((field) => field.id) ?? []),
      ...deps.keys().map((k) => k.key),
      ...FILE_FIELDS.map((fact) => fact.id),
    ]);
    for (const key of keys) list.appendChild(Object.assign(el("option"), { value: key }));
    return list;
  }

  // ---- Filter ----

  function filterPanel(): HTMLElement {
    const panel = popover("Filter");
    const lines = { view: [] as Line[], all: [] as Line[] };
    const state = deps.current();
    if (state) {
      lines.view = state.view.filter.map(lineOf);
      lines.all = state.file.filter.map(lineOf);
    }
    const datalist = keyList();
    const folderValues = el("datalist");
    folderValues.id = `class-folders-${++datalistCount}`;
    folderValues.appendChild(Object.assign(el("option"), { value: THIS_FOLDER, label: "This folder" }));

    const commit = (scope: "view" | "all"): void => {
      const rules = lines[scope].map(ruleOf).filter((rule): rule is ClassRule => rule !== undefined);
      updateScopeCounts();
      const now = deps.current();
      const before = scope === "view" ? now?.view.filter : now?.file.filter;
      if (JSON.stringify(before) === JSON.stringify(rules)) return;
      deps.change(
        (file, view) => {
          if (scope === "view") view.filter = rules;
          else file.filter = rules;
        },
        scope === "view" ? "view" : "rows",
      );
    };

    const scopes = el("div", "class-popover-scopes");
    scopes.setAttribute("role", "group");
    scopes.setAttribute("aria-label", "Which views");
    const scopeButton = (scope: "view" | "all", label: string): HTMLButtonElement => {
      const each = textButton(label, "class-popover-scope");
      const badge = el("span", "count-badge");
      badge.append(el("span"));
      badge.hidden = true;
      each.appendChild(badge);
      each.addEventListener("click", () => {
        filterScope = scope;
        draw();
      });
      return each;
    };
    // In the order they apply: the Class's own filter, then this view's.
    const allViews = scopeButton("all", "All views");
    const thisView = scopeButton("view", "This view");
    scopes.append(allViews, thisView);
    function updateScopeCounts(): void {
      const count = (scope: "view" | "all") => lines[scope].filter((line) => ruleOf(line)).length;
      for (const [each, scope] of [
        [thisView, "view"],
        [allViews, "all"],
      ] as const) {
        each.setAttribute("aria-pressed", String(filterScope === scope));
        const badge = each.querySelector<HTMLElement>(".count-badge");
        const digits = badge?.firstElementChild;
        if (!badge || !digits) continue;
        badge.hidden = count(scope) === 0;
        digits.textContent = String(count(scope));
      }
    }

    const body = el("div", "class-popover-body");
    panel.append(scopes, body, datalist, folderValues);

    function lineRow(scope: "view" | "all", line: Line, index: number): HTMLElement {
      const row = el("div", "class-filter-line");
      row.appendChild(el("span", "caption class-filter-lead", index === 0 ? "Where" : "and"));
      const property = el("input", "form-input popover-input class-filter-property");
      property.type = "text";
      property.value = line.property;
      property.placeholder = "Property";
      property.setAttribute("aria-label", "Property");
      property.setAttribute("list", datalist.id);
      const test = select("Test", [], line.test);
      const values = el("input", "form-input popover-input class-filter-values");
      values.type = "text";
      values.value = line.values;
      values.placeholder = "Value, value";
      values.setAttribute("aria-label", "Values");
      values.hidden = !needsValues(line.test);
      const remove = iconButton("Remove this filter", "x");

      // A Folder line offers "is within" and the Class's own folder by name,
      // as the property is typed. Leaving Folder takes "is within" with it,
      // which would hold on any other property.
      const fitTests = (): void => {
        const onFolder = property.value.trim() === "file.folder";
        if (!onFolder && line.test === "within") line.test = "is";
        setOptions(test, testsFor(property.value, line.test), line.test);
        if (onFolder) values.setAttribute("list", folderValues.id);
        else values.removeAttribute("list");
      };
      fitTests();
      property.addEventListener("input", fitTests);

      // A view's own filter narrows rows already here, so it applies as it
      // is typed; the Class's changes which rows the host reads, so it
      // applies once a value is complete.
      const live = scope === "view" ? "input" : "change";
      property.addEventListener(live, () => {
        line.property = property.value;
        commit(scope);
      });
      values.addEventListener(live, () => {
        line.values = values.value;
        commit(scope);
      });
      test.addEventListener("change", () => {
        line.test = test.value;
        values.hidden = !needsValues(line.test);
        commit(scope);
      });
      remove.addEventListener("click", () => {
        lines[scope].splice(index, 1);
        commit(scope);
        draw();
      });
      row.append(property, test, values, remove);
      return row;
    }

    function rulesSection(scope: "view" | "all"): HTMLElement[] {
      const rows = lines[scope].map((line, index) => lineRow(scope, line, index));
      const add = textButton("+ Add filter");
      add.addEventListener("click", () => {
        const known = deps.keys();
        lines[scope].push({ property: "", test: "is", values: "" });
        draw();
        const inputs = body.querySelectorAll<HTMLInputElement>(".class-filter-property");
        const input = inputs[inputs.length - 1];
        input?.focus();
        // A key holding tags or lists is filtered by what it has.
        input?.addEventListener(
          "change",
          () => {
            const line = lines[scope][lines[scope].length - 1];
            const key = line?.property.trim() ?? "";
            if (line && (holdsTags(key) || known.some((each) => each.key === key && each.list))) {
              line.test = "has";
              draw();
            }
          },
          { once: true },
        );
      });
      return [...rows, add];
    }

    // A folder dropped from the tree joins the first Folder line, or starts
    // one, so it reads as any filter does.
    const refusal = el("div", "inline-error class-popover-error");
    function addFolder(folder: string): void {
      const line = lines.all.find(
        (each) => each.property.trim() === "file.folder" && (each.test === "is" || each.test === "within"),
      );
      if (line) {
        const values = line.values
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
        if (values.some((each) => sameFolderValue(each, folder))) return;
        line.values = [...values, folder].join(", ");
      } else {
        lines.all.push({ property: "file.folder", test: "is", values: folder });
      }
      commit("all");
      draw();
    }

    // The whole popover takes the drop, not just the field: a small input is
    // a hard target to hit from across the window.
    panel.addEventListener("dragover", (event) => {
      if (filterScope !== "all") return;
      event.preventDefault();
      panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", (event) => {
      if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove("drag-over");
    });
    panel.addEventListener("drop", (event) => {
      panel.classList.remove("drag-over");
      if (filterScope !== "all") return;
      const dropped = deps.droppedFolder(event);
      if (!dropped) return;
      event.preventDefault();
      if ("refused" in dropped) {
        refusal.textContent = dropped.refused;
        refusal.hidden = false;
        return;
      }
      addFolder(dropped.folder);
    });

    function draw(): void {
      body.replaceChildren();
      if (filterScope === "all") {
        refusal.hidden = true;
        body.append(...rulesSection("all"), refusal);
        body.appendChild(
          el(
            "div",
            "caption class-popover-note",
            "Every view starts from these. Drag a folder in from the tree to add it.",
          ),
        );
      } else {
        body.append(...rulesSection("view"));
      }
      updateScopeCounts();
      flyout?.reposition();
    }
    draw();
    return panel;
  }

  // ---- Sort and Group ----

  function fieldOptions(fields: readonly TableColumn[], current: string | undefined) {
    const options = [{ value: "", label: "None" }, ...fields.map((field) => ({ value: field.id, label: field.label }))];
    if (current && !fields.some((field) => field.id === current)) options.push({ value: current, label: current });
    return options;
  }

  function sortPanel(): HTMLElement {
    const panel = popover("Sort");
    const state = deps.current();
    if (!state) return panel;
    const by = select(
      "Sort by",
      fieldOptions(state.file.fields, state.view.sort?.property),
      state.view.sort?.property ?? "",
    );
    const order = select(
      "Order",
      [
        { value: "asc", label: "Ascending" },
        { value: "desc", label: "Descending" },
      ],
      state.view.sort?.order ?? "asc",
    );
    const orderField = el("label", "popover-field class-popover-row");
    orderField.append(el("span", "caption class-popover-heading", "Order"), order);
    orderField.hidden = !by.value;
    const apply = (): void => {
      orderField.hidden = !by.value;
      deps.change((_file, view) => {
        if (by.value) view.sort = { property: by.value, order: order.value === "desc" ? "desc" : "asc" };
        else delete view.sort;
      }, "view");
    };
    by.addEventListener("change", apply);
    order.addEventListener("change", apply);
    const byField = el("label", "popover-field class-popover-row");
    byField.append(el("span", "caption class-popover-heading", "Sort by"), by);
    panel.append(byField, orderField);
    return panel;
  }

  function groupPanel(): HTMLElement {
    const panel = popover("Group");
    const state = deps.current();
    if (!state) return panel;
    const by = select("Group by", fieldOptions(state.file.fields, state.view.groupBy), state.view.groupBy ?? "");
    by.addEventListener("change", () => {
      deps.change((_file, view) => {
        if (by.value) view.groupBy = by.value;
        else delete view.groupBy;
      }, "view");
    });
    const byField = el("label", "popover-field class-popover-row");
    byField.append(el("span", "caption class-popover-heading", "Group by"), by);
    panel.appendChild(byField);
    return panel;
  }

  // ---- Fields ----

  // A view that lists no fields shows every one; the first change to what
  // it shows writes the list out, in the order it showed them.
  function shownKeys(file: ClassFile, view: ClassView): string[] {
    return viewFields(file.fields, view).map((field) => field.id);
  }

  function fieldsPanel(): HTMLElement {
    const panel = popover("Fields");
    const body = el("div", "class-popover-body");
    panel.appendChild(body);

    function draw(): void {
      body.replaceChildren();
      const state = deps.current();
      if (!state) return;
      const shown = shownKeys(state.file, state.view);
      const ordered = [
        ...shown.flatMap((key) => state.file.fields.find((field) => field.id === key) ?? []),
        ...state.file.fields.filter((field) => !shown.includes(field.id)),
      ];
      if (ordered.length > 0) body.appendChild(el("div", "caption class-popover-heading", "Shown in this view"));
      for (const field of ordered) {
        const row = el("div", "class-field-row");
        const label = el("label", "popover-checkbox");
        const box = el("input");
        box.type = "checkbox";
        box.checked = shown.includes(field.id);
        label.append(box, field.label);
        box.addEventListener("change", () => {
          deps.change((file, view) => {
            const keys = shownKeys(file, view).filter((key) => key !== field.id);
            view.fields = box.checked ? [...keys, field.id] : keys;
          }, "view");
          draw();
        });
        row.appendChild(label);
        const at = shown.indexOf(field.id);
        if (at !== -1) {
          const move = (by: number): void => {
            deps.change((file, view) => {
              const keys = shownKeys(file, view);
              const [moved] = keys.splice(at, 1);
              keys.splice(at + by, 0, moved);
              view.fields = keys;
            }, "view");
            draw();
          };
          const up = iconButton(`Move ${field.label} up`, "arrow-up");
          up.disabled = at === 0;
          up.addEventListener("click", () => move(-1));
          const down = iconButton(`Move ${field.label} down`, "arrow-down");
          down.disabled = at === shown.length - 1;
          down.addEventListener("click", () => move(1));
          row.append(up, down);
        }
        body.appendChild(row);
      }
      const add = textButton("+ Add field");
      add.addEventListener("click", () => openAddField());
      body.appendChild(add);
      // A file's own facts take no key or type: each is added once, as itself.
      const facts = FILE_FIELDS.filter((fact) => !state.file.fields.some((field) => field.id === fact.id));
      if (facts.length > 0) {
        body.appendChild(el("div", "caption class-popover-heading", "From the file"));
        const row = el("div", "class-popover-facts");
        for (const fact of facts) {
          const each = textButton(`+ ${fact.label}`);
          each.addEventListener("click", () => {
            deps.change((file, view) => {
              file.fields.push({ id: fact.id, type: fact.type, label: fact.label });
              file.card = cardWithField(file.card, fact.id);
              if (view.fields) view.fields.push(fact.id);
            }, "view");
            draw();
          });
          row.appendChild(each);
        }
        body.appendChild(row);
      }
      flyout?.reposition();
    }
    draw();
    return panel;
  }

  // ---- Links ----

  // What each kind of link gives the rows, said by its section's heading.
  const LINK_SECTIONS: readonly { use: ClassLinkUse; heading: string; gives: string }[] = [
    { use: "toolkit", heading: "Flows", gives: "buttons in each note's Tools tab" },
    { use: "template", heading: "Templates", gives: "New note starts from one" },
    { use: "reference", heading: "Files", gives: "in each note's Links tab" },
  ];

  // The files the Class links its rows to, by what each gives them.
  function linksPanel(): HTMLElement {
    const panel = popover("Links");
    const body = el("div", "class-popover-body");
    const refusal = el("div", "inline-error class-popover-error");
    panel.appendChild(body);

    function add(link: string): void {
      deps.change((file) => {
        if (!file.links.includes(link)) file.links.push(link);
      }, "view");
      draw();
    }

    function draw(): void {
      body.replaceChildren();
      const links = deps.current()?.file.links ?? [];
      const described = links.map((link, index) => ({ index, ...deps.describeLink(link) }));
      for (const { use, heading, gives } of LINK_SECTIONS) {
        const shown = described.filter((link) => link.use === use);
        if (shown.length === 0) continue;
        const title = el("div", "caption class-popover-heading", heading);
        title.appendChild(el("span", "class-links-gives", ` · ${gives}`));
        body.appendChild(title);
        for (const { index, icon, name, path } of shown) {
          const row = el("div", "class-link");
          const glyph = el("span");
          setEntryIcon(glyph, icon);
          const label = el("span", "class-link-name", name);
          label.dataset.tooltip = path;
          const remove = iconButton("Remove this link", "x");
          remove.addEventListener("click", () => {
            deps.change((file) => file.links.splice(index, 1), "view");
            draw();
          });
          row.append(glyph, label, remove);
          body.appendChild(row);
        }
      }
      const pick = textButton("+ Add file");
      pick.addEventListener("click", () => deps.pickFile(pick, add));
      refusal.hidden = true;
      body.append(pick, refusal, el("div", "caption class-popover-note", "or drag one in from the tree"));
      if (links.length === 0) {
        body.appendChild(
          el(
            "div",
            "caption class-popover-note",
            "A Flow gives each note its buttons, a template from _templates starts each new note, and any other file shows in each note's Links tab.",
          ),
        );
      }
      flyout?.reposition();
    }

    panel.addEventListener("dragover", (event) => {
      event.preventDefault();
      panel.classList.add("drag-over");
    });
    panel.addEventListener("dragleave", (event) => {
      if (!panel.contains(event.relatedTarget as Node | null)) panel.classList.remove("drag-over");
    });
    panel.addEventListener("drop", (event) => {
      panel.classList.remove("drag-over");
      const dropped = deps.droppedFile(event);
      if (!dropped) return;
      event.preventDefault();
      if ("link" in dropped) {
        add(dropped.link);
        return;
      }
      refusal.textContent = dropped.refused;
      refusal.hidden = false;
    });

    draw();
    return panel;
  }

  // The field's key is the frontmatter key it reads, and its label starts
  // as that key.
  function openAddField(): void {
    const state = deps.current();
    if (!state) return;
    const taken = new Set(state.file.fields.map((field) => field.id));
    const { element: form, focus } = createFieldPopover({
      title: "Add field",
      nameLabel: "Property",
      typeLabel: "Field type",
      types: CLASS_FIELD_TYPE_OPTIONS,
      suggestions: deps
        .keys()
        .map((each) => each.key)
        .filter((key) => !taken.has(key)),
      acceptsName: (name) => canBeFieldKey(name) && !taken.has(name),
      onSubmit: ({ label: key, type, options, default: fill, max, reject }) => {
        const field: TableColumn = { id: key, type: type as TableColumn["type"], label: fieldLabel(key) };
        if (options) field.options = options;
        if (fill) field.default = fill;
        if (max !== undefined) field.max = max;
        if (reject) field.reject = reject;
        deps.change((file, view) => {
          file.fields.push(field);
          file.card = cardWithField(file.card, key);
          if (view.fields) view.fields.push(key);
        }, "view");
        close();
      },
      onCancel: close,
    });
    close();
    open(fieldsButton, form);
    focus();
  }

  // Filter opens on the Class's own filter, where a first filter defines the
  // Class, unless this view has filters of its own. A chip opens on the
  // view's, where its filter lives.
  function openFilter(scope?: "view" | "all"): void {
    filterScope = scope ?? ((deps.current()?.view.filter.length ?? 0) > 0 ? "view" : "all");
    open(filterButton, filterPanel());
  }

  const tools: Record<ClassTool, () => void> = {
    filter: () => openFilter(),
    sort: () => open(sortButton, sortPanel()),
    group: () => open(groupButton, groupPanel()),
    fields: () => open(fieldsButton, fieldsPanel()),
    links: () => open(linksButton, linksPanel()),
  };
  filterButton.addEventListener("click", tools.filter);
  sortButton.addEventListener("click", tools.sort);
  groupButton.addEventListener("click", tools.group);
  fieldsButton.addEventListener("click", tools.fields);
  linksButton.addEventListener("click", tools.links);

  return {
    element,
    update() {
      const state = deps.current();
      element.hidden = !state?.editable;
      if (!state?.editable) close();
      if (!state) return;
      const count = state.view.filter.length + state.file.filter.length;
      filterCount.hidden = count === 0;
      filterDigits.textContent = String(count);
      filterButton.setAttribute("aria-pressed", String(count > 0));
      sortButton.setAttribute("aria-pressed", String(state.view.sort !== undefined));
      groupButton.setAttribute("aria-pressed", String(state.view.groupBy !== undefined));
      linksCount.hidden = state.file.links.length === 0;
      linksDigits.textContent = String(state.file.links.length);
      linksButton.setAttribute("aria-pressed", String(state.file.links.length > 0));
      // Shown again, or with a count that widens it: measured anew.
      fitTo(width);
    },
    openFilter() {
      if (openedFrom !== filterButton) openFilter("view");
    },
    fitTo,
    isFolded: () => folded && !element.hidden,
    openTool: (tool) => tools[tool](),
    close,
  };
}
