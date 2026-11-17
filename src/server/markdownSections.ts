// A Markdown document's sections, by its headings, for a model to read one
// at a time: Pragma's spec through the copilot, a long note through a
// generation's look. A section runs from its heading to the next heading of
// its level or above, so it holds its subsections.

/** One heading and the lines it heads, `start` to before `end`. */
export interface MarkdownSection {
  level: number;
  title: string;
  anchor: string;
  start: number;
  end: number;
}

export interface MarkdownOutline {
  lines: string[];
  sections: MarkdownSection[];
}

// GitHub's anchor rule, with runs of spaces and hyphens folded into one, so a
// title, its anchor and a `#link` to it all name the same heading.
export function anchorKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .split(/[\s-]+/)
    .filter(Boolean)
    .join("-");
}

/** The document's headings, outside its frontmatter and code fences. A
 * lone `#` heading is its title, the whole document, so it heads no section
 * of its own. */
export function outlineOf(markdown: string): MarkdownOutline {
  const lines = markdown.split("\n");
  const found: Omit<MarkdownSection, "anchor" | "end">[] = [];
  let fence: string | undefined;
  let index = lines[0]?.trim() === "---" ? lines.findIndex((line, at) => at > 0 && line.trim() === "---") + 1 : 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    const marker = /^(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (fence === undefined || marker.startsWith(fence))) {
      fence = fence === undefined ? marker : undefined;
      continue;
    }
    const match = fence === undefined ? /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line) : null;
    if (match) found.push({ level: match[1].length, title: match[2], start: index });
  }
  const titles = found.filter((heading) => heading.level === 1);
  const headings = titles.length === 1 ? found.filter((heading) => heading !== titles[0]) : found;
  // A repeated title takes GitHub's -1, -2 suffix, so an anchor never names
  // two headings.
  const seen = new Map<string, number>();
  const sections = headings.map((heading, at) => {
    const base = anchorKey(heading.title);
    const repeats = seen.get(base) ?? 0;
    seen.set(base, repeats + 1);
    const next = headings.slice(at + 1).find((later) => later.level <= heading.level);
    return { ...heading, anchor: repeats === 0 ? base : `${base}-${repeats}`, end: next?.start ?? lines.length };
  });
  return { lines, sections };
}

/** The section `name` names, by its anchor or its title, a `#` before it
 * allowed; undefined when none does. */
export function findSection(outline: MarkdownOutline, name: string): MarkdownSection | undefined {
  const wanted = anchorKey(name.slice(name.lastIndexOf("#") + 1));
  return outline.sections.find((section) => section.anchor === wanted);
}

/** A section's text, its heading first. */
export function sectionText(outline: MarkdownOutline, section: MarkdownSection): string {
  return outline.lines.slice(section.start, section.end).join("\n").trim();
}

/** Where a section starts, in characters from the document's start. */
export function sectionOffset(outline: MarkdownOutline, section: MarkdownSection): number {
  return outline.lines.slice(0, section.start).reduce((sum, line) => sum + line.length + 1, 0);
}

/** Where a cut at `offset` characters falls: the last heading before it,
 * and every heading past it. */
export function headingsPast(
  outline: MarkdownOutline,
  offset: number,
): { within?: MarkdownSection; after: MarkdownSection[] } {
  const before = outline.sections.filter((section) => sectionOffset(outline, section) < offset);
  return { within: before.at(-1), after: outline.sections.slice(before.length) };
}
