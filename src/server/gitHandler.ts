import { existsSync } from "node:fs";
import path from "node:path";
import { type SimpleGit, simpleGit } from "simple-git";
import { loadGlobalConfig, spaceTrust } from "../config/loadConfig.ts";
import type { GitFileEntry, GitStatus } from "../protocol/api.ts";

export class UntrustedSpaceError extends Error {
  constructor() {
    super("Git is off in this space until you trust it.");
  }
}

// Every git command in this module starts here. A repository's own config can
// name programs git runs — core.fsmonitor on `status`, uploadpack and
// sshCommand on `fetch` — so a space that arrived with its `.git` (a zip, a
// synced folder) would run them the moment it opened. A command added below
// that calls simpleGit directly reopens that.
function trustedGit(spaceRoot: string): SimpleGit {
  if (spaceTrust(loadGlobalConfig(), spaceRoot) !== true) throw new UntrustedSpaceError();
  return simpleGit(spaceRoot);
}

// Where git would find its repository from the space, by looking for `.git`
// rather than asking git, since no git command runs before trust — `rev-parse`
// included. Upward, as git searches: a parent folder's repository serves the
// space too, and is the one to name when asking.
function findRepoRoot(spaceRoot: string): string | undefined {
  for (let dir = path.resolve(spaceRoot); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** `fetch: false` reads only the working tree and the refs already fetched:
 * what a recount after a local write needs, without a network round trip. */
export async function getGitStatus(spaceRoot: string, { fetch = true }: { fetch?: boolean } = {}): Promise<GitStatus> {
  const repoRoot = findRepoRoot(spaceRoot);
  if (!repoRoot) return { isRepo: false };

  const trust = spaceTrust(loadGlobalConfig(), spaceRoot);
  if (trust !== true) {
    return {
      isRepo: true,
      restricted: true,
      trust: trust === false ? "declined" : "undecided",
      parentRepo: repoRoot === path.resolve(spaceRoot) ? undefined : repoRoot,
    };
  }

  const git = trustedGit(spaceRoot);
  if (!(await git.checkIsRepo())) return { isRepo: false };

  // `git.status()` alone reports ahead/behind against the last-fetched state
  // of the remote-tracking branch, not its current state — so without an
  // explicit fetch first, "behind" silently stays stale until the user
  // happens to pull. Best-effort: no remote configured (or offline) should
  // still return accurate local status rather than fail the whole request.
  if (fetch) {
    try {
      await git.fetch();
    } catch {
      // no remote, or unreachable — fall through with whatever local refs know
    }
  }

  const status = await git.status();
  return {
    isRepo: true,
    branch: status.current,
    ahead: status.ahead,
    behind: status.behind,
    files: status.files.map((file) => ({
      path: file.path,
      statusCode: `${file.index}${file.working_dir}`,
    })),
  };
}

export async function commitAll(spaceRoot: string, message: string): Promise<void> {
  const git = trustedGit(spaceRoot);
  await git.add(".");
  await git.commit(message);
}

/** What a pull rewrote on disk. A client holding editor buffers over these
 * files has to re-read them or it will write its now-stale copy back over
 * what was just pulled — so the paths are reported rather than discarded,
 * and the caller reloads exactly these instead of everything it has open. */
export interface WorkingTreeChanges {
  changedPaths: string[];
  deletedPaths: string[];
}

// A pull of branches that have both moved stops until git is told how to
// reconcile them, and a default install never is. Unless the writer's own
// git says, the pull merges: git's classic answer, and a conflicted merge can
// be finished or aborted where a stopped rebase strands the repository.
async function pullOptions(git: SimpleGit): Promise<string[]> {
  const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
  for (const key of ["pull.rebase", "pull.ff", `branch.${branch}.rebase`]) {
    if ((await git.getConfig(key)).value !== null) return [];
  }
  return ["--no-rebase"];
}

export async function gitPull(spaceRoot: string): Promise<WorkingTreeChanges> {
  const git = trustedGit(spaceRoot);
  const result = await git.pull(await pullOptions(git));
  // `files` is everything the pull touched, deletions included; the two are
  // split here because a deleted path can't be re-read, only closed.
  const deletedPaths = result.deleted ?? [];
  const deleted = new Set(deletedPaths);
  return {
    changedPaths: (result.files ?? []).filter((file) => !deleted.has(file)),
    deletedPaths,
  };
}

export async function gitPush(spaceRoot: string): Promise<void> {
  await trustedGit(spaceRoot).push();
}

// First char of a two-char status code is the index status, second is the
// working-tree status (see GitFileEntry). "??" is the one exception, used
// for untracked files rather than a per-column code.
function describeChange(statusCode: string): "Add" | "Delete" | "Rename" | "Update" {
  if (statusCode === "??") return "Add";
  const [indexStatus, workingDirStatus] = statusCode;
  const code = indexStatus !== " " ? indexStatus : workingDirStatus;
  switch (code) {
    case "A":
      return "Add";
    case "D":
      return "Delete";
    case "R":
      return "Rename";
    default:
      return "Update";
  }
}

/** Heuristic (non-LLM) commit message, e.g. "Update notes/todo.md" or "Add 2 files, update 1 file". */
export function generateCommitMessage(files: GitFileEntry[]): string {
  if (files.length === 0) return "No changes";
  if (files.length === 1) return `${describeChange(files[0].statusCode)} ${files[0].path}`;

  const counts = new Map<string, number>();
  for (const file of files) {
    const verb = describeChange(file.statusCode);
    counts.set(verb, (counts.get(verb) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([verb, count], i) => {
      const label = i === 0 ? verb : verb.toLowerCase();
      return `${label} ${count} file${count === 1 ? "" : "s"}`;
    })
    .join(", ");
}

/** Commit-all (if dirty) → pull → push, in one step, for the primary "Sync" action. */
export async function syncAll(spaceRoot: string): Promise<WorkingTreeChanges & { status: GitStatus }> {
  const status = await getGitStatus(spaceRoot);
  if (!status.isRepo) return { status, changedPaths: [], deletedPaths: [] };
  if (status.restricted) throw new UntrustedSpaceError();

  if (status.files.length > 0) {
    await commitAll(spaceRoot, generateCommitMessage(status.files));
  }

  const pulled = await gitPull(spaceRoot);
  await gitPush(spaceRoot);

  return { ...pulled, status: await getGitStatus(spaceRoot) };
}
