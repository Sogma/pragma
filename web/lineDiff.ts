// A minimal text diff: line-level for the copilot's confirm cards,
// word-level for an edit proposed inline in the editor. Both sit on one LCS
// core, generic over the element type.

export type DiffOpType = "equal" | "add" | "remove";

export interface DiffOp<T> {
  type: DiffOpType;
  value: T;
}

// Beyond this many cells the LCS table isn't worth building — fall back to
// "remove everything, then add everything". A single file large enough to hit
// this is already past the point where a line diff reads usefully anyway.
const MAX_TABLE_CELLS = 4_000_000;

/** Longest-common-subsequence diff of two sequences. A shared prefix and
 * suffix are trimmed first, so the O(n·m) table only ever covers the part that
 * actually differs — for a small edit in a large file that's a handful of
 * cells rather than millions. `eq` defaults to `===`. */
function diffSeq<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): DiffOp<T>[] {
  let lo = 0;
  while (lo < a.length && lo < b.length && eq(a[lo], b[lo])) lo++;

  let aHi = a.length;
  let bHi = b.length;
  while (aHi > lo && bHi > lo && eq(a[aHi - 1], b[bHi - 1])) {
    aHi--;
    bHi--;
  }

  const ops: DiffOp<T>[] = [];
  for (let i = 0; i < lo; i++) ops.push({ type: "equal", value: a[i] });

  const midA = a.slice(lo, aHi);
  const midB = b.slice(lo, bHi);
  const n = midA.length;
  const m = midB.length;

  if (n === 0 || m === 0 || n * m > MAX_TABLE_CELLS) {
    for (let i = 0; i < n; i++) ops.push({ type: "remove", value: midA[i] });
    for (let j = 0; j < m; j++) ops.push({ type: "add", value: midB[j] });
  } else {
    // table[i][j] = LCS length of midA[i:] and midB[j:].
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = eq(midA[i], midB[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(midA[i], midB[j])) {
        ops.push({ type: "equal", value: midA[i] });
        i++;
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        ops.push({ type: "remove", value: midA[i] });
        i++;
      } else {
        ops.push({ type: "add", value: midB[j] });
        j++;
      }
    }
    while (i < n) ops.push({ type: "remove", value: midA[i++] });
    while (j < m) ops.push({ type: "add", value: midB[j++] });
  }

  for (let k = bHi; k < b.length; k++) ops.push({ type: "equal", value: b[k] });

  return ops;
}

export interface LineDiffOp {
  type: DiffOpType;
  text: string;
}

/** Line-level diff. An empty `before` (or `after`) is treated as "no lines"
 * rather than one empty line, so creating a file renders as pure additions
 * instead of "remove one blank line, then add everything". */
export function diffLines(before: string, after: string): LineDiffOp[] {
  const beforeLines = before === "" ? [] : before.split("\n");
  const afterLines = after === "" ? [] : after.split("\n");
  return diffSeq(beforeLines, afterLines).map((op) => ({ type: op.type, text: op.value }));
}

/** One replacement, in the original text's coordinates: `[from, to)` becomes
 * `insert`. Also a valid CodeMirror change spec. */
export interface TextHunk {
  from: number;
  to: number;
  insert: string;
}

// A word, a run of whitespace, or any other single character. Whitespace is a
// token of its own so a changed word never drags its neighbouring space into
// the change.
const WORD_TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
// Spaces or tabs, no line break: what may sit between two changes that still
// read as one phrase.
const INLINE_GAP = /^[^\S\n]+$/;

// Every line keeps its terminator, so the pieces add back up to the text and
// each offset stays exact.
function linesWithBreaks(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function wordHunks(before: string, after: string, offset: number): TextHunk[] {
  const hunks: TextHunk[] = [];
  let pos = offset;
  let open: TextHunk | undefined;
  let gap = "";
  const close = () => {
    if (open) hunks.push(open);
    open = undefined;
    gap = "";
  };
  for (const op of diffSeq(before.match(WORD_TOKEN) ?? [], after.match(WORD_TOKEN) ?? [])) {
    if (op.type === "equal") {
      if (open && !gap && INLINE_GAP.test(op.value)) gap = op.value;
      else close();
      pos += op.value.length;
      continue;
    }
    if (!open) open = { from: pos, to: pos, insert: "" };
    else if (gap) {
      open.insert += gap;
      gap = "";
    }
    if (op.type === "remove") pos += op.value.length;
    else open.insert += op.value;
    open.to = pos;
  }
  close();
  return hunks;
}

/** The replacements that turn `before` into `after`, word by word, in order.
 * Lines are compared first and only a changed block is compared again by
 * word, so a one-word edit in a long document costs a table the size of its
 * paragraph rather than of the document. Two changes separated only by spaces
 * on one line merge into one, since they read as one rewritten phrase. */
export function diffWords(before: string, after: string): TextHunk[] {
  const hunks: TextHunk[] = [];
  let pos = 0;
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed || added) hunks.push(...wordHunks(removed, added, pos));
    pos += removed.length;
    removed = "";
    added = "";
  };
  for (const op of diffSeq(linesWithBreaks(before), linesWithBreaks(after))) {
    if (op.type === "remove") removed += op.value;
    else if (op.type === "add") added += op.value;
    else {
      flush();
      pos += op.value.length;
    }
  }
  flush();
  return hunks;
}

// Unchanged lines kept visible on each side of a change.
const CONTEXT = 3;

/** Builds the `.diff` DOM for a confirm card. A long run of unchanged lines
 * with no change nearby collapses to a "⋯ N unchanged lines" row, so a small
 * edit in a big file stays readable. */
export function renderLineDiff(ops: LineDiffOp[]): HTMLElement {
  const container = document.createElement("div");
  container.className = "diff";

  if (ops.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diff-fold";
    empty.textContent = "No changes.";
    container.appendChild(empty);
    return container;
  }

  const isChange = ops.map((op) => op.type !== "equal");
  const nearChange = ops.map((_, i) => {
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (isChange[i + d]) return true;
    return false;
  });

  const appendLine = (type: DiffOpType, text: string): void => {
    const row = document.createElement("div");
    row.className = `diff-line diff-line-${type}`;
    const gutter = document.createElement("span");
    gutter.className = "diff-gutter";
    gutter.setAttribute("aria-hidden", "true");
    gutter.textContent = type === "add" ? "+" : type === "remove" ? "−" : " ";
    const body = document.createElement("span");
    body.className = "diff-text";
    body.textContent = text === "" ? " " : text;
    row.append(gutter, body);
    container.appendChild(row);
  };

  let i = 0;
  while (i < ops.length) {
    if (ops[i].type !== "equal" || nearChange[i]) {
      appendLine(ops[i].type, ops[i].text);
      i++;
      continue;
    }
    let j = i;
    while (j < ops.length && ops[j].type === "equal" && !nearChange[j]) j++;
    const count = j - i;
    if (count > 1) {
      const fold = document.createElement("div");
      fold.className = "diff-fold";
      fold.textContent = `⋯ ${count} unchanged lines`;
      container.appendChild(fold);
    } else {
      appendLine("equal", ops[i].text);
    }
    i = j;
  }

  return container;
}
