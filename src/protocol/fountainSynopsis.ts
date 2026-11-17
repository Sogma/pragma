// docs/protocol.md's Descriptions, for a Fountain screenplay: its synopsis
// lines (`= …`), the writer's one-line blurbs Fountain never prints, and the
// first one with text as the file's description. Pure string work, so the
// server's cards, the client's links and reading view agree on every line.
//
// Lines are framed and notes found by fountainLines.ts, as the editor finds
// them: a boneyard line, the title page or a line inside a note holds no
// synopsis, and `===` is a page break.
import { fountainNotes, frameLine, startFrame } from "./fountainLines.ts";

const PAGE_BREAK = /^={3,}$/;

/** One synopsis line: where it sits and what follows its `=`. */
export interface SynopsisLine {
  // 1-based, as an editor numbers lines.
  number: number;
  // The line's span in the source, its line break left out.
  from: number;
  to: number;
  text: string;
}

/** Every synopsis line in a Fountain source, in order. */
export function synopsisLines(source: string): SynopsisLine[] {
  const found: SynopsisLine[] = [];
  const notes = fountainNotes(source);
  let note = 0;
  const frame = startFrame();
  let from = 0;
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineFrom = from;
    from += raw.length + 1;

    const kind = frameLine(frame, line);
    while (note < notes.length && notes[note].to <= lineFrom) note++;
    const inNote = note < notes.length && notes[note].from < lineFrom;
    if (kind !== "text" || inNote) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith("=") && !PAGE_BREAK.test(trimmed)) {
      found.push({ number: index + 1, from: lineFrom, to: lineFrom + line.length, text: trimmed.slice(1).trim() });
    }
  }
  return found;
}

/** A screenplay's description: its first synopsis line with text. */
export function fountainDescription(source: string): string | undefined {
  return synopsisLines(source).find((line) => line.text !== "")?.text;
}
