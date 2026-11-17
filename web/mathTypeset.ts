// Math typeset into the page as it renders. MathJax loads on the first math
// shown, never at startup, and the host shows the TeX until then.
//
// What was typeset is kept by its TeX and cloned into each later host, so
// reading view, which redraws on every keystroke of the editor beside it, and
// a chat reply, redrawn as it streams, show math without a flash. The rest is
// typeset a slice at a time, so a page of formulas never freezes the window.
import type { MathEngine } from "./mathJax.ts";

interface Job {
  host: HTMLElement;
  tex: string;
  display: boolean;
}

const KEPT = 2000;
const SLICE_MS = 12;

const typeset = new Map<string, Element>();
const queue: Job[] = [];
let engine: MathEngine | undefined;
let loading: Promise<MathEngine> | undefined;
let draining = false;

/** Shows `tex` in `host`, typeset at once when the same math was before,
 * else as written until MathJax has typeset it. */
export function typesetMath(host: HTMLElement, tex: string, display: boolean): void {
  const done = engine && typeset.get(keyOf(engine, tex, display));
  if (done) {
    host.replaceChildren(done.cloneNode(true));
    return;
  }
  host.textContent = tex;
  host.classList.add("is-pending");
  queue.push({ host, tex, display });
  if (!draining) {
    draining = true;
    load().then(
      () => setTimeout(drain),
      () => {
        // A failed load leaves the TeX showing, as plain text.
        for (const job of queue.splice(0)) job.host.classList.remove("is-pending");
        draining = false;
      },
    );
  }
}

// The engine's generation leads the key, so math kept from before a
// `\usepackage` is typeset afresh after it.
function keyOf(engine: MathEngine, tex: string, display: boolean): string {
  return `${engine.generation}${display ? "D" : "I"}${tex}`;
}

function load(): Promise<MathEngine> {
  loading ??= import("./mathJax.ts").then(
    (module) => (engine = module.mathEngine()),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

function drain(): void {
  if (!engine) return;
  const until = performance.now() + SLICE_MS;
  for (let job = queue.shift(); job; job = queue.shift()) {
    show(engine, job);
    if (performance.now() > until) break;
  }
  engine.updateStyles();
  if (queue.length > 0) setTimeout(drain);
  else draining = false;
}

function show(engine: MathEngine, { host, tex, display }: Job): void {
  const key = keyOf(engine, tex, display);
  let node = typeset.get(key);
  if (node) {
    typeset.delete(key);
  } else {
    try {
      node = engine.render(tex, display);
    } catch {
      host.classList.remove("is-pending");
      return;
    }
  }
  typeset.set(key, node);
  if (typeset.size > KEPT) typeset.delete(typeset.keys().next().value as string);
  host.replaceChildren(node.cloneNode(true));
  host.classList.remove("is-pending");
}
