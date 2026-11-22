// The Source Control view: the rail button and its badge, and the panel's
// status and actions.
//
// Each action reads or rewrites the working tree the editor holds buffers
// over, so it runs inside the bracket in services/gitActions.ts: flush, lock
// the workspace, then read back what changed on disk. Otherwise typing once
// in an open note after a pull reverts the pulled edit locally, and the next
// Sync commits and pushes that reversion.
import { type GitStatus, postGitCommit, postGitPull, postGitPush, postGitSync } from "../../core/apiClient.ts";
import { countText, must } from "../../lib/dom.ts";
import { createGitActions } from "../../services/gitActions.ts";
import { type GitStatusState, gitStatusStore } from "../../services/gitStatus.ts";
import type { SaveQueueState } from "../../services/saveQueue.ts";
import type { RailStatus, SidebarView } from "../../services/sidebarViews.ts";

const ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="7" cy="5" r="2.3" />
  <circle cx="7" cy="19" r="2.3" />
  <circle cx="17" cy="8" r="2.3" />
  <line x1="7" y1="7.3" x2="7" y2="16.7" />
  <path d="M17 10.3V13a2 2 0 0 1-2 2H7" />
</svg>`;

// The space's git state at a glance on the rail: the count of uncommitted
// files, or a warning mark while git is off in an untrusted space. The
// branch and ahead/behind are in the title. A failed read keeps showing the
// last status it knew.
export function railStatusOf(state: GitStatusState): RailStatus {
  const status = state.phase === "ready" ? state.status : state.phase === "error" ? state.last : undefined;
  if (!status?.isRepo) return {};
  if (status.restricted) {
    return {
      badge: { text: "!", tone: "warning" },
      detail: "Restricted mode: git is off until you trust this space. Click to review.",
    };
  }
  const count = status.files.length;
  const summary = [`On ${status.branch ?? "detached HEAD"}`];
  if (count) summary.push(countText(count, "uncommitted change"));
  if (status.behind) summary.push(`${status.behind} to pull`);
  if (status.ahead) summary.push(`${status.ahead} to push`);
  if (summary.length === 1) summary.push("working tree clean, in sync");
  // Capped so the pill stays inside the rail's width.
  const badge = count ? { text: count > 99 ? "99+" : String(count), tone: "count" as const } : undefined;
  return { badge, detail: summary.join(" · ") };
}

export function createSourceControlView(panel: HTMLElement, onShow: () => void): SidebarView {
  const status = {
    subscribe: (listener: (status: RailStatus) => void) =>
      gitStatusStore.subscribe((state) => listener(railStatusOf(state))),
  };
  return { id: "source-control", label: "Source Control", icon: ICON, panel, onShow, status };
}

export interface SourceControlPanelDeps {
  // Resolves false when something is still unwritten — see saveQueue.flush.
  flushPendingSave: () => Promise<SaveQueueState | undefined>;
  // Re-reads these paths into any open model; resolves to the ones that
  // couldn't be read back.
  reloadPaths: (paths: readonly string[]) => Promise<string[]>;
  dropTabsForGonePaths: (paths: readonly string[]) => void;
  refreshTree: () => Promise<void>;
  // Locks the editing surface while an action runs, so nothing is typed
  // into a buffer a pull is about to replace.
  setWorkspaceLocked: (locked: boolean) => void;
  // Restricted mode's way out: asks whether to trust the open space.
  trustSpace: (parentRepo?: string) => Promise<void>;
}

export function wireSourceControlPanel(deps: SourceControlPanelDeps): void {
  const gitNotRepo = must<HTMLDivElement>("#git-not-repo");
  const gitRestricted = must<HTMLDivElement>("#git-restricted");
  const gitRestrictedMessage = must<HTMLParagraphElement>("#git-restricted-message");
  const gitTrustButton = must<HTMLButtonElement>("#git-trust-button");
  const gitBranchInfo = must<HTMLDivElement>("#git-branch-info");
  const gitBranchName = must<HTMLSpanElement>("#git-branch-name");
  const gitFileList = must<HTMLDivElement>("#git-file-list");
  const gitPrimaryActions = must<HTMLDivElement>("#git-primary-actions");
  const gitSyncButton = must<HTMLButtonElement>("#git-sync-button");
  const gitSyncLabel = must<HTMLSpanElement>("#git-sync-label");
  const gitAdvancedToggle = must<HTMLButtonElement>("#git-advanced-toggle");
  const gitAdvanced = must<HTMLDivElement>("#git-advanced");
  const gitCommitMessage = must<HTMLTextAreaElement>("#git-commit-message");
  const gitCommitButton = must<HTMLButtonElement>("#git-commit-button");
  const gitPullButton = must<HTMLButtonElement>("#git-pull-button");
  const gitPushButton = must<HTMLButtonElement>("#git-push-button");
  const gitStatusMessage = must<HTMLDivElement>("#git-status-message");
  let gitBusy = false;
  let parentRepo: string | undefined;

  function renderGitStatus(status: GitStatus): void {
    const restricted = status.isRepo && status.restricted;
    gitRestricted.hidden = !restricted;
    if (!status.isRepo || status.restricted) {
      gitNotRepo.hidden = status.isRepo;
      gitBranchInfo.hidden = true;
      gitFileList.innerHTML = "";
      gitPrimaryActions.hidden = true;
      gitAdvanced.hidden = true;
      parentRepo = status.isRepo ? status.parentRepo : undefined;
      gitRestrictedMessage.textContent = parentRepo
        ? `Restricted mode: this space sits inside the git repository at ${parentRepo}, and git stays off until you trust the space.`
        : "Restricted mode: this space is a git repository, and git stays off until you trust it.";
      return;
    }
    gitNotRepo.hidden = true;
    gitPrimaryActions.hidden = false;

    const aheadBehind = status.ahead || status.behind ? ` (↑${status.ahead} ↓${status.behind})` : "";
    gitBranchInfo.hidden = false;
    // The name in a span of its own, which selects whole (source-control.css):
    // the counts and "(detached HEAD)" are the row's words, not a value.
    const branch = document.createElement("span");
    branch.className = "git-branch-label";
    branch.textContent = status.branch;
    gitBranchName.replaceChildren(status.branch === null ? "(detached HEAD)" : branch, aheadBehind);
    gitSyncLabel.textContent =
      status.ahead || status.behind ? `Sync Changes ↓${status.behind}↑${status.ahead}` : "Sync Changes";

    gitFileList.innerHTML = "";
    if (status.files.length === 0) {
      const clean = document.createElement("div");
      clean.className = "git-file";
      clean.textContent = "No changes.";
      gitFileList.appendChild(clean);
    }
    for (const file of status.files) {
      const row = document.createElement("div");
      row.className = "git-file";

      const code = document.createElement("span");
      code.className = "status-code";
      code.textContent = file.statusCode;

      const label = document.createElement("span");
      label.className = "git-file-path";
      label.textContent = file.path;

      row.appendChild(code);
      row.appendChild(label);
      gitFileList.appendChild(row);
    }
  }

  // The panel renders off the git status store, as the rail badge does, and
  // never fetches. A failed load keeps the last-known status and shows the
  // error in the panel's message row. An action failure sets that row itself
  // and leaves the store alone, so the badge doesn't lie about the tree
  // because a push couldn't reach the remote.
  gitStatusStore.subscribe((state) => {
    if (state.phase === "loading") return;
    if (state.phase === "error") {
      if (state.last) renderGitStatus(state.last);
      gitStatusMessage.hidden = false;
      gitStatusMessage.textContent = state.message;
      return;
    }
    renderGitStatus(state.status);
    gitStatusMessage.hidden = true;
  });

  // All git actions touch the same working tree, so only one may run at a
  // time — otherwise e.g. a Sync in flight and a manual Pull from the
  // advanced panel could race on the same repo. `gitBusy` also suppresses
  // the focus-triggered refresh while an action is mid-flight.
  function setGitBusy(busy: boolean): void {
    gitBusy = busy;
    gitSyncButton.disabled = busy;
    gitAdvancedToggle.disabled = busy;
    gitCommitButton.disabled = busy;
    gitPullButton.disabled = busy;
    gitPushButton.disabled = busy;
    // The whole workspace is locked for the duration, not just these
    // buttons. A keystroke landing between the pre-flush and the post-pull
    // reload would go into a buffer that is about to be stale, and the save
    // it schedules would revert what the pull just brought in — the exact
    // race the reload exists to close.
    deps.setWorkspaceLocked(busy);
  }

  // A commit or pull may have happened in a terminal meanwhile. The store owns
  // the throttle; a refresh is skipped while an action is in flight, since the
  // action feeds the store its own result when it lands.
  const refreshOnFocus = () => gitStatusStore.refreshOnFocus(() => gitBusy);
  window.addEventListener("focus", refreshOnFocus);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refreshOnFocus();
  });

  gitTrustButton.addEventListener("click", () => {
    gitStatusMessage.hidden = true;
    deps.trustSpace(parentRepo).catch((error: unknown) => {
      gitStatusMessage.hidden = false;
      gitStatusMessage.textContent = error instanceof Error ? error.message : "Couldn't trust the space.";
    });
  });

  gitAdvancedToggle.addEventListener("click", () => {
    gitAdvanced.hidden = !gitAdvanced.hidden;
    gitAdvancedToggle.setAttribute("aria-expanded", String(!gitAdvanced.hidden));
  });

  const gitActions = createGitActions({
    flushPendingSave: deps.flushPendingSave,
    setBusy: setGitBusy,
    isBusy: () => gitBusy,
    reloadPaths: deps.reloadPaths,
    dropTabsForGonePaths: deps.dropTabsForGonePaths,
    refreshTree: deps.refreshTree,
    onStatus: (status) => gitStatusStore.update(status),
    onError: (message) => {
      gitStatusMessage.hidden = false;
      gitStatusMessage.textContent = message;
    },
    clearError: () => {
      gitStatusMessage.hidden = true;
    },
  });

  gitSyncButton.addEventListener("click", () => {
    void gitActions.run(postGitSync, "Sync failed.");
  });

  gitCommitButton.addEventListener("click", () => {
    const message = gitCommitMessage.value.trim();
    if (!message) return;
    void gitActions.run(async () => {
      const result = await postGitCommit(message);
      gitCommitMessage.value = "";
      return result;
    }, "Commit failed.");
  });

  gitPullButton.addEventListener("click", () => {
    void gitActions.run(postGitPull, "Pull failed.");
  });

  gitPushButton.addEventListener("click", () => {
    void gitActions.run(postGitPush, "Push failed.");
  });
}
