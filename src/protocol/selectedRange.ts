import type { SelectedRange } from "./api.ts";

// `startLine:startColumn-endLine:endColumn`, the `file:line:column` form
// compilers print, which a model reads without being told how. The chat
// request carries a selection in it and the copilot's prompt names one in
// it, so the two are written by this one function.
export function formatSelectedRange({ startLine, startColumn, endLine, endColumn }: SelectedRange): string {
  return `${startLine}:${startColumn}-${endLine}:${endColumn}`;
}

// Undefined for anything but positive whole numbers ending no earlier than
// they start.
export function parseSelectedRange(text: string): SelectedRange | undefined {
  const match = /^(\d+):(\d+)-(\d+):(\d+)$/.exec(text);
  if (!match) return undefined;
  const [startLine, startColumn, endLine, endColumn] = match.slice(1).map(Number);
  if (Math.min(startLine, startColumn, endLine, endColumn) < 1) return undefined;
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) return undefined;
  return { startLine, startColumn, endLine, endColumn };
}
