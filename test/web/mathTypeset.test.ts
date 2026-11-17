// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A stand-in for MathJax: its output names the TeX, and "boom" fails.
function fakeEngine() {
  let generation = 0;
  return {
    rendered: [] as string[],
    get generation() {
      return generation;
    },
    askForPackage() {
      generation++;
    },
    render(tex: string, display: boolean): HTMLElement {
      if (tex === "boom") throw new Error("MathJax failed");
      this.rendered.push(tex);
      const node = document.createElement("mjx-container");
      node.textContent = `typeset ${tex}`;
      if (display) node.setAttribute("display", "true");
      return node;
    },
    updateStyles: vi.fn(),
  };
}

let engine: ReturnType<typeof fakeEngine>;

async function typesetModule() {
  return await import("../../web/mathTypeset.ts");
}

function host(): HTMLElement {
  return document.body.appendChild(document.createElement("span"));
}

const typeset = (el: HTMLElement) => el.querySelector("mjx-container") !== null;

beforeEach(() => {
  vi.resetModules();
  engine = fakeEngine();
  vi.doMock("../../web/mathJax.ts", () => ({ mathEngine: () => engine }));
});

afterEach(() => {
  vi.doUnmock("../../web/mathJax.ts");
  document.body.replaceChildren();
});

describe("typesetMath", () => {
  it("shows the TeX while MathJax loads, then the typeset math and its styles", async () => {
    const { typesetMath } = await typesetModule();
    const el = host();
    typesetMath(el, "x^2", false);
    expect(el.textContent).toBe("x^2");
    expect(el.classList.contains("is-pending")).toBe(true);
    await vi.waitFor(() => expect(typeset(el)).toBe(true));
    expect(el.textContent).toBe("typeset x^2");
    expect(el.classList.contains("is-pending")).toBe(false);
    expect(engine.updateStyles).toHaveBeenCalled();
  });

  it("typesets the same math once, and shows it at once from then on", async () => {
    const { typesetMath } = await typesetModule();
    const first = host();
    const second = host();
    typesetMath(first, "a", false);
    typesetMath(second, "a", false);
    await vi.waitFor(() => expect(typeset(second)).toBe(true));
    const later = host();
    typesetMath(later, "a", false);
    expect(typeset(later)).toBe(true);
    expect(engine.rendered).toEqual(["a"]);
    const display = host();
    typesetMath(display, "a", true);
    expect(typeset(display)).toBe(false);
  });

  it("typesets kept math afresh once a formula turns a package on", async () => {
    const { typesetMath } = await typesetModule();
    const first = host();
    typesetMath(first, "\\div", false);
    await vi.waitFor(() => expect(typeset(first)).toBe(true));
    engine.askForPackage();
    const after = host();
    typesetMath(after, "\\div", false);
    expect(typeset(after)).toBe(false);
    await vi.waitFor(() => expect(typeset(after)).toBe(true));
    expect(engine.rendered).toEqual(["\\div", "\\div"]);
  });

  it("leaves the TeX as plain text when MathJax can't typeset it", async () => {
    const { typesetMath } = await typesetModule();
    const failed = host();
    const fine = host();
    typesetMath(failed, "boom", false);
    typesetMath(fine, "y", false);
    await vi.waitFor(() => expect(typeset(fine)).toBe(true));
    expect(failed.textContent).toBe("boom");
    expect(failed.classList.contains("is-pending")).toBe(false);
  });

  it("leaves the TeX as plain text when MathJax doesn't load", async () => {
    vi.doMock("../../web/mathJax.ts", () => {
      throw new Error("offline");
    });
    const { typesetMath } = await typesetModule();
    const el = host();
    typesetMath(el, "z", false);
    await vi.waitFor(() => expect(el.classList.contains("is-pending")).toBe(false));
    expect(el.textContent).toBe("z");
  });
});
