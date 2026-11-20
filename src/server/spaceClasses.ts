// The space's Classes as a document's toolkit and Links tab read them: every
// Class in the space but its templates, which are copies waiting to be made.
// The document index finds and reads them, checking the space first.
import { lstatSync } from "node:fs";
import type { ClassLinks } from "../protocol/api.ts";
import { classLinkUse } from "../protocol/class.ts";
import { compareSortValues } from "../protocol/folderSort.ts";
import { resolveDeclaredPath } from "../protocol/relativeReference.ts";
import { basenameOf, dirnameOf, formatRootedPath } from "../protocol/rootedPath.ts";
import { splitDocumentName } from "../protocol/types.ts";
import { classRowOf } from "./classRows.ts";
import { documentIndex } from "./documentIndex.ts";
import { presetPaths, templatePaths } from "./presets.ts";
import type { ClassLinking } from "./resolveToolkits.ts";
import { resolveHeldPath } from "./rootedFiles.ts";

export interface HoldingClass extends ClassLinking {
  // Its title, else its file's name.
  name: string;
}

/** The Classes that hold `doc` as a row and link it anything, in the order
 * of their paths, natural and ignoring case as names are, each with its
 * links as written. */
export async function classesLinking(
  spaceRoot: string,
  doc: { path: string; filePath: string },
): Promise<HoldingClass[]> {
  const isPreset = presetPaths(spaceRoot);
  const classes = (await documentIndex().classes({ dir: spaceRoot, root: "space" }))
    .filter(({ path }) => !isPreset(path))
    .sort((a, b) => compareSortValues(a.path, b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const holding: HoldingClass[] = [];
  for (const { path: classPath, definition } of classes) {
    if (definition.links.length === 0 || !classRowOf(spaceRoot, classPath, definition, doc)) continue;
    const name = definition.name || splitDocumentName(basenameOf(classPath)).stem;
    holding.push({ classPath, name, links: definition.links });
  }
  return holding;
}

/** What each of `classes` lists in the Links tab of `docPath`: its links
 * that are neither a Flow nor a template, each an existing file, in the
 * space or a library, spelled as it is on disk. A Class with none is left
 * out, and the document never lists itself. */
export function classLinkedFiles(spaceRoot: string, classes: readonly HoldingClass[], docPath: string): ClassLinks[] {
  return classes.flatMap(({ classPath, name, links }) => {
    const paths: string[] = [];
    for (const written of links) {
      const held = linkedFile(spaceRoot, dirnameOf(classPath), written);
      if (held !== undefined && held !== docPath && !paths.includes(held)) paths.push(held);
    }
    return paths.length > 0 ? [{ classPath, name, paths }] : [];
  });
}

// A reference's file as it is spelled on disk, or undefined for a link that
// is a Flow or a template, or names no file.
function linkedFile(spaceRoot: string, classDir: string, written: string): string | undefined {
  try {
    const rooted = formatRootedPath(resolveDeclaredPath(classDir, written));
    if (classLinkUse(rooted, templatePaths(spaceRoot)) !== "reference") return undefined;
    const resolved = resolveHeldPath(spaceRoot, rooted, "read");
    return lstatSync(resolved.filePath, { throwIfNoEntry: false })?.isFile()
      ? formatRootedPath(resolved.rooted)
      : undefined;
  } catch {
    return undefined;
  }
}
