// Sections pinned under a sidebar panel's scroller. Closed, a section is its
// header alone, at the panel's foot; open, it rises to the height it was
// left at. Which are open and how tall each is are the caller's to keep.
//
// A drag on an open section's top edge trades height across that edge only:
// with the nearest open section above it, else with the scroller. Dragging
// the line between two open sections leaves the scroller where it was.
import { type Disposable, DisposableStore, listen } from "./disposable.ts";
import { pixelToken, wirePanelResize } from "./panelResize.ts";

export interface Stored<T> {
  get(): T;
  set(value: T): void;
}

export interface StackSectionSpec {
  title: string;
  // One of web/styles/section-stack.css's glyphs, drawn after the chevron.
  glyph: string;
  body: HTMLElement;
  // In the header, shown while the section is open and pointed at or focused.
  actions?: HTMLElement[];
  open: Stored<boolean>;
  // Where a drag left it, in px; absent keeps the stylesheet's default.
  height: Stored<number | undefined>;
  // After a click opens it. A section that starts open is its owner's to fill.
  onOpen?(): void;
}

export interface StackSection {
  readonly element: HTMLElement;
  readonly header: HTMLElement;
  isOpen(): boolean;
  // Trailing text in the header, such as a count; "" clears it.
  setCount(text: string): void;
  // Takes no room at all, header included: a section with nothing to list.
  setHidden(hidden: boolean): void;
  // As a click on its header does, `onOpen` included.
  setOpen(open: boolean): void;
}

export interface SectionStack extends Disposable {
  readonly element: HTMLElement;
  readonly sections: readonly StackSection[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An icon button for a section's header, drawn with one of its glyphs. */
export function createSectionAction(label: string, glyph: string, run: () => void): HTMLButtonElement {
  const button = el("button", "icon-button stack-section-action");
  button.type = "button";
  button.setAttribute("aria-label", label);
  const icon = el("span", "stack-section-glyph");
  icon.dataset.glyph = glyph;
  button.append(icon);
  button.addEventListener("click", run);
  return button;
}

export function createSectionStack(scroller: HTMLElement, specs: readonly StackSectionSpec[]): SectionStack {
  const store = new DisposableStore();
  const element = el("div", "section-stack");

  const parts = specs.map((spec) => {
    const section = el("section", "stack-section");
    const handle = el("div", "resize-handle ns");
    const header = el("div", "stack-section-header");
    const toggle = el("button", "stack-section-toggle");
    toggle.type = "button";
    const glyph = el("span", "stack-section-glyph");
    glyph.dataset.glyph = spec.glyph;
    toggle.append(
      el("span", "disclosure stack-section-chevron"),
      glyph,
      el("span", "section-label stack-section-title", spec.title),
    );
    const actions = el("span", "stack-section-actions");
    actions.append(...(spec.actions ?? []));
    // Past the actions, so outside the toggle, which can't hold buttons. The
    // toggle's name carries the count instead, so it is read out once.
    const count = el("span", "stack-section-count");
    count.setAttribute("aria-hidden", "true");
    header.append(toggle, actions, count);
    spec.body.classList.add("stack-section-body");
    spec.body.setAttribute("role", "region");
    spec.body.setAttribute("aria-label", spec.title);
    const clip = el("div", "stack-section-clip");
    clip.append(spec.body);
    section.append(handle, header, clip);
    element.append(section);

    const setHeight = (px: number) => section.style.setProperty("--section-height", `${px}px`);
    const stored = spec.height.get();
    if (stored !== undefined) setHeight(stored);
    const show = (open: boolean) => {
      section.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", String(open));
      spec.body.hidden = !open;
      handle.hidden = !open;
    };
    show(spec.open.get());
    const setOpen = (open: boolean) => {
      if (open === spec.open.get()) return;
      spec.open.set(open);
      show(open);
      if (open) spec.onOpen?.();
    };
    // A click anywhere on the header but its actions opens or closes the
    // section, the count past them included.
    store.add(
      listen(header, "click", (event) => {
        if (!actions.contains(event.target as Node)) setOpen(!spec.open.get());
      }),
    );

    const part: StackSection & { spec: StackSectionSpec; handle: HTMLElement; setHeight(px: number): void } = {
      element: section,
      header,
      spec,
      handle,
      setHeight,
      isOpen: () => spec.open.get(),
      setCount: (text) => {
        count.textContent = text;
        toggle.setAttribute("aria-label", text ? `${spec.title} ${text}` : spec.title);
      },
      setHidden: (hidden) => {
        section.hidden = hidden;
      },
      setOpen,
    };
    return part;
  });

  const shown = (part: (typeof parts)[number]) => part.isOpen() && !part.element.hidden;
  const height = (node: HTMLElement) => node.getBoundingClientRect().height;

  for (const [index, part] of parts.entries()) {
    // What the edge trades with, fixed when a drag starts.
    let above: (typeof parts)[number] | undefined;
    let pair = 0;
    store.add(
      wirePanelResize({
        handle: part.handle,
        axis: "ns",
        minSize: pixelToken("--stack-section-min-height"),
        beginDrag: () => {
          above = parts.slice(0, index).reverse().find(shown);
          const own = height(part.element);
          const bottom = part.element.getBoundingClientRect().bottom;
          pair = above ? own + height(above.element) : 0;
          const room = above
            ? height(above.element) - pixelToken("--stack-section-min-height")
            : height(scroller) - pixelToken("--stack-scroller-min-height");
          const max = own + Math.max(0, room);
          return (event) => Math.min(max, bottom - event.clientY);
        },
        apply: (px) => {
          part.setHeight(px);
          above?.setHeight(pair - px);
        },
        commit: (px) => {
          part.spec.height.set(px);
          above?.spec.height.set(pair - px);
        },
      }),
    );
  }

  return { element, sections: parts, dispose: () => store.dispose() };
}
