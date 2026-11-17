import { describe, expect, it, vi } from "vitest";
import type { GitStatus, SpaceListResponse } from "../../../web/core/apiClient.ts";
import type { ConfirmOptions, DialogService } from "../../../web/services/dialog.ts";
import type { GitStatusState } from "../../../web/services/gitStatus.ts";
import { createSpaceTrust } from "../../../web/view/spaceTrust.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(answer: boolean, list?: Partial<SpaceListResponse>) {
  const confirm = vi.fn(async (options: ConfirmOptions) => {
    if (answer) await options.action?.();
    return answer;
  });
  const deps = {
    dialog: { confirm } as unknown as DialogService,
    fetchSpaceList: vi.fn(async () => ({
      current: { id: "spc_open", name: "open", path: "/spaces/open", label: "Open" },
      spaces: [],
      recent: [],
      ...list,
    })),
    postSpaceTrust: vi.fn(async () => undefined),
    store: {
      subscribe: vi.fn((listener: (state: GitStatusState) => void) => {
        emit = listener;
        return () => undefined;
      }),
      refresh: vi.fn(async () => undefined),
    },
  };
  let emit: (state: GitStatusState) => void = () => undefined;
  const trust = createSpaceTrust(deps);
  return { trust, deps, confirm, emit: (status: GitStatus) => emit(ready(status)) };
}

const ready = (status: GitStatus) => ({ phase: "ready" as const, status });
const UNDECIDED: GitStatus = { isRepo: true, restricted: true, trust: "undecided" };

describe("spaceTrust", () => {
  it("asks unprompted once, for an open space whose repository was never asked about", async () => {
    const { emit, confirm, deps } = setup(true);
    emit(UNDECIDED);
    emit(UNDECIDED);
    await tick();
    expect(confirm).toHaveBeenCalledOnce();
    // What's asked about is a space: its icon before the title.
    expect(confirm.mock.calls[0][0].icon).toBe("space");
    expect(deps.postSpaceTrust).toHaveBeenCalledWith("spc_open", true);
    expect(deps.store.refresh).toHaveBeenCalledOnce();
  });

  it("never asks unprompted about a declined space, a trusted one, or no repository", async () => {
    const { emit, confirm } = setup(true);
    emit({ isRepo: true, restricted: true, trust: "declined" });
    emit({ isRepo: true, branch: "main", ahead: 0, behind: 0, files: [] });
    emit({ isRepo: false });
    await tick();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("records a dismissal as declined, so the unprompted ask happens once", async () => {
    const { emit, deps } = setup(false);
    emit(UNDECIDED);
    await tick();
    expect(deps.postSpaceTrust).toHaveBeenCalledExactlyOnceWith("spc_open", false);
  });

  it("names a repository that starts above the space", async () => {
    const { trust, confirm } = setup(true);
    await trust.askForOpenSpace("/home/someone");
    expect(confirm.mock.calls[0][0].warning).toContain("/home/someone");
  });

  it("refuses to ask about an unregistered space, which has nothing to record trust against", async () => {
    const { trust, confirm } = setup(true, { current: { name: "loose", path: "/loose" } });
    await expect(trust.askForOpenSpace()).rejects.toThrow("isn't registered");
    expect(confirm).not.toHaveBeenCalled();
  });
});
