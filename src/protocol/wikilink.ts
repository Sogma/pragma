// docs/protocol.md's Links section: what a wikilink looks like, what it shows
// and how a host writes one. A wikilink's target is a path, read by the same
// grammar as any other (relativeReference.ts, pathIndex.ts), never a name.
import { formatWrittenPath } from "./relativeReference.ts";
import { basenameOf, hasPathScheme, type RootedPath } from "./rootedPath.ts";
import type { ScopeFolders } from "./scopes.ts";
import { hasKnownKind, splitDocumentName } from "./types.ts";

/** A fresh `[[target]]` / `[[target|display]]` matcher. A factory rather
 * than a shared constant because the pattern is global: one instance carries
 * `lastIndex` between unrelated scans, so whichever caller ran second would
 * start mid-string and miss matches. */
export function wikilinkPattern(): RegExp {
  return /\[\[([^[\]]+)\]\]/g;
}

/** Splits a wikilink's raw inner text at the first `|` — everything before
 * is the target, everything after is what the reader sees. An unpiped link,
 * or one whose display half is blank, displays its own target; a relative
 * one only its file or folder name, since its folders mean nothing to a
 * reader. */
export function splitWikilinkLabel(raw: string): { target: string; display: string } {
  const pipeIndex = raw.indexOf("|");
  const target = (pipeIndex === -1 ? raw : raw.slice(0, pipeIndex)).trim();
  const display = (pipeIndex === -1 ? "" : raw.slice(pipeIndex + 1)).trim();
  if (display) return { target, display };
  return { target, display: isRelativeWikilinkTarget(target) ? wikilinkName(target) || target : target };
}

/** True for a target read from the linking document's folder: one with no
 * scheme and no leading `/`. */
export function isRelativeWikilinkTarget(target: string): boolean {
  return target !== "" && !target.startsWith("/") && !hasPathScheme(target);
}

/** A file's basename with its extension stripped, compound ones whole. */
export function wikilinkStem(filePath: string): string {
  return splitDocumentName(basenameOf(filePath)).stem;
}

/** The name a link to `path` shows with no display text of its own: a
 * folder's name, or a file's with the extension stripped, except on a file
 * of no kind, whose extension is all that says what it is. */
export function wikilinkName(path: string): string {
  if (path.endsWith("/")) {
    return basenameOf(path.replace(/\/+$/, ""));
  }
  return hasKnownKind(path) ? wikilinkStem(path) : basenameOf(path);
}

/** The whole label a host writes inside `[[…]]`: `target`, piped with the
 * linked file's display title only when the unpiped link would show
 * something else. A missing title is the file's name, as the display-title
 * rule has it. Brackets would end the link early, so they're dropped. */
export function formatWikilinkLabel(target: string, title: string | undefined): string {
  const display = (title ?? "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || wikilinkName(target);
  return display === splitWikilinkLabel(target).display ? target : `${target}|${display}`;
}

/** The whole wikilink a host writes: the label, in its brackets. */
export function formatWikilink(target: string, title: string | undefined): string {
  return `[[${formatWikilinkLabel(target, title)}]]`;
}

/** The wikilink a document at the space root writes to `target`, showing its
 * name: what an agent is handed to copy into text read as from the root, so
 * the links it writes follow this rule wherever the rule goes. */
export function wikilinkFromRoot(target: RootedPath, scopes: ScopeFolders, folder = false): string {
  const written = formatWrittenPath("", target, { form: "wikilink", scopes, folder });
  if (written === undefined) throw new Error("The space root names every entry");
  return formatWikilink(written, undefined);
}
