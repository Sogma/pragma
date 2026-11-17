// docs/protocol.md's World names: the scene number a Fountain heading may
// end with, which ends the location the heading links. One copy, so the
// location a host links and the number an editor draws end at the same `#`.

/** A scene number: its span in the line's text, both `#`s included, and
 * what they hold. */
export interface SceneNumber {
  from: number;
  to: number;
  number: string;
}

// Notes are blanked, never cut, so spans stay the line's own: a note after
// the number leaves it ending the line, and a `#…#` inside one is no number.
const NOTE = /\[\[.*?\]\]/g;
const NUMBER = /#([\p{L}\p{N}.-]+)#\s*$/u;

/** The scene number a heading's text ends with, its notes aside. */
export function sceneNumber(text: string): SceneNumber | undefined {
  const match = NUMBER.exec(text.replace(NOTE, (note) => " ".repeat(note.length)));
  if (!match) return undefined;
  return { from: match.index, to: match.index + match[1].length + 2, number: match[1] };
}
