// Space trust: git runs only in a space the person has said they trust, since
// a repository's own settings can make git run any program
// (docs/architecture.md's Space identity and state ownership). This module asks —
// unprompted, once, for an open space whose repository nobody has been asked
// about, and on request from Source Control and Manage Spaces.
import type { SpaceListResponse } from "../core/apiClient.ts";
import type { DialogService } from "../services/dialog.ts";
import type { GitStatusState, gitStatusStore } from "../services/gitStatus.ts";

export interface SpaceTrustDeps {
  dialog: DialogService;
  fetchSpaceList(): Promise<SpaceListResponse>;
  postSpaceTrust(id: string, trusted: boolean): Promise<void>;
  // Watched to ask unprompted, and refreshed after a decision so the git
  // readouts enter or leave restricted mode.
  store: Pick<typeof gitStatusStore, "subscribe" | "refresh">;
}

export interface SpaceTrust {
  /** Asks whether to trust a space and records the answer, "no" included. */
  ask(space: { id: string; label: string }, parentRepo?: string): Promise<void>;
  /** The same for the open space; rejects when it has no registry id. */
  askForOpenSpace(parentRepo?: string): Promise<void>;
  revoke(id: string): Promise<void>;
}

export function createSpaceTrust(deps: SpaceTrustDeps): SpaceTrust {
  let askedUnprompted = false;

  async function ask(space: { id: string; label: string }, parentRepo?: string): Promise<void> {
    const trusted = await deps.dialog.confirm({
      title: "Do you trust this space?",
      icon: "space",
      message:
        `Pragma runs git in “${space.label}” to show its changes and sync it. A repository's own settings ` +
        "can make git run any program on this computer, so trust a space only if you made it or got it " +
        "from someone you trust.",
      warning: parentRepo ? `Its git repository starts above the space, at ${parentRepo}.` : undefined,
      confirmLabel: "Trust space",
      cancelLabel: "Don't trust",
      busyLabel: "Trusting…",
      action: () => deps.postSpaceTrust(space.id, true),
    });
    // Dismissing records "no" too, or the unprompted ask would come back on
    // every open. Restricted is what an unanswered space gets anyway.
    if (!trusted) await deps.postSpaceTrust(space.id, false).catch(() => undefined);
    void deps.store.refresh();
  }

  async function askForOpenSpace(parentRepo?: string): Promise<void> {
    const { current } = await deps.fetchSpaceList();
    if (!current.id) throw new Error("This space isn't registered, so there is nothing to record its trust against.");
    await ask({ id: current.id, label: current.label || current.name }, parentRepo);
  }

  deps.store.subscribe((state: GitStatusState) => {
    if (askedUnprompted || state.phase !== "ready") return;
    const { status } = state;
    if (!status.isRepo || !status.restricted || status.trust !== "undecided") return;
    askedUnprompted = true;
    void askForOpenSpace(status.parentRepo).catch(() => undefined);
  });

  return {
    ask,
    askForOpenSpace,
    async revoke(id) {
      await deps.postSpaceTrust(id, false);
      void deps.store.refresh();
    },
  };
}
