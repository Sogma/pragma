import { describe, expect, it, vi } from "vitest";
import type { LinkRequest } from "../../../src/protocol/api.ts";
import { takeLinkRequests } from "../../../web/services/linkRequests.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The main process's side: what each take hands over, in turn, and the word
// that another link has come.
function bridgeHolding(...requests: (LinkRequest | null)[]) {
  let waiting: (() => void) | undefined;
  const bridge = {
    takeLink: vi.fn(async () => requests.shift() ?? null),
    onLinkWaiting: vi.fn((callback: () => void) => {
      waiting = callback;
      return () => {
        waiting = undefined;
      };
    }),
  };
  return { bridge, tellWaiting: () => waiting?.() };
}

function setup(...requests: (LinkRequest | null)[]) {
  const { bridge, tellWaiting } = bridgeHolding(...requests);
  const deps = { tabs: { openSpacePath: vi.fn(async () => undefined) }, notify: vi.fn() };
  const taking = takeLinkRequests(bridge, deps);
  return { bridge, tellWaiting, deps, taking };
}

describe("taking what a Pragma link asks of the window", () => {
  it("takes a waiting link as the window comes up, opening its file beside the current tab", async () => {
    const { deps } = setup({ open: { path: "projects/a.md", folder: false } });
    await settle();
    expect(deps.tabs.openSpacePath).toHaveBeenCalledWith("projects/a.md", { beside: true });
  });

  it("opens a folder as its folder, and asks nothing more for the space itself", async () => {
    const { deps, tellWaiting } = setup(
      { open: { path: "lib:refs/Lina", folder: true } },
      { open: { path: "", folder: true } },
    );
    await settle();
    expect(deps.tabs.openSpacePath).toHaveBeenCalledWith("lib:refs/Lina/", { beside: true });
    tellWaiting();
    await settle();
    expect(deps.tabs.openSpacePath).toHaveBeenCalledTimes(1);
  });

  it("says why a refused link opens nothing", async () => {
    const { deps } = setup({ refusal: 'No space named "Elsewhere" on this computer' });
    await settle();
    expect(deps.notify).toHaveBeenCalledWith('No space named "Elsewhere" on this computer');
    expect(deps.tabs.openSpacePath).not.toHaveBeenCalled();
  });

  // A link that comes while the window shows is word to take again.
  it("takes again whenever another link has come, and stops when disposed", async () => {
    const { bridge, deps, tellWaiting, taking } = setup(null, { open: { path: "b.md", folder: false } });
    await settle();
    expect(deps.tabs.openSpacePath).not.toHaveBeenCalled();
    tellWaiting();
    await settle();
    expect(deps.tabs.openSpacePath).toHaveBeenCalledWith("b.md", { beside: true });
    taking.dispose();
    tellWaiting();
    expect(bridge.takeLink).toHaveBeenCalledTimes(2);
  });

  it("does nothing in the browser, or when the take fails", async () => {
    const deps = { tabs: { openSpacePath: vi.fn(async () => undefined) }, notify: vi.fn() };
    takeLinkRequests(undefined, deps).dispose();
    const failing = {
      takeLink: vi.fn(async (): Promise<LinkRequest | null> => Promise.reject(new Error("gone"))),
      onLinkWaiting: vi.fn(() => () => undefined),
    };
    takeLinkRequests(failing, deps);
    await settle();
    expect(failing.takeLink).toHaveBeenCalledOnce();
    expect(deps.tabs.openSpacePath).not.toHaveBeenCalled();
    expect(deps.notify).not.toHaveBeenCalled();
  });
});
