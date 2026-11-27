// The rule a Table column's id is made by, from its name or from an id a
// person types.

// Latin letters an accent fold leaves as themselves.
const LETTERS: Record<string, string> = { ß: "ss", æ: "ae", œ: "oe", ø: "o", ł: "l", đ: "d", ð: "d", þ: "th", ı: "i" };

/** `text` as a column id: lowercase ASCII letters and digits, accents
 * folded to the letter under them, and each run of anything else one
 * underscore, none at either end. "" when nothing is left. */
export function columnIdOf(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøłđðþı]/g, (letter) => LETTERS[letter])
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** The id a new column named `name` takes: its name's, else `column`, made
 * unique past the ids `taken` holds by `_2`, `_3`, … A name with nothing to
 * keep is numbered from `column_1`, so no id reads as a column's name. */
export function columnIdFor(name: string, taken: ReadonlySet<string>): string {
  const base = columnIdOf(name);
  if (base && !taken.has(base)) return base;
  const stem = base || "column";
  let n = base ? 2 : 1;
  while (taken.has(`${stem}_${n}`)) n++;
  return `${stem}_${n}`;
}
