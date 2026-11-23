/**
 * An id made from a name a person typed: its lowercase ASCII letters and
 * digits, each run of anything else one dash, suffixed -2, -3, … past an id
 * `taken` holds. `fallback` stands in for a name with nothing to keep.
 */
export function uniqueSlug(name: string, taken: ReadonlySet<string>, fallback: string): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
