// The context a tab is seen in: the scope its file or folder sits in, by the
// protocol's rule, as that scope's folder's rooted path. The space's own is
// "", and a library's is its top, a library being one scope. Everything
// shown in the tab takes it, wherever the media it shows lives: the guides
// and look over that media, and the folder a frame saved from it is offered.
import { rootedScopeOf } from "../../src/protocol/scopes.ts";
import type { Tab } from "./apiClient.ts";
import { scopesOf } from "./spaceTree.ts";

export function contextOfTab(tab: Tab): string {
  return tab.kind === "empty" ? "" : rootedScopeOf(scopesOf(""), tab.path);
}
