// The element rules a Fountain line is read by, once fountainLines.ts has
// framed it as text: which lines are scene headings, cues, dialogue and the
// rest. Pure string work, so the editor's drawing and a host's reading of a
// screenplay's world names give every line the same kind.

const SCENE_HEADING = /^(int|ext|est|i\.?\/e\.?)[. ]/i;
const TRANSITION = /^[A-Z0-9 ]+TO:$/;
const PAGE_BREAK = /^={3,}$/;

export function isForcedSceneHeading(line: string): boolean {
  return line.startsWith(".") && !line.startsWith("..");
}

// A character cue is (almost) entirely uppercase, allowing a trailing
// parenthetical extension like "(V.O.)" or "(CONT'D)" to contain anything.
function looksLikeCharacterCue(line: string): boolean {
  const withoutExtension = line.replace(/\([^)]*\)\s*$/, "").trim();
  return withoutExtension.length > 0 && !/[a-z]/.test(withoutExtension);
}

/** The token the element rules give a line's trimmed text, from whether an
 * empty line is above it and whether a speech runs into it, and whether a
 * speech runs on past it. The boneyard and the title page, which the frame
 * reads first, aside. */
export function fountainToken(
  trimmed: string,
  afterBlank: boolean,
  inDialogue: boolean,
): { token: string; inDialogue: boolean } {
  // Forced markers always win, regardless of surrounding context — that's
  // the whole point of typing one.
  if (isForcedSceneHeading(trimmed)) return { token: "fountain-scene-heading", inDialogue: false };
  if (trimmed.startsWith("!")) return { token: "fountain-action", inDialogue: false };
  if (trimmed.startsWith("@")) {
    return { token: trimmed.endsWith("^") ? "fountain-character-dual" : "fountain-character", inDialogue: true };
  }
  if (trimmed.startsWith(">") && trimmed.endsWith("<")) return { token: "fountain-centered", inDialogue };
  if (trimmed.startsWith(">")) return { token: "fountain-transition", inDialogue: false };

  if (PAGE_BREAK.test(trimmed)) return { token: "fountain-page-break", inDialogue };
  if (trimmed.startsWith("#")) return { token: "fountain-section", inDialogue };
  if (trimmed.startsWith("=")) return { token: "fountain-synopsis", inDialogue };

  if (afterBlank && SCENE_HEADING.test(trimmed)) return { token: "fountain-scene-heading", inDialogue: false };
  if (afterBlank && TRANSITION.test(trimmed)) return { token: "fountain-transition", inDialogue: false };
  if (inDialogue && trimmed.startsWith("(")) return { token: "fountain-parenthetical", inDialogue };

  // Provisional: a blank-preceded, all-caps line *looks* like a character
  // cue, but a real cue must be followed by dialogue. The tokenizer can't
  // peek at the next line, so it tags optimistically, and a cue with no
  // dialogue under it settles back into action once the next line is known.
  //
  // A trailing `^` marks dual (simultaneous) dialogue: a cue variant, not
  // rendered as side-by-side columns; see the CSS comment on
  // `.cm-fountain-character-dual`.
  if (afterBlank) {
    const dual = trimmed.endsWith("^");
    const candidate = dual ? trimmed.slice(0, -1).trimEnd() : trimmed;
    if (looksLikeCharacterCue(candidate)) {
      return { token: dual ? "fountain-character-dual" : "fountain-character", inDialogue: true };
    }
  }

  if (inDialogue) return { token: "fountain-dialogue", inDialogue };
  return { token: "fountain-action", inDialogue: false };
}

/** What a line's token settles to once the line below it is known: a cue
 * with no dialogue under it, because an empty line or the end (`next`
 * undefined) follows, is action after all. Every other token stands. */
export function settledToken(token: string, next: string | undefined): string {
  if (token !== "fountain-character" && token !== "fountain-character-dual") return token;
  return next === undefined || next === "" ? "fountain-action" : token;
}
