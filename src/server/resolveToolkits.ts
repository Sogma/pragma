import { existsSync } from "node:fs";
import { resolveDeclaredPath } from "../protocol/relativeReference.ts";
import { dirnameOf, formatRootedPath, isLibraryRoot } from "../protocol/rootedPath.ts";
import { isFlowFile } from "../protocol/types.ts";
import { resolveHeldPath } from "./rootedFiles.ts";

export interface ToolkitCandidate {
  // The Class holding the document as a row that links this Flow: why this
  // toolkit is here at all, for a human inspecting the space.
  classPath: string;
  // Space-relative, e.g. "tools/lyrics.flow.html" — what the client's
  // /api/sandbox/* broker calls send back as `path`.
  path: string;
}

/** A Class holding the document as a row, and what it links its rows to,
 * each written from the Class's folder. */
export interface ClassLinking {
  classPath: string;
  links: readonly string[];
}

/** Resolves every toolkit the Classes in `classes` give the document they
 * hold (docs/protocol.md's Toolkit resolution): each Flow they link, in
 * their order and each one's links in order, once each. Nothing resolving
 * means an empty array: there is no built-in fallback. */
export function resolveToolkits(spaceRoot: string, classes: readonly ClassLinking[]): ToolkitCandidate[] {
  const seenPaths = new Set<string>();
  const candidates: ToolkitCandidate[] = [];
  for (const { classPath, links } of classes) {
    for (const written of links) {
      // Read as any path the Class writes, from its folder, then contained
      // like any request path: a candidate is only ever a file inside the
      // space, reached through no link, spelled as it is on disk.
      let toolkitPath: string;
      let absolute: string;
      try {
        const rooted = resolveDeclaredPath(dirnameOf(classPath), written);
        if (isLibraryRoot(rooted.root)) continue;
        const resolved = resolveHeldPath(spaceRoot, formatRootedPath(rooted), "read");
        toolkitPath = resolved.rooted.path;
        absolute = resolved.filePath;
      } catch {
        continue;
      }
      if (seenPaths.has(toolkitPath) || !isFlowFile(toolkitPath) || !existsSync(absolute)) continue;
      seenPaths.add(toolkitPath);
      candidates.push({ classPath, path: toolkitPath });
    }
  }
  return candidates;
}
