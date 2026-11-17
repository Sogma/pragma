// docs/protocol.md's Descriptions, for a Fountain screenplay: the frame every
// reader of one puts its lines in before any element rule (which lines are a
// boneyard, which the title page and which are blank) and where its notes
// run. One copy, so the editor's styling, reading view and a screenplay's
// description agree.
//
// Only an empty line is blank. Fountain keeps an empty line inside dialogue
// or a note with a line of two spaces, so a line of spaces is content.

export type LineFrame = "blank" | "boneyard" | "title-page" | "text";

/** How far a run of lines has got. Flat, so a shallow copy is a copy. */
export interface FrameState {
  titlePage: "unresolved" | "active" | "done";
  inBoneyard: boolean;
}

export function startFrame(): FrameState {
  return { titlePage: "unresolved", inBoneyard: false };
}

const TITLE_PAGE_KEY = /^[A-Za-z][A-Za-z0-9 ]*:/;

/** What `line`, its line break left out, is after the lines `state` has
 * seen; `state` moves past it. */
export function frameLine(state: FrameState, line: string): LineFrame {
  // Whole lines only: a line holding a `/*`, or inside an open one, is
  // boneyard start to finish, even text outside a same-line pair.
  if (state.inBoneyard) {
    if (line.includes("*/")) state.inBoneyard = false;
    return "boneyard";
  }
  const open = line.indexOf("/*");
  if (open !== -1) {
    state.inBoneyard = line.indexOf("*/", open + 2) === -1;
    return "boneyard";
  }
  if (line === "") {
    if (state.titlePage === "active") state.titlePage = "done";
    return "blank";
  }
  // The title page is only ever at the very top: the first line that isn't
  // blank starts it, as `Key: value`, or rules it out.
  if (state.titlePage === "unresolved") state.titlePage = TITLE_PAGE_KEY.test(line.trim()) ? "active" : "done";
  return state.titlePage === "active" ? "title-page" : "text";
}

/** A note's span in a source: from its `[[` to just past its `]]`. */
export interface NoteSpan {
  from: number;
  to: number;
}

/** Every note in a Fountain source, in order. A note runs from `[[` to the
 * next `]]`, over several lines if need be but never across an empty line,
 * which leaves its `[[` as text. Only text lines hold one: a boneyard line
 * is passed over, and the title page has none. */
export function fountainNotes(source: string): NoteSpan[] {
  const notes: NoteSpan[] = [];
  const state = startFrame();
  let open: number | undefined;
  let from = 0;
  for (const raw of source.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const lineFrom = from;
    from += raw.length + 1;
    const frame = frameLine(state, line);
    if (frame === "blank") open = undefined;
    if (frame !== "text") continue;
    let at = 0;
    for (;;) {
      if (open === undefined) {
        const start = line.indexOf("[[", at);
        if (start === -1) break;
        open = lineFrom + start;
        at = start + 2;
      }
      const end = line.indexOf("]]", at);
      if (end === -1) break;
      notes.push({ from: open, to: lineFrom + end + 2 });
      open = undefined;
      at = end + 2;
    }
  }
  return notes;
}

/** A title page's entries in order: each `Key: value`, its value running on
 * over the lines below it, joined by spaces. The page is the run of lines
 * that opens the source with a `Key:`, so a screenplay without one has none. */
export function fountainTitlePage(source: string): { key: string; value: string }[] {
  const entries: { key: string; value: string }[] = [];
  const state = startFrame();
  for (const raw of source.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const frame = frameLine(state, line);
    if (state.titlePage === "done") break;
    if (frame !== "title-page") continue;
    const entry = /^([A-Za-z][A-Za-z0-9 ]*):(.*)$/.exec(line);
    const last = entries.at(-1);
    if (entry) entries.push({ key: entry[1].trim(), value: entry[2].trim() });
    else if (last) last.value = [last.value, line.trim()].filter(Boolean).join(" ");
  }
  return entries;
}
