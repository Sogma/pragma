/// <reference types="vite/client" />
// PDF.js, as the PDF pane's sandboxed frame receives it: source text and
// bytes over postMessage, never URLs. The frame has an opaque origin, so a
// passphrase deployment's session cookie never rides its requests, and its
// CSP lets it fetch nothing at all (view/panes/pdfPane.ts).

export interface PdfRuntime {
  lib: string;
  viewer: string;
  worker: string;
  css: string;
}

export type PdfBinaryKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl";

// The app's own scrollbars, which the frame's page takes in as its own.
export { default as SCROLLBAR_STYLE } from "../styles/scrollbars.css?raw";
export { default as PDF_FRAME_SCRIPT } from "../view/panes/pdfFrame.js?raw";

let runtime: Promise<PdfRuntime> | undefined;

/** Loaded on the first PDF opened, not at startup: about 2 MB nobody pays
 * for until then. A failed load is forgotten, so the next open retries. */
export function loadPdfRuntime(): Promise<PdfRuntime> {
  runtime ??= Promise.all([
    import("pdfjs-dist/build/pdf.min.mjs?raw"),
    import("pdfjs-dist/web/pdf_viewer.mjs?raw"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?raw"),
    import("pdfjs-dist/web/pdf_viewer.css?raw"),
  ]).then(
    ([lib, viewer, worker, css]) => ({
      lib: lib.default,
      viewer: viewer.default,
      worker: worker.default,
      css: css.default,
    }),
    (error: unknown) => {
      runtime = undefined;
      throw error;
    },
  );
  return runtime;
}

/** One of PDF.js's own data files, by the kind and name the worker asked
 * for. Only a name in the shipped set resolves: the request comes from the
 * frame, and the frame's content is the PDF's.
 *
 * The URL list is imported here, on request, never at load: importing it
 * resolves every file in pdfjs-dist, which a test run whose node_modules is
 * a symlink out of its root (the pre-push worktree) is refused. */
export async function pdfBinaryAsset(kind: string, filename: string): Promise<Uint8Array> {
  const { PDF_BINARY_ASSETS } = await import("./pdfAssets.ts");
  const url = Object.hasOwn(PDF_BINARY_ASSETS, kind)
    ? PDF_BINARY_ASSETS[kind as PdfBinaryKind].get(filename)
    : undefined;
  if (!url) throw new Error(`No PDF.js data file "${filename}" for ${kind}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't load PDF.js data file "${filename}"`);
  return new Uint8Array(await response.arrayBuffer());
}
