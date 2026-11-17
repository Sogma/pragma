// What a space entry may be named: the intersection of what its hosts allow,
// since a space is often a git checkout shared across machines — `<>:"|?*`
// and control characters are legal on Linux but fail to clone on Windows. No
// leading dot either: the tree filters dotfiles, so it would hide the file.
//
// A typed name is refused, so the person can fix it; one from an OS drag or a
// paste is repaired, since nobody is there to ask; a typed title is not a
// name, so one is derived and the title keeps every character.

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters in a filename are exactly what this matches
const ILLEGAL_NAME_CHARS = /[<>:"|?*\u0000-\u001f]/;
// The same class, global, for the repairing spelling only. Kept separate
// because `.test()` on a `/g` regex advances `lastIndex` and so alternates
// true and false across calls with the same string.
// biome-ignore lint/suspicious/noControlCharactersInRegex: as above
const ILLEGAL_NAME_CHARS_GLOBAL = /[<>:"|?*\u0000-\u001f]/g;

/** Whether a name hides its entry: a leading dot. No path names one, a
 * write refuses one, and no listing shows one. */
export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** Why this name can't be used, phrased for whoever typed it, or null if it
 * can. The message names the rule rather than the offending character: a
 * control character has no spelling to quote back. */
export function illegalEntryNameReason(name: string): string | null {
  if (ILLEGAL_NAME_CHARS.test(name)) return "A name can't contain < > : \" | ? * or control characters";
  if (isHiddenName(name)) return "A name can't start with a dot";
  return null;
}

/** The same rule applied rather than reported, for a name that came from
 * somewhere with no one to correct it. Illegal characters become `-`; leading
 * dots and surrounding whitespace are dropped. Can return "", which a caller
 * refuses — there is no name left to repair. */
export function sanitizeEntryName(name: string): string {
  return name.replace(ILLEGAL_NAME_CHARS_GLOBAL, "-").replace(/^\.+/, "").trim();
}

/** The name for a document whose typed title is kept verbatim inside it, so
 * the name need only read like it: a spaced colon becomes a spaced dash
 * (`Part 1: Intro` → `Part 1 - Intro`), a bare one a hyphen (`12:30` →
 * `12-30`), the rest of the class is dropped, and the ends lose stray dashes
 * and dots (Windows strips a trailing one on write). A caller refuses "". */
export function entryNameForTitle(title: string): string {
  return title
    .trim()
    .replace(/\s*:\s*/g, (colon) => (colon === ":" ? "-" : " - "))
    .replace(ILLEGAL_NAME_CHARS_GLOBAL, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "");
}

/** One file name's stem from text nobody is there to correct, such as a
 * name on a wire: repaired as a typed title is, a separator made a dash so
 * it never reaches outside its folder, a typed `extension` dropped, and held
 * to 100 characters. A caller refuses "" or falls back. */
export function fileStemFor(typed: string, extension: RegExp): string {
  const stem = typed.replace(extension, "").replace(/[\\/]+/g, "-");
  return entryNameForTitle(stem)
    .slice(0, 100)
    .replace(/[\s.-]+$/, "");
}

/** The form two names are compared in to decide whether they are the same
 * entry. Folding case alone is not enough: macOS also folds canonically
 * equivalent spellings — `é` typed as one code point, or arriving from
 * Finder as `e` plus a combining accent — onto one file, and a check that
 * misses that lets a rename replace the file it thought wasn't there. */
export function entryNameKey(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** Whether `name` is the one the protocol calls `defined`, compared as entry
 * names are, so `README.md` is found as `readme.md` on every platform rather
 * than only where the filesystem folds. */
export function isNamed(name: string, defined: string): boolean {
  return entryNameKey(name) === entryNameKey(defined);
}

/** Which of a folder's `names` is the entry the protocol calls `defined`:
 * that very spelling when present, else the one name folding to it. Two
 * that fold to it, neither spelled so, name none, as two paths do. */
export function spellingIn(names: Iterable<string>, defined: string): string | undefined {
  let found: string | undefined;
  let count = 0;
  for (const name of names) {
    if (name === defined) return name;
    if (isNamed(name, defined)) {
      found = name;
      count += 1;
    }
  }
  return count === 1 ? found : undefined;
}
