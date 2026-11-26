// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSectionAction, createSectionStack, type StackSectionSpec } from "../../../web/lib/sectionStack.ts";

function stored<T>(initial: T) {
  let value = initial;
  return {
    get: vi.fn(() => value),
    set: vi.fn((next: T) => {
      value = next;
    }),
  };
}

function spec(title: string, open = false, height?: number) {
  const body = document.createElement("div");
  body.textContent = `${title} body`;
  return {
    title,
    glyph: title.toLowerCase(),
    body,
    actions: [document.createElement("button")],
    open: stored(open),
    height: stored<number | undefined>(height),
    onOpen: vi.fn(),
  } satisfies StackSectionSpec;
}

function setup(specs: ReturnType<typeof spec>[]) {
  const scroller = document.createElement("div");
  const stack = createSectionStack(scroller, specs);
  document.body.append(scroller, stack.element);
  const parts = stack.sections.map((section) => ({
    section,
    toggle: section.element.querySelector(".stack-section-toggle") as HTMLButtonElement,
    handle: section.element.querySelector(".resize-handle") as HTMLElement,
  }));
  return { stack, scroller, parts };
}

// jsdom lays nothing out, so each drag reads the heights a test gives it.
function lay(element: HTMLElement, height: number, bottom = height): void {
  element.getBoundingClientRect = () => ({ height, bottom, top: bottom - height }) as DOMRect;
}

function drag(handle: HTMLElement, clientY: number): void {
  handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  document.dispatchEvent(new MouseEvent("mousemove", { clientY }));
  document.dispatchEvent(new MouseEvent("mouseup"));
}

beforeEach(() => {
  document.documentElement.style.setProperty("--stack-section-min-height", "80px");
  document.documentElement.style.setProperty("--stack-scroller-min-height", "96px");
});

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.removeAttribute("style");
});

describe("section stack", () => {
  it("opens and closes from code as a header click does, onOpen included", () => {
    const templates = spec("Templates");
    const { parts } = setup([templates]);
    const [{ section, toggle }] = parts;
    section.setOpen(true);
    expect(section.isOpen()).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(templates.onOpen).toHaveBeenCalledTimes(1);
    section.setOpen(true);
    expect(templates.onOpen).toHaveBeenCalledTimes(1);
    section.setOpen(false);
    expect(templates.open.set).toHaveBeenLastCalledWith(false);
    expect(section.element.classList.contains("open")).toBe(false);
  });

  it("draws a closed section as its header alone: chevron, glyph, title", () => {
    const tags = spec("Tags");
    const { parts } = setup([tags]);
    const [{ section, toggle, handle }] = parts;
    expect(section.element.classList.contains("open")).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.querySelector(".stack-section-title")?.textContent).toBe("Tags");
    expect(toggle.querySelector<HTMLElement>(".stack-section-glyph")?.dataset.glyph).toBe("tags");
    expect(tags.body.hidden).toBe(true);
    expect(tags.body.getAttribute("role")).toBe("region");
    expect(tags.body.getAttribute("aria-label")).toBe("Tags");
    expect(handle.hidden).toBe(true);
    expect(section.element.querySelector(".stack-section-actions")?.contains(tags.actions[0])).toBe(true);
  });

  it("opens and closes on a header click, remembering it, and tells the section it opened", () => {
    const tags = spec("Tags");
    const { parts } = setup([tags]);
    const [{ section, toggle, handle }] = parts;

    toggle.click();
    expect(tags.open.set).toHaveBeenLastCalledWith(true);
    expect(section.isOpen()).toBe(true);
    expect(section.element.classList.contains("open")).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(tags.body.hidden).toBe(false);
    expect(handle.hidden).toBe(false);
    expect(tags.onOpen).toHaveBeenCalledTimes(1);

    toggle.click();
    expect(tags.open.set).toHaveBeenLastCalledWith(false);
    expect(tags.body.hidden).toBe(true);
    expect(tags.onOpen).toHaveBeenCalledTimes(1);
  });

  // Its owner fills a section that starts open, as it does on any refresh.
  it("starts as remembered, at the remembered height, without calling onOpen", () => {
    const trash = spec("Trash", true, 150);
    const { parts } = setup([trash]);
    expect(parts[0].section.element.classList.contains("open")).toBe(true);
    expect(parts[0].section.element.style.getPropertyValue("--section-height")).toBe("150px");
    expect(trash.onOpen).not.toHaveBeenCalled();
  });

  it("shows a count, and hides a section with nothing to list", () => {
    const { parts } = setup([spec("Trash")]);
    const [{ section }] = parts;
    section.setCount("3");
    expect(section.element.querySelector(".stack-section-count")?.textContent).toBe("3");
    section.setCount("");
    expect(section.element.querySelector(".stack-section-count")?.textContent).toBe("");
    section.setHidden(true);
    expect(section.element.hidden).toBe(true);
  });

  it("keeps the count past the actions, in the toggle's name, and opens on a click anywhere but an action", () => {
    const trash = spec("Trash");
    const { parts } = setup([trash]);
    const [{ section, toggle }] = parts;
    const count = section.element.querySelector(".stack-section-count") as HTMLElement;
    expect([...section.header.children].map((child) => child.className)).toEqual([
      "stack-section-toggle",
      "stack-section-actions",
      "stack-section-count",
    ]);

    section.setCount("3");
    expect(toggle.getAttribute("aria-label")).toBe("Trash 3");
    expect(count.getAttribute("aria-hidden")).toBe("true");
    section.setCount("");
    expect(toggle.getAttribute("aria-label")).toBe("Trash");

    count.click();
    expect(section.isOpen()).toBe(true);
    trash.actions[0].click();
    expect(section.isOpen()).toBe(true);
    toggle.click();
    expect(section.isOpen()).toBe(false);
    expect(trash.open.set).toHaveBeenCalledTimes(2);
  });

  it("lays each header frosted over its body, inside the clip that ends the section", () => {
    const tags = spec("Tags", true);
    const { parts } = setup([tags]);
    const [{ section }] = parts;
    expect(section.header.classList.contains("frost-header")).toBe(true);
    expect(section.header.nextElementSibling).toBe(tags.body);
    expect(section.header.parentElement?.classList.contains("stack-section-clip")).toBe(true);
    expect(tags.body.classList.contains("frost-header-scroller")).toBe(true);
  });

  it("makes a header action from a label and a glyph", () => {
    const run = vi.fn();
    const action = createSectionAction("Empty Trash", "trash", run);
    expect(action.getAttribute("aria-label")).toBe("Empty Trash");
    expect(action.classList.contains("icon-button")).toBe(true);
    expect(action.querySelector<HTMLElement>(".stack-section-glyph")?.dataset.glyph).toBe("trash");
    action.click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  // The line between two open sections moves between them alone.
  it("trades height with the open section above, leaving the scroller as it was", () => {
    const tags = spec("Tags", true, 200);
    const trash = spec("Trash", true, 100);
    const { parts, scroller } = setup([tags, trash]);
    lay(scroller, 300, 300);
    lay(parts[0].section.element, 200, 500);
    lay(parts[1].section.element, 100, 600);

    drag(parts[1].handle, 450);
    expect(parts[1].section.element.style.getPropertyValue("--section-height")).toBe("150px");
    expect(parts[0].section.element.style.getPropertyValue("--section-height")).toBe("150px");
    expect(trash.height.set).toHaveBeenLastCalledWith(150);
    expect(tags.height.set).toHaveBeenLastCalledWith(150);

    // The section above keeps its floor.
    drag(parts[1].handle, 100);
    expect(trash.height.set).toHaveBeenLastCalledWith(220);
    expect(tags.height.set).toHaveBeenLastCalledWith(80);
  });

  it("trades with the scroller when no section above it is open, down to the scroller's floor", () => {
    const tags = spec("Tags");
    const trash = spec("Trash", true, 100);
    const { parts, scroller } = setup([tags, trash]);
    lay(scroller, 300, 300);
    lay(parts[1].section.element, 100, 600);

    drag(parts[1].handle, 400);
    expect(trash.height.set).toHaveBeenLastCalledWith(200);
    expect(tags.height.set).not.toHaveBeenCalled();

    drag(parts[1].handle, 0);
    expect(trash.height.set).toHaveBeenLastCalledWith(100 + 300 - 96);
  });
});
