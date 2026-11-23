// The window's title follows the focused tab and always ends in the app's
// name: "Art: shots/a.jpg | Pragma". A library file is named by its library
// and the path inside it, since its `lib:<id>` address is for storage and the
// wire. A library's name can arrive, or change, after its tab shows, so the
// title is drawn again then.
import { isLibraryPath, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import { onLibraryNames } from "../core/libraries.ts";
import { rootName } from "../core/paths.ts";
import type { Tabs } from "../services/tabs.ts";

/** Draws the focused tab's path into the window title from now on. What it
 * returns draws the path the focused tab's file moved to, a move no focus
 * change announces. */
export function wireWindowTitle(appName: string, tabs: Pick<Tabs, "onFocus">): (path: string) => void {
  let shown: string | undefined;
  const show = (path: string | undefined): void => {
    shown = path;
    document.title = titleFor(appName, path);
  };
  tabs.onFocus((tab) => show(tab.kind === "empty" ? undefined : tab.path));
  onLibraryNames(() => show(shown));
  return show;
}

function titleFor(appName: string, path: string | undefined): string {
  return path === undefined ? appName : `${pathTitle(path)} | ${appName}`;
}

// A root is called by its name, as its tab is: the space's own folder has the
// empty path, which would leave the title starting with "|".
function pathTitle(path: string): string {
  if (!isLibraryPath(path)) return path || rootName("space");
  const { root, path: inside } = parseRootedPath(path);
  return inside ? `${rootName(root)}: ${inside}` : rootName(root);
}
