// What a path written in a document may name, as a picker offers it: the
// files and folders of the document's own root, its folder's and its scope's
// first, and for a space document every library's files. The `[[` suggester
// and a `path` field's chooser both offer this, so they offer the same.
import { dirnameOf, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import { sameScope } from "../../src/protocol/scopes.ts";
import { isPresetPath } from "./presets.ts";
import { rankPaths } from "./quickOpenMatch.ts";
import type { LinkScope } from "./spaceTree.ts";

/** One entry a path may name: a file or folder, rooted. */
export interface LinkOffer {
  path: string;
  folder: boolean;
}

/** The entries the document `scope` describes may name, those `accept`
 * takes, ranked by `query`; with none, beside the document first, then in
 * its scope, files before folders, then the shorter path. A template is
 * offered only to a document among the templates, and nothing offers the
 * document itself. */
export function linkOffers(
  scope: LinkScope,
  libraryFiles: readonly string[],
  query: string,
  accept: (path: string) => boolean = () => true,
): LinkOffer[] {
  const docDir = dirnameOf(scope.docPath);
  const doc = parseRootedPath(scope.docPath);
  // A pick written relative, in the document's scope, ranks before one
  // written from the root.
  const nearness = (path: string) =>
    dirnameOf(path) === docDir ? 2 : sameScope(scope.scopes, doc, parseRootedPath(path)) ? 1 : 0;
  const amongPresets = isPresetPath(scope.docPath);
  const offered = (path: string) => path !== scope.docPath && (amongPresets || !isPresetPath(path)) && accept(path);
  const offers = new Map<string, LinkOffer>();
  for (const path of [...scope.files, ...libraryFiles]) if (offered(path)) offers.set(path, { path, folder: false });
  for (const path of scope.folders) if (offered(path)) offers.set(path, { path, folder: true });
  const paths = [...offers.keys()];
  const ranked = query.trim()
    ? rankPaths(paths, query, [], (path) => nearness(path) > 0)
    : paths.sort(
        (a, b) =>
          nearness(b) - nearness(a) ||
          Number(offers.get(a)?.folder) - Number(offers.get(b)?.folder) ||
          a.length - b.length ||
          a.localeCompare(b),
      );
  return ranked.map((path) => offers.get(path) as LinkOffer);
}
