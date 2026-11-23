import { mkdir } from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findSpaceId,
  type PragmaGlobalConfig,
  registerSpace,
  relocateSpace,
  rememberKnownSpace,
  rememberSpace,
  resolveOpenableSpace,
  spaceLabel,
} from "../../src/config/loadConfig.ts";
import { tempDir } from "../support/isolation.ts";

// Narrowing helper: every assertion below is about a space that *is*
// registered, so an absent id is a test failure rather than a case to handle.
function idFor(config: PragmaGlobalConfig, spacePath: string): string {
  const id = findSpaceId(config, spacePath);
  if (!id) throw new Error(`no registry entry for ${spacePath}`);
  return id;
}

describe("space registry", () => {
  it("registers an unknown space and fronts it in the recents", () => {
    const config = rememberSpace({}, "/spaces/a");

    const id = idFor(config, "/spaces/a");
    expect(id).toMatch(/^spc_[0-9a-f]{8}$/);
    expect(config.spaces?.[id]).toEqual({ path: "/spaces/a" });
    expect(config.recentSpaceIds).toEqual([id]);
    expect(config.spacePath).toBe("/spaces/a");
  });

  it("reuses the existing id when the same space is opened again", () => {
    const first = rememberSpace({}, "/spaces/a");
    const id = idFor(first, "/spaces/a");

    const second = rememberSpace(rememberSpace(first, "/spaces/b"), "/spaces/a");

    expect(findSpaceId(second, "/spaces/a")).toBe(id);
    expect(Object.keys(second.spaces ?? {})).toHaveLength(2);
    expect(second.recentSpaceIds?.[0]).toBe(id);
  });

  it("keeps a label across reopening — the id is the key, the label is display", () => {
    let config = rememberSpace({}, "/spaces/a");
    const id = idFor(config, "/spaces/a");
    config = { ...config, spaces: { ...config.spaces, [id]: { path: "/spaces/a", label: "Main" } } };

    config = rememberSpace(config, "/spaces/a");

    expect(config.spaces?.[id]).toEqual({ path: "/spaces/a", label: "Main" });
    expect(spaceLabel({ path: "/spaces/a", label: config.spaces?.[id]?.label })).toBe("Main");
  });

  it("falls back to the folder name when no label is set", () => {
    expect(spaceLabel({ path: "/spaces/my notes" })).toBe("my notes");
    expect(spaceLabel({ path: "/spaces/a", label: "" })).toBe("a");
  });

  // The registry is permanent; only the recents list is capped. A space that
  // ages off recents keeps its id — and therefore its grants — which is the
  // whole reason these are two structures rather than one.
  it("caps the recents list without ever dropping a registry entry", () => {
    let config: PragmaGlobalConfig = {};
    for (let index = 0; index < 14; index++) config = rememberSpace(config, `/spaces/${index}`);

    expect(config.recentSpaceIds).toHaveLength(10);
    expect(Object.keys(config.spaces ?? {})).toHaveLength(14);
    expect(findSpaceId(config, "/spaces/0")).toBeDefined();
    expect(config.recentSpaceIds).not.toContain(findSpaceId(config, "/spaces/0"));
  });

  // Vanishingly unlikely, but the consequence is not proportional to the
  // odds: a reused id would overwrite a registry entry and hand the new space
  // that entry's approvals.
  it("never mints an id that is already taken", () => {
    let config = rememberSpace({}, "/spaces/a");
    const taken = idFor(config, "/spaces/a");

    for (let index = 0; index < 30; index++) config = rememberSpace(config, `/spaces/${index}`);

    const ids = Object.keys(config.spaces ?? {});
    expect(new Set(ids).size).toBe(ids.length);
    expect(config.spaces?.[taken]?.path).toBe("/spaces/a");
  });

  // The lookup-only half, for a target that may not assign identity. The
  // whole point is the negative case: a path it doesn't know must come back
  // as nothing, never as a freshly minted entry.
  it("opens a registered space without minting, and refuses an unregistered one", () => {
    const config = rememberSpace({}, "/spaces/a");
    const id = findSpaceId(config, "/spaces/a");

    const reopened = rememberKnownSpace(config, "/spaces/a");
    expect(reopened && findSpaceId(reopened, "/spaces/a")).toBe(id);
    expect(reopened?.spacePath).toBe("/spaces/a");

    expect(rememberKnownSpace(config, "/spaces/b")).toBeUndefined();
    // And it left the registry alone rather than half-registering it.
    expect(Object.keys(config.spaces ?? {})).toEqual([id]);
  });

  // The failure this exists to prevent, stated directly: a moved space is a
  // *new* space to a path lookup, so a target that mints on a miss detaches
  // it from the approvals keyed to its old id.
  it("treats a moved space as unknown rather than adopting it", () => {
    const config = rememberSpace({}, "/spaces/a");
    expect(rememberKnownSpace(config, "/mnt/moved/a")).toBeUndefined();

    // Minting is what the other half does, and it appends rather than
    // repointing — which is why the two are separate functions.
    const minted = rememberSpace(config, "/mnt/moved/a");
    expect(Object.keys(minted.spaces ?? {})).toHaveLength(2);
  });

  it("does not recognise a moved folder — relocating the entry is the only way back", () => {
    const config = rememberSpace({}, "/spaces/a");

    expect(findSpaceId(config, "/spaces/moved")).toBeUndefined();

    // What Manage Spaces' Locate does: rewrite the path, keep the id.
    const id = idFor(config, "/spaces/a");
    const relocated = { ...config, spaces: { ...config.spaces, [id]: { path: "/spaces/moved" } } };
    expect(findSpaceId(relocated, "/spaces/moved")).toBe(id);
  });
});

// The command-line side of the registry: adding a space and moving one.
describe("registerSpace", () => {
  // Adding a space from the command line must not change what a running host
  // serves or opens next.
  it("registers a space without opening it", () => {
    const config = rememberSpace({}, "/spaces/a");

    const added = registerSpace(config, "/spaces/b");

    expect(findSpaceId(added, "/spaces/b")).toMatch(/^spc_[0-9a-f]{8}$/);
    expect(added.spacePath).toBe("/spaces/a");
    expect(added.recentSpaceIds).toEqual(config.recentSpaceIds);
  });

  it("leaves a registered space's entry as it is", () => {
    const config = rememberSpace({}, "/spaces/a");

    expect(registerSpace(config, "/spaces/a")).toBe(config);
  });
});

describe("relocateSpace", () => {
  function moved(result: ReturnType<typeof relocateSpace>): PragmaGlobalConfig {
    if ("refused" in result) throw new Error(`refused: ${result.refused}`);
    return result.config;
  }

  it("points the entry at the new folder, keeping its id, label and trust", () => {
    const config: PragmaGlobalConfig = { spaces: { main: { path: "/spaces/a", label: "Main", trusted: true } } };

    const relocated = moved(relocateSpace(config, "main", "/mnt/moved/a"));

    expect(relocated.spaces).toEqual({ main: { path: "/mnt/moved/a", label: "Main", trusted: true } });
    expect(findSpaceId(relocated, "/mnt/moved/a")).toBe("main");
  });

  // A host that serves only its configured space has no other way to find it.
  it("moves the configured space path along when it named the old folder", () => {
    const config: PragmaGlobalConfig = {
      spacePath: "/spaces/a",
      spaces: { main: { path: "/spaces/a" }, notes: { path: "/spaces/notes" } },
    };

    expect(moved(relocateSpace(config, "main", "/mnt/a")).spacePath).toBe("/mnt/a");
    expect(moved(relocateSpace(config, "notes", "/mnt/notes")).spacePath).toBe("/spaces/a");
  });

  it("refuses an id the registry doesn't have", () => {
    expect(relocateSpace({ spaces: { main: { path: "/spaces/a" } } }, "nope", "/mnt/a")).toEqual({
      refused: "Not a known space",
    });
  });

  // Two entries on one folder would leave "which space is this path?" with
  // two answers.
  it("refuses a folder another space already has", () => {
    const config: PragmaGlobalConfig = { spaces: { main: { path: "/spaces/a" }, notes: { path: "/spaces/notes" } } };

    expect(relocateSpace(config, "main", "/spaces/notes")).toEqual({
      refused: "That folder is already registered as another space",
    });
  });
});

// A configured space can stop existing without anyone doing anything wrong,
// so which one a target opens next is behaviour worth pinning down.
describe("resolveOpenableSpace", () => {
  let dir: string;
  let alive: string;
  let alsoAlive: string;
  const dead = "/definitely/not/a/real/space";

  beforeEach(async () => {
    dir = tempDir("pragma-openable-");
    alive = path.join(dir, "alive");
    alsoAlive = path.join(dir, "also-alive");
    await mkdir(alive);
    await mkdir(alsoAlive);
  });

  it("prefers the configured space when its folder is still there", () => {
    const config = rememberSpace(rememberSpace({}, alsoAlive), alive);
    expect(resolveOpenableSpace(config)).toBe(alive);
  });

  it("falls through to the most recent registered space that still exists", () => {
    // `alive` opened first, then `dead` — so recents are [dead, alive] and
    // spacePath is the one that has since gone.
    const config = rememberSpace(rememberSpace({}, alive), dead);
    expect(config.spacePath).toBe(dead);
    expect(resolveOpenableSpace(config)).toBe(alive);
  });

  it("skips every dead entry rather than stopping at the first", () => {
    const config = rememberSpace(rememberSpace(rememberSpace({}, alive), "/gone/one"), "/gone/two");
    expect(resolveOpenableSpace(config)).toBe(alive);
  });

  it("finds a registered space that recents never mentioned", () => {
    const config = { ...rememberSpace({}, dead), spaces: { spc_orphan: { path: alive } }, recentSpaceIds: [] };
    expect(resolveOpenableSpace(config)).toBe(alive);
  });

  it("is undefined when nothing is registered, and when nothing registered exists", () => {
    expect(resolveOpenableSpace({})).toBeUndefined();
    expect(resolveOpenableSpace(rememberSpace({}, dead))).toBeUndefined();
  });

  it("does not mutate the config — resolving is not opening", () => {
    const config = rememberSpace(rememberSpace({}, alive), dead);
    resolveOpenableSpace(config);
    expect(config.spacePath).toBe(dead);
    expect(config.recentSpaceIds?.[0]).toBe(idFor(config, dead));
  });
});
