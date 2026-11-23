import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import {
  commitAll,
  getGitStatus,
  gitPull,
  gitPush,
  syncAll,
  UntrustedSpaceError,
} from "../../src/server/gitHandler.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

// A repository's own config naming programs git runs — the attack the trust
// gate exists for. Each payload leaves a marker file if git ever ran it.
let root: string;
// Git reads no one's own config here, or a contributor's `pull.rebase` would
// change what a pull does. simple-git drops GIT_CONFIG_GLOBAL from the
// environment it passes on, but keeps HOME.
const home = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

beforeEach(() => {
  isolateConfig();
  root = tempDir("pragma-git-");
  process.env.HOME = root;
  process.env.XDG_CONFIG_HOME = root;
});

afterEach(() => {
  for (const [key, value] of Object.entries(home)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
}

// A committed repository at `repoDir` whose config runs a marker-writing
// program on `status` (fsmonitor) and on `fetch` (a local remote's uploadpack).
function hostileRepo(repoDir: string): string {
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, "init", "-q");
  writeFileSync(path.join(repoDir, "a.md"), "hi\n");
  git(repoDir, "add", ".");
  git(repoDir, "commit", "-qm", "init");
  const marker = path.join(root, "PWNED");
  const remote = path.join(root, `${path.basename(repoDir)}-remote`);
  mkdirSync(remote);
  git(remote, "init", "-q");
  git(repoDir, "remote", "add", "origin", remote);
  git(repoDir, "config", "core.fsmonitor", `touch '${marker}'; false`);
  git(repoDir, "config", "remote.origin.uploadpack", `sh -c "touch '${marker}'"; git-upload-pack`);
  return marker;
}

function register(space: string, trusted?: boolean): void {
  const config = rememberSpace(loadGlobalConfig(), space);
  const id = findSpaceId(config, space) as string;
  saveGlobalConfig({ ...config, spaces: { ...config.spaces, [id]: { ...config.spaces?.[id], path: space, trusted } } });
}

describe("git trust gate", () => {
  it("runs no git in a space nobody has trusted, and says it was never asked", async () => {
    const space = path.join(root, "space");
    const marker = hostileRepo(space);
    register(space);

    expect(await getGitStatus(space)).toEqual({ isRepo: true, restricted: true, trust: "undecided" });
    expect(existsSync(marker)).toBe(false);
  });

  it("refuses every git action in an untrusted space before git runs", async () => {
    const space = path.join(root, "space");
    const marker = hostileRepo(space);
    register(space, false);

    await expect(commitAll(space, "x")).rejects.toBeInstanceOf(UntrustedSpaceError);
    await expect(gitPull(space)).rejects.toBeInstanceOf(UntrustedSpaceError);
    await expect(gitPush(space)).rejects.toBeInstanceOf(UntrustedSpaceError);
    await expect(syncAll(space)).rejects.toBeInstanceOf(UntrustedSpaceError);
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a declined space as declined, and an unregistered one as never asked", async () => {
    const declined = path.join(root, "declined");
    const loose = path.join(root, "loose");
    hostileRepo(declined);
    hostileRepo(loose);
    register(declined, false);

    expect(await getGitStatus(declined)).toMatchObject({ restricted: true, trust: "declined" });
    expect(await getGitStatus(loose)).toMatchObject({ restricted: true, trust: "undecided" });
  });

  it("finds a repository above the space without running git, and names it", async () => {
    const repo = path.join(root, "outer");
    const marker = hostileRepo(repo);
    const space = path.join(repo, "notes");
    mkdirSync(space);
    register(space);

    expect(await getGitStatus(space)).toEqual({ isRepo: true, restricted: true, trust: "undecided", parentRepo: repo });
    expect(existsSync(marker)).toBe(false);
  });

  it("reports a folder with no repository anywhere above it as not a repo", async () => {
    const space = path.join(root, "plain");
    mkdirSync(space);
    register(space, true);

    expect(await getGitStatus(space)).toEqual({ isRepo: false });
  });

  it("runs git once the space is trusted", async () => {
    const space = path.join(root, "space");
    mkdirSync(space);
    git(space, "init", "-q", "-b", "main");
    writeFileSync(path.join(space, "a.md"), "hi\n");
    register(space, true);

    expect(await getGitStatus(space)).toMatchObject({
      isRepo: true,
      branch: "main",
      files: [{ path: "a.md", statusCode: "??" }],
    });
  });

  it("reads against the refs already fetched when told not to fetch", async () => {
    const remote = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const space = path.join(root, "space");
    mkdirSync(space);
    git(space, "init", "-q", "-b", "main");
    writeFileSync(path.join(space, "a.md"), "hi\n");
    git(space, "add", ".");
    git(space, "commit", "-qm", "init");
    git(space, "remote", "add", "origin", remote);
    git(space, "push", "-q", "-u", "origin", "main");
    const elsewhere = path.join(root, "elsewhere");
    git(root, "clone", "-q", remote, elsewhere);
    writeFileSync(path.join(elsewhere, "b.md"), "there\n");
    git(elsewhere, "add", ".");
    git(elsewhere, "commit", "-qm", "from elsewhere");
    git(elsewhere, "push", "-q");
    register(space, true);

    expect(await getGitStatus(space, { fetch: false })).toMatchObject({ behind: 0 });
    expect(await getGitStatus(space)).toMatchObject({ behind: 1 });
  });

  it("commits, pulls and pushes a trusted space against its remote", async () => {
    const remote = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const space = path.join(root, "space");
    git(root, "clone", "-q", remote, space);
    git(space, "config", "user.name", "t");
    git(space, "config", "user.email", "t@t");
    git(space, "commit", "-q", "--allow-empty", "-m", "init");
    git(space, "push", "-q", "-u", "origin", "main");
    const elsewhere = path.join(root, "elsewhere");
    git(root, "clone", "-q", remote, elsewhere);
    writeFileSync(path.join(elsewhere, "b.md"), "there\n");
    git(elsewhere, "add", ".");
    git(elsewhere, "commit", "-qm", "from elsewhere");
    git(elsewhere, "push", "-q");
    register(space, true);

    expect(await gitPull(space)).toEqual({ changedPaths: ["b.md"], deletedPaths: [] });
    writeFileSync(path.join(space, "c.md"), "here\n");
    await commitAll(space, "Add c.md");
    await gitPush(space);

    git(elsewhere, "pull", "-q", "--no-rebase");
    expect(existsSync(path.join(elsewhere, "c.md"))).toBe(true);
    expect(await getGitStatus(space)).toMatchObject({ isRepo: true, ahead: 0, behind: 0, files: [] });
  });

  // A trusted space with a commit of its own while its remote gained another.
  function divergedSpace(): string {
    const remote = path.join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const space = path.join(root, "space");
    git(root, "clone", "-q", remote, space);
    git(space, "config", "user.name", "t");
    git(space, "config", "user.email", "t@t");
    git(space, "commit", "-q", "--allow-empty", "-m", "init");
    git(space, "push", "-q", "-u", "origin", "main");
    const elsewhere = path.join(root, "elsewhere");
    git(root, "clone", "-q", remote, elsewhere);
    writeFileSync(path.join(elsewhere, "b.md"), "there\n");
    git(elsewhere, "add", ".");
    git(elsewhere, "commit", "-qm", "from elsewhere");
    git(elsewhere, "push", "-q");
    writeFileSync(path.join(space, "c.md"), "here\n");
    git(space, "add", ".");
    git(space, "commit", "-qm", "from here");
    register(space, true);
    return space;
  }

  const merges = (space: string): string =>
    execFileSync("git", ["rev-list", "--merges", "--count", "HEAD"], { cwd: space, encoding: "utf8" }).trim();

  it("merges a pull whose branches both moved when git says nothing of how, then pushes", async () => {
    const space = divergedSpace();

    expect(await gitPull(space)).toEqual({ changedPaths: ["b.md"], deletedPaths: [] });
    expect(merges(space)).toBe("1");
    await gitPush(space);
    expect(await getGitStatus(space)).toMatchObject({ ahead: 0, behind: 0, files: [] });
  });

  it("reconciles as the space's own git says, rebasing for pull.rebase", async () => {
    const space = divergedSpace();
    git(space, "config", "pull.rebase", "true");

    await gitPull(space);
    expect(merges(space)).toBe("0");
    expect(existsSync(path.join(space, "b.md"))).toBe(true);
  });
});
