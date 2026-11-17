// jsdom has no layout: CodeMirror's measure loop asks a Range for its
// client rects, which jsdom's Range lacks, and logs a TypeError per frame
// without this. Zero-sized rects are enough to keep it quiet. Call once at
// the top of any test file that mounts an EditorView.
export function polyfillRangeRects(): void {
  const emptyRect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) };
  Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }) as DOMRectList;
}
