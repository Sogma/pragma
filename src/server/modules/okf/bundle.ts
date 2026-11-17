// Which Open Knowledge Format bundle a turn sits in. A bundle is declared,
// never guessed: its root folder's `index.md` holds `okf_version` in its
// frontmatter, the one place OKF lets an `index.md` hold any. Guessing from
// a folder's shape would hand OKF's rules to a space that never chose them.
import { readFrontmatter } from "../../../protocol/frontmatter.ts";
import { dirnameOf } from "../../../protocol/rootedPath.ts";
import type { ContextRequest } from "../../copilotContext.ts";

export interface Bundle {
  /** The root folder, written with `/`, "" for the space root. */
  readonly folder: string;
  /** What its `okf_version` says, or undefined when it says nothing usable. */
  readonly version: string | undefined;
  /** The root's `index.md`: its path, and its body without the frontmatter. */
  readonly index: { readonly path: string; readonly body: string };
  /** The `index.md` closest to the turn's folder, below the root. */
  readonly closestListing: string | undefined;
}

/** The nearest declared bundle at or above the turn's folder, or null.
 *
 * Unlike the walk for a project README, this one reaches the space root,
 * since a whole space can be a bundle. A listing the model may not see is
 * read as absent, so it neither declares a bundle nor gets named. */
export async function findBundle(request: ContextRequest): Promise<Bundle | null> {
  let closestListing: string | undefined;
  for (let folder = request.folder; ; folder = dirnameOf(folder)) {
    const index = await request.readNamed(folder, "index.md");
    if (index) {
      const { data, body } = readFrontmatter(index.content);
      if (Object.hasOwn(data, "okf_version")) {
        return { folder, version: versionOf(data.okf_version), index: { path: index.path, body }, closestListing };
      }
      closestListing ??= index.path;
    }
    if (folder === "") return null;
  }
}

// YAML reads `okf_version: 0.2` as a number, and the spec writes it quoted.
function versionOf(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return String(value).trim() || undefined;
}
