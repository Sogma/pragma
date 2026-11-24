// What a Pragma link asks of the window, which the desktop app's main
// process holds until the window takes it: once the window is up, and again
// whenever it hears another has come. An entry opens in a new tab, as a path
// from outside the tree opens; a refused link says why.

import type { LinkRequest } from "../../src/protocol/api.ts";
import type { PragmaElectronBridge } from "../core/apiClient.ts";
import { type Disposable, toDisposable } from "../lib/disposable.ts";
import type { Tabs } from "./tabs.ts";

export interface LinkRequestDeps {
  tabs: Pick<Tabs, "openSpacePath">;
  notify(message: string): void;
}

/** `bridge` is absent in the browser, which takes no links. */
export function takeLinkRequests(
  bridge: Pick<PragmaElectronBridge, "takeLink" | "onLinkWaiting"> | undefined,
  deps: LinkRequestDeps,
): Disposable {
  if (!bridge) return toDisposable(() => undefined);
  const act = async (request: LinkRequest | null): Promise<void> => {
    if (request === null) return;
    if ("refusal" in request) return deps.notify(request.refusal);
    const { path, folder } = request.open;
    // A link to the space itself asks for what the window already shows.
    if (path !== "") await deps.tabs.openSpacePath(folder ? `${path}/` : path, { beside: true });
  };
  const take = () => void bridge.takeLink().then(act, () => undefined);
  const stop = bridge.onLinkWaiting(take);
  take();
  return toDisposable(stop);
}
