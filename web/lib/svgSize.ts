// An SVG that sets neither a width nor a height has a shape, from its
// viewBox, but no size, and a frame that hugs its picture draws it at
// nothing. It is shown at its viewBox's extent instead, the size a design
// app opens it at, and fitted from there like any picture.
//
// Its text is parsed, never shown: a parsed document runs and loads nothing.
// The picture stays on the raw-file route. A blob: URL of these bytes,
// opened in a tab of its own, would run their scripts on the app's origin.

export interface SvgSize {
  width: number;
  height: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// A width or height the browser sizes the picture by. A percentage, `auto`
// or a font-relative unit gives none to trust, so the stand-in shows it
// rather than leave it at nothing.
const OWN_LENGTH = /^\s*(\d+\.?\d*|\.\d+)(e[+-]?\d+)?(px|pt|pc|mm|cm|in|q)?\s*$/i;

// The box a browser draws an SVG in when it gives neither a size nor a viewBox.
const DEFAULT_OBJECT_SIZE: SvgSize = { width: 300, height: 150 };

/** The size an SVG with none of its own is shown at. Undefined for one that
 * sets its own, which the browser sizes, and for text that isn't an SVG. */
export function svgStandInSize(text: string): SvgSize | undefined {
  const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = parsed.documentElement;
  if (root.localName !== "svg" || root.namespaceURI !== SVG_NS) return undefined;
  if (parsed.getElementsByTagName("parsererror").length > 0) return undefined;
  const own = [root.getAttribute("width"), root.getAttribute("height")];
  if (own.some((value) => value !== null && OWN_LENGTH.test(value))) return undefined;
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const [width, height] = box.slice(2);
  const valid = box.length === 4 && box.every(Number.isFinite) && width > 0 && height > 0;
  return valid ? { width, height } : DEFAULT_OBJECT_SIZE;
}

/** The same, read through `fetchFile`, a GET against the raw-file route. A
 * failed read is no answer, and leaves the picture to the browser. */
export async function readSvgStandInSize(
  fetchFile: (path: string) => Promise<Response>,
  path: string,
): Promise<SvgSize | undefined> {
  try {
    const response = await fetchFile(path);
    return response.ok ? svgStandInSize(await response.text()) : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `describe` with the size `img` counts as once it has loaded: its
 * own, or the stand-in from an SVG's `standIn` lookup, which also sizes the
 * picture (web/styles/media-panes.css). An SVG waits for that answer rather
 * than report the default size the browser decodes an unsized one at. */
export function describeLoaded(
  img: HTMLImageElement,
  standIn: Promise<SvgSize | undefined> | undefined,
  describe: (width: number, height: number) => void,
): void {
  void standIn?.then((size) => {
    if (!size) return;
    img.classList.add("is-unsized");
    img.style.setProperty("--svg-width", `${size.width}px`);
    img.style.setProperty("--svg-ratio", String(size.width / size.height));
  });
  img.addEventListener("load", () => {
    if (!standIn) {
      describe(img.naturalWidth, img.naturalHeight);
      return;
    }
    void standIn.then((size) =>
      describe(Math.round(size?.width ?? img.naturalWidth), Math.round(size?.height ?? img.naturalHeight)),
    );
  });
}
