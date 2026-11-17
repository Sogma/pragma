// The Format column: a document's formatting buttons in a column under the
// editor toolbar's box, and a picker whose menu holds everything the format
// offers, the kinds a line can be first. The format says what it offers; the
// column draws that for one editor, each button pressed while the selection
// is in what it applies, and greyed where it can't run.
//
// A drag on its foot brings the tools past the usual ones in below them, and
// sends them back the same way.
import type { EditorView } from "@codemirror/view";
import { must } from "./lib/dom.ts";
import { wirePanelResize } from "./lib/panelResize.ts";
import { closeTooltip, showTooltipFor } from "./lib/tooltip.ts";
import { applyFormat, type FormatAction, type FormatActions } from "./services/formats.ts";
import type { ContextMenuService, MenuItem } from "./services/menus.ts";
import type { Setting } from "./services/settings.ts";

export interface FormatColumnDeps {
  contextMenu: ContextMenuService;
  // A command's chord as a person reads it, for a button's tooltip.
  shortcutFor(command: string): string | undefined;
  // The group's Source mode, which the column offers as ⋮ does.
  sourceMode: { isOn(): boolean; toggle(): void };
  // Where the column's room ends: the bottom of the pane it sits over.
  bottom(): number;
  // How many tools past the format's usual ones the column holds, fewer
  // below 0: where a drag on its foot left it, in every group.
  extra: Setting<number>;
  // Turns the column off, as ⋮'s Format… does.
  close(): void;
  // Moves the cursor into the title bar where the pane shows one, and says
  // whether it did: what the title's kind of line does there.
  toTitle(): boolean;
}

export interface FormatColumn {
  readonly element: HTMLElement;
  // Draws `actions` for `view`, or hides the column for none. `slide` moves
  // it in or out, for a person's toggle rather than a tab switch.
  show(target: { view: EditorView; actions: FormatActions } | undefined, slide: boolean): void;
  // Presses each button for what the selection is in now.
  update(): void;
  // The pane changed size: tools that no longer fit leave the column, the
  // last to come in first.
  fitToRoom(): void;
  dispose(): void;
}

// A tool, a button in the column while it fits.
interface Entry {
  button: HTMLButtonElement;
  group: string;
  // One of the format's usual tools, which leave the column only after
  // every other tool has; the rest start out of it.
  usual: boolean;
  last: boolean;
  command?: string;
  isOn?(): boolean;
  applies?(): boolean;
}

const BOTTOM_MARGIN = 16;

function glyphButton(className: string, label: string, glyph: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button ${className}`;
  button.setAttribute("aria-label", label);
  // Beside the button: below it, a tooltip would cover the next one.
  button.dataset.tooltipSide = "left";
  const icon = document.createElement("span");
  icon.className = "format-column-glyph";
  icon.style.setProperty("--format-glyph", `var(--icon-${glyph})`);
  button.append(icon);
  // A press leaves focus in the editor, and with it the selection the
  // button acts on.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  return button;
}

function separator(): HTMLElement {
  const line = document.createElement("span");
  line.className = "format-column-line";
  line.setAttribute("aria-hidden", "true");
  return line;
}

function menuRow(
  label: string,
  glyph: string,
  group: string,
  run: () => void,
  checked?: () => boolean,
  disabled?: () => boolean,
): MenuItem {
  return {
    label,
    group,
    icon: true,
    className: "format-menu-row",
    style: { "--format-glyph": `var(--icon-${glyph})` },
    checked,
    disabled,
    run,
  };
}

export function createFormatColumn(deps: FormatColumnDeps): FormatColumn {
  const element = document.createElement("div");
  element.className = "floating-toolbar format-column";
  element.setAttribute("role", "toolbar");
  element.setAttribute("aria-label", "Format");
  element.setAttribute("aria-orientation", "vertical");
  element.hidden = true;

  let target: { view: EditorView; actions: FormatActions } | undefined;
  let drawn: FormatActions | undefined;
  // Every tool from top to bottom, the picker and Close aside: the usual
  // ones, then those a drag brings in, so a drag up takes the lowest first,
  // then a `last` one and Source mode.
  //
  // Then the same tools in the order they come into the column. A `last`
  // tool and Source mode come first, so a shrinking column sends every other
  // tool out before them; then the other usual tools, then the rest.
  let entries: Entry[] = [];
  let rank: Entry[] = [];
  let usual = 0;
  // How many of `rank` the column holds.
  let held = 0;
  // The picker's menu: the kinds a line can be, then every other tool in the
  // column's order, whether the column shows it or not.
  let kinds: FormatAction[] = [];
  let others: FormatAction[] = [];

  function apply(action: FormatAction): void {
    if (!target || (action.title && deps.toTitle())) return;
    applyFormat(target.actions, action.id, target.view);
    target.view.focus();
  }

  const isOn = (action: FormatAction) =>
    action.isOn && (() => (target && action.isOn ? action.isOn(target.view.state) : false));

  const applies = (action: FormatAction) =>
    action.applies && (() => (target && action.applies ? action.applies(target.view.state) : true));

  const greyed = (action: FormatAction) => {
    const can = applies(action);
    return can && (() => !can());
  };

  const actionRow = (action: FormatAction): MenuItem => ({
    ...menuRow(action.label, action.glyph, action.group, () => apply(action), isOn(action), greyed(action)),
    toggle: true,
  });

  function actionEntry(action: FormatAction): Entry {
    const button = glyphButton("format-column-button", action.label, action.glyph);
    if (action.isOn) button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => apply(action));
    return {
      button,
      group: action.group,
      usual: !action.more,
      last: action.last === true,
      command: `format.${action.id}`,
      isOn: isOn(action),
      applies: applies(action),
    };
  }

  // Its glyph is the format's, set as each format's tools are drawn.
  let sourceGlyph = "source-mode";
  const sourceButton = glyphButton("format-column-button", "Source mode", sourceGlyph);
  sourceButton.setAttribute("aria-pressed", "false");
  sourceButton.addEventListener("click", () => deps.sourceMode.toggle());
  const source: Entry = {
    button: sourceButton,
    group: "source",
    usual: true,
    last: false,
    command: "editor.toggleSourceMode",
    isOn: () => deps.sourceMode.isOn(),
  };

  // Its glyph is the caret's kind of line, the kind its menu checks.
  const picker = glyphButton("format-column-picker", "Formatting", "pilcrow");
  const pickerGlyph = must<HTMLElement>(".format-column-glyph", picker);
  picker.setAttribute("aria-haspopup", "menu");
  picker.setAttribute("aria-expanded", "false");
  picker.addEventListener("click", () => {
    if (!target) return;
    if (deps.contextMenu.isOpen(picker)) {
      deps.contextMenu.close();
      return;
    }
    const { view } = target;
    const choose = (line: FormatAction) => () => {
      if (line.title && deps.toTitle()) return;
      if (!line.isOn?.(view.state)) line.run(view);
      view.focus();
    };
    const items = [
      ...kinds.map((line) => menuRow(line.label, line.glyph, line.group, choose(line), isOn(line), greyed(line))),
      ...others.map(actionRow),
    ];
    deps.contextMenu.open({ items, anchor: picker, beside: true, picker: true, ariaLabel: "Formatting" });
  });

  // At the column's foot, as Find's card ends in its own close button.
  const close = glyphButton("format-column-close", "Close", "x");
  close.addEventListener("click", () => deps.close());

  const handle = document.createElement("div");
  handle.className = "format-column-handle";

  function build(actions: FormatActions): void {
    drawn = actions;
    sourceGlyph = actions.sourceGlyph ?? "source-mode";
    must<HTMLElement>(".format-column-glyph", sourceButton).style.setProperty(
      "--format-glyph",
      `var(--icon-${sourceGlyph})`,
    );
    const ordered = [
      ...actions.tools.filter((tool) => !tool.more && !tool.last),
      ...actions.tools.filter((tool) => tool.more && !tool.last),
      ...actions.tools.filter((tool) => tool.last),
    ];
    kinds = actions.lines.filter((line) => !line.unlistedKind);
    others = ordered.filter((tool) => !kinds.includes(tool));
    entries = [...ordered.map(actionEntry), source];
    const kept = (entry: Entry) => entry.last || entry === source;
    rank = [
      ...entries.filter((entry) => entry.usual && kept(entry)),
      ...entries.filter((entry) => entry.usual && !kept(entry)),
      ...entries.filter((entry) => !entry.usual),
    ];
    usual = rank.filter((entry) => entry.usual).length;
    const nodes: HTMLElement[] = [picker];
    let group = "picker";
    for (const entry of entries) {
      if (entry.group !== group) nodes.push(separator());
      group = entry.group;
      nodes.push(entry.button);
    }
    nodes.push(separator(), close, handle);
    element.replaceChildren(...nodes);
  }

  // A line shows only between two buttons still in the column.
  function tidy(): void {
    let seen = false;
    let waiting: HTMLElement | undefined;
    for (const node of element.children) {
      if (!(node instanceof HTMLElement) || node === handle) continue;
      if (node.classList.contains("format-column-line")) {
        node.hidden = true;
        if (seen && !waiting) waiting = node;
        continue;
      }
      if (node.hidden) continue;
      if (waiting) waiting.hidden = false;
      waiting = undefined;
      seen = true;
    }
  }

  // Puts the first `count` tools of `rank` in the column, each in its place.
  function draw(count: number): void {
    const inColumn = new Set(rank.slice(0, count));
    for (const entry of entries) entry.button.hidden = !inColumn.has(entry);
    tidy();
  }

  function update(): void {
    if (!target || element.hidden) return;
    for (const entry of entries) {
      if (entry.isOn) entry.button.setAttribute("aria-pressed", String(entry.isOn()));
      if (entry.applies) entry.button.disabled = !entry.applies();
    }
    const { view, actions } = target;
    const line = actions.lines.find((each) => each.isOn?.(view.state)) ?? actions.plain;
    pickerGlyph.style.setProperty("--format-glyph", `var(--icon-${line.glyph})`);
    // Where nothing in its menu can run, such as in the boneyard, the picker
    // is greyed.
    picker.disabled = ![...kinds, ...others].some((each) => each.applies?.(view.state) !== false);
  }

  function fitToRoom(): void {
    let count = Math.max(0, Math.min(entries.length, usual + deps.extra.get()));
    draw(count);
    if (target && !element.hidden && element.isConnected) {
      const room = deps.bottom() - element.getBoundingClientRect().top - BOTTOM_MARGIN;
      while (count > 0 && element.offsetHeight > room) draw(--count);
    }
    held = count;
  }

  // The column follows the pointer a whole tool at a time, each coming in
  // once the pointer passes half its height. Each count's height and the
  // most the pane has room for are measured as the drag starts.
  let heights: number[] = [];
  let fit = 0;
  const resize = wirePanelResize({
    handle,
    axis: "ns",
    minSize: 0,
    beginDrag() {
      const top = element.getBoundingClientRect().top;
      const room = deps.bottom() - top - BOTTOM_MARGIN;
      heights = [];
      fit = 0;
      for (let count = 0; count <= entries.length; count++) {
        draw(count);
        heights.push(element.offsetHeight);
        if (count === fit + 1 && heights[count] <= room) fit = count;
      }
      draw(held);
      return (event) => event.clientY - top;
    },
    apply(size) {
      let count = 0;
      for (let each = 1; each <= fit; each++) {
        if (Math.abs(heights[each] - size) < Math.abs(heights[count] - size)) count = each;
      }
      if (count === held) return;
      const grew = count > held;
      draw(count);
      held = count;
      // A tool that comes in says its name, as a hover would.
      if (grew) showTooltipFor(rank[count - 1].button);
      else closeTooltip();
    },
    commit() {
      closeTooltip();
      deps.extra.set(held - usual);
    },
  });
  const unsubscribe = deps.extra.subscribe(() => fitToRoom());

  function slideIn(): void {
    element.classList.add("is-opening");
    element.addEventListener("animationend", () => element.classList.remove("is-opening"), { once: true });
  }

  // Inert while it slides out, so nothing reaches buttons on their way off.
  function slideOut(): void {
    element.classList.remove("is-opening");
    element.classList.add("is-closing");
    element.inert = true;
    const done = () => {
      if (!element.classList.contains("is-closing")) return;
      element.classList.remove("is-closing");
      element.inert = false;
      element.hidden = true;
    };
    if (element.getAnimations?.().length) element.addEventListener("animationend", done, { once: true });
    else done();
  }

  function show(next: { view: EditorView; actions: FormatActions } | undefined, slide: boolean): void {
    const showing = !element.hidden && !element.classList.contains("is-closing");
    target = next;
    if (!next) {
      if (deps.contextMenu.isOpen(picker)) deps.contextMenu.close();
      if (!showing) return;
      if (slide) slideOut();
      else element.hidden = true;
      return;
    }
    if (next.actions !== drawn) build(next.actions);
    element.classList.remove("is-closing");
    element.inert = false;
    element.hidden = false;
    if (slide && !showing) slideIn();
    for (const [button, command] of [
      ...entries.map((entry) => [entry.button, entry.command] as const),
      [close, "editor.toggleFormat"] as const,
    ]) {
      const label = button.getAttribute("aria-label") ?? "";
      const chord = command ? deps.shortcutFor(command) : undefined;
      if (chord) button.dataset.tooltip = `${label} (${chord})`;
      else delete button.dataset.tooltip;
    }
    update();
    fitToRoom();
  }

  function dispose(): void {
    unsubscribe();
    resize.dispose();
  }

  return { element, show, update, fitToRoom, dispose };
}
