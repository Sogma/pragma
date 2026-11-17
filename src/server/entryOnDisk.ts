// How a name the protocol matches, and a path below a root, read on disk.
// Kept below rootedFiles.ts, which reads the library registry: the registry
// reads the space's `_libraries.json` through these, and would otherwise
// import the module that imports it.
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { spellingIn } from "../protocol/entryName.ts";
import { isHiddenPath } from "../protocol/relativeReference.ts";

/** The first symbolic link below `dir` on the way to `absolutePath`, as a
 * `/`-separated path from `dir`. Pragma follows none inside a root
 * (docs/protocol.md, Symbolic links): one pointing out carries a read or a
 * write past the containment check, one pointing in gives a file a second
 * path.
 *
 * `dir` and everything above it go unchecked — that path is the machine's
 * arrangement, and macOS's own `/tmp` and `/var` are links. A caller naming
 * a file inside a directory that already passed may pass that directory,
 * leaving only the last segment to test. The walk stops at the first entry
 * that doesn't exist yet: nothing past it can be a link. */
export function linkBelow(dir: string, absolutePath: string): string | undefined {
  let current = dir;
  for (const segment of path.relative(dir, absolutePath).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (!stats) return undefined;
    if (stats.isSymbolicLink()) return path.relative(dir, current).split(path.sep).join("/");
  }
  return undefined;
}

/** Whether a name between `dir` and `absolutePath` hides its entry, read as
 * the disk names it rather than as spelled: on Windows a short name such as
 * `GIT~1` opens `.git`. Past the deepest entry that exists, the path is read
 * as spelled, since nothing there has a second name yet. */
export function hiddenBelow(dir: string, absolutePath: string): boolean {
  return isHiddenPath(path.relative(onDisk(dir), onDisk(absolutePath)).split(path.sep).join("/"));
}

// The deepest entry the disk can name, by the names it gives it, then the
// rest as spelled. Node's native realpath, not its JS one, which keeps a
// short name as typed. Any failure reads as absent, so a volume that can't
// name its paths reads wholly as spelled rather than refusing every write.
function onDisk(absolutePath: string): string {
  const rest: string[] = [];
  for (let at = absolutePath; ; at = path.dirname(at)) {
    try {
      return path.join(realpathSync.native(at), ...rest);
    } catch {
      if (path.dirname(at) === at) return absolutePath;
      rest.unshift(path.basename(at));
    }
  }
}

/** Where the file or folder the protocol calls `name` sits in `dir`, spelled
 * as the disk spells it, or `name` itself when it isn't there. A reader finds
 * any spelling, on every platform, and a writer keeps the one already there
 * rather than adding a second that folds to it. */
export function namedEntryPath(dir: string, name: string): string {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // A folder that can't be listed holds nothing to find.
  }
  return path.join(dir, spellingIn(names, name) ?? name);
}
