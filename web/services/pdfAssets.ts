/// <reference types="vite/client" />
// What the PDF.js worker asks for while it parses: CMaps for non-embedded CJK
// fonts, the two symbol fonts a system font can't stand in for, and the
// image decoders' wasm. Keyed by the getDocument parameter that names each
// directory, so the frame's request names a file only within one of them.
//
// Eager, so this is ~190 URL strings rather than a chunk per file; the files
// themselves are never inlined (web/vite.config.mjs) and load only on request.
import type { PdfBinaryKind } from "./pdfRuntime.ts";

function byFilename(urls: Record<string, string>): Map<string, string> {
  return new Map(
    Object.entries(urls).map(([modulePath, url]) => [modulePath.slice(modulePath.lastIndexOf("/") + 1), url]),
  );
}

export const PDF_BINARY_ASSETS: Record<PdfBinaryKind, Map<string, string>> = {
  cMapUrl: byFilename(
    import.meta.glob<string>("../../node_modules/pdfjs-dist/cmaps/*.bcmap", {
      query: "?url",
      import: "default",
      eager: true,
    }),
  ),
  standardFontDataUrl: byFilename(
    import.meta.glob<string>("../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}", {
      query: "?url",
      import: "default",
      eager: true,
    }),
  ),
  wasmUrl: byFilename(
    import.meta.glob<string>("../../node_modules/pdfjs-dist/wasm/*.wasm", {
      query: "?url",
      import: "default",
      eager: true,
    }),
  ),
};
