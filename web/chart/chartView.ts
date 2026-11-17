// A chart drawn into an element of its own, for a Chart node's card and its
// App Mode field alike. The adapter loads on the first draw, so a Flow with
// no chart on screen never loads Plot.
import type { ChartSpec } from "../../src/protocol/types.ts";

export interface ChartView {
  el: HTMLDivElement;
  // Draws these rows; undefined puts the placeholder back.
  show(rows: Record<string, unknown>[] | undefined): void;
  // A failure, in the chart's place.
  showError(message: string): void;
  dispose(): void;
}

export interface ChartViewOptions {
  // Draw to the element's height as well as its width, for a box whose
  // height its container sets (an App Mode tile). Without it the chart takes
  // its height from its width, and a box of fixed height would cut it off.
  fill?: boolean;
}

// Below this a chart is all margins: a shorter box scrolls it instead.
const MIN_FILL_HEIGHT = 120;

// `empty` and `error` mark the placeholder and a failure, the state classes
// App Mode's output values already style. `spec` is read at each draw, so a
// redraw follows a config edit made since.
//
// A failure also carries `nodrag`, so its text can be selected and copied:
// without it, a mousedown on a node card starts a node move instead.
export function createChartView(
  className: string,
  spec: () => ChartSpec,
  placeholder: string,
  options: ChartViewOptions = {},
): ChartView {
  const el = document.createElement("div");
  let rows: Record<string, unknown>[] | undefined;
  let drawnWidth = 0;
  let drawnHeight = 0;

  function setState(state: "empty" | "error" | "drawn", text?: string): void {
    const stateClass = state === "error" ? "error nodrag" : state;
    el.className = state === "drawn" ? className : `${className} ${stateClass}`;
    if (text === undefined) return;
    if (state === "error") el.replaceChildren(failure(text));
    else el.textContent = text;
  }

  async function draw(): Promise<void> {
    const drawing = rows;
    if (!drawing) return;
    try {
      const { drawChart } = await import("./plotChart.ts");
      // Replaced or cleared while the adapter loaded.
      if (rows !== drawing) return;
      drawnWidth = contentWidth(el);
      drawnHeight = contentHeight(el);
      setState("drawn");
      el.replaceChildren(
        drawChart(spec(), drawing, drawnWidth, options.fill ? Math.max(drawnHeight, MIN_FILL_HEIGHT) : undefined),
      );
    } catch (error) {
      setState("error", `Couldn't draw the chart: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Plot draws at a fixed pixel size, so a resized element would keep the
  // old chart: a size change redraws the same rows. It also catches the
  // element first being laid out, when it was drawn hidden at the minimum.
  const observer = new ResizeObserver(() => {
    if (!rows) return;
    const widthChanged = Math.abs(contentWidth(el) - drawnWidth) > 8;
    const heightChanged = options.fill && Math.abs(contentHeight(el) - drawnHeight) > 8;
    if (widthChanged || heightChanged) void draw();
  });
  observer.observe(el);
  setState("empty", placeholder);

  return {
    el,
    show(next) {
      rows = next;
      if (next) void draw();
      else setState("empty", placeholder);
    },
    showError(message) {
      rows = undefined;
      setState("error", message);
    },
    dispose: () => observer.disconnect(),
  };
}

// A failure in the `inline-error` primitive, by its class: chart/ depends on
// protocol alone, so it can't use lib/'s builder.
function failure(message: string): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "inline-error";
  card.setAttribute("role", "alert");
  card.textContent = message;
  return card;
}

// The width Plot draws at: the element's, padding excluded.
function contentWidth(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const padding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  return Math.max(el.clientWidth - padding, 160);
}

// Rounded down, since a pixel over the box's height would scroll it.
function contentHeight(el: HTMLElement): number {
  const style = getComputedStyle(el);
  const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  return Math.floor(el.clientHeight - padding);
}
