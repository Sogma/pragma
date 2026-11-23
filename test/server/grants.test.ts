import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, globalGrantsPath, loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import {
  grantCapability,
  grantedCapabilities,
  grantPath,
  isCapabilityGranted,
  isUnattendedGranted,
  remapGrantHash,
  revokeCapability,
  setUnattended,
  unattendedStanding,
} from "../../src/server/grants.ts";
import { isolateConfig, tempSpace } from "../support/isolation.ts";

// Grants are install-global, so these tests point PRAGMA_CONFIG_DIR at a
// temp directory — without it every case here would read and write the
// developer's own config and approvals.
let space: string;

beforeEach(() => {
  isolateConfig();
  space = tempSpace("pragma-grants-");
  // Every write prunes entries whose document is gone, so each subject below
  // needs a file behind it.
  for (const file of ["a.applet.html", "elsewhere/a.applet.html", "k.flow.html", "f.flow.html", "u.flow.html"]) {
    touch(space, file);
  }
});

function touch(root: string, file: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), "");
}

const applet = { path: "a.applet.html", contentHash: "h1" };
const toolkit = { path: "k.flow.html", contentHash: "k1" };
const flow = { path: "f.flow.html", contentHash: "f1" };

function stored(): Record<string, unknown> {
  const id = findSpaceId(loadGlobalConfig(), space);
  return JSON.parse(readFileSync(globalGrantsPath(), "utf8"))[id as string];
}

describe("grants", () => {
  it("starts empty and records a grant per document path in one file", async () => {
    expect(await isCapabilityGranted(space, applet, "generateText")).toBe(false);
    expect(await grantedCapabilities(space, applet)).toEqual([]);

    await grantCapability(space, applet, "readFile:a.md");
    await grantCapability(space, applet, "generateText");
    await grantCapability(space, toolkit, "generateText");
    await grantCapability(space, flow, "readFile:t.table.html");

    expect(await isCapabilityGranted(space, applet, "generateText")).toBe(true);
    expect((await grantedCapabilities(space, applet)).sort()).toEqual(["generateText", "readFile:a.md"]);
    expect(await grantedCapabilities(space, toolkit)).toEqual(["generateText"]);
    expect(await grantedCapabilities(space, flow)).toEqual(["readFile:t.table.html"]);
    expect(Object.keys(stored()).sort()).toEqual(["a.applet.html", "f.flow.html", "k.flow.html"]);
    expect(stored()["f.flow.html"]).toEqual({ contentHash: "f1", capabilities: { "readFile:t.table.html": true } });
  });

  it("an entry counts only at the hash it was recorded at", async () => {
    await grantCapability(space, applet, "generateText");
    const edited = { ...applet, contentHash: "h2" };
    expect(await isCapabilityGranted(space, edited, "generateText")).toBe(false);
    expect(await grantedCapabilities(space, edited)).toEqual([]);

    // A grant at the new hash starts over, and replaces the file's old entry.
    await grantCapability(space, edited, "readFile:a.md");
    expect(await grantedCapabilities(space, edited)).toEqual(["readFile:a.md"]);
    expect(await isCapabilityGranted(space, applet, "generateText")).toBe(false);
    expect(stored()["a.applet.html"]).toEqual({ contentHash: "h2", capabilities: { "readFile:a.md": true } });
  });

  // A document-relative readFile names a different file from a different
  // folder, so even an identical copy has approved nothing yet.
  it("prompts a copy at another path fresh, identical or not", async () => {
    const copy = { ...applet, path: "elsewhere/a.applet.html" };
    await grantCapability(space, applet, "readFile:a.md");
    expect(await grantedCapabilities(space, copy)).toEqual([]);

    await grantCapability(space, copy, "generateText");
    expect(await grantedCapabilities(space, applet)).toEqual(["readFile:a.md"]);
    expect(await grantedCapabilities(space, copy)).toEqual(["generateText"]);
  });

  it("revoke drops one capability, keeps the hash, and ignores a stale hash", async () => {
    await grantCapability(space, applet, "generateText");
    await grantCapability(space, applet, "readFile:a.md");

    await revokeCapability(space, { ...applet, contentHash: "other" }, "generateText");
    expect((await grantedCapabilities(space, applet)).sort()).toEqual(["generateText", "readFile:a.md"]);

    await revokeCapability(space, applet, "generateText");
    expect(await grantedCapabilities(space, applet)).toEqual(["readFile:a.md"]);
    expect(stored()["a.applet.html"]).toHaveProperty("contentHash", "h1");
  });

  it("remap carries an entry to a new hash, only from the hash it is at", async () => {
    await grantCapability(space, toolkit, "generateText");
    expect(await remapGrantHash(space, toolkit.path, "wrong", "k2")).toBe(false);
    expect(await remapGrantHash(space, "other.flow.html", "k1", "k2")).toBe(false);
    expect(await remapGrantHash(space, toolkit.path, "k1", "k2")).toBe(true);
    expect(await isCapabilityGranted(space, { ...toolkit, contentHash: "k2" }, "generateText")).toBe(true);
    expect(await isCapabilityGranted(space, toolkit, "generateText")).toBe(false);
  });

  // The space is scoped by registry id rather than by its folder: approvals
  // survive that space being moved.
  it("scopes grants to one space", async () => {
    const other = tempSpace("pragma-grants-other-");

    await grantCapability(space, applet, "generateText");

    expect(await isCapabilityGranted(space, applet, "generateText")).toBe(true);
    expect(await isCapabilityGranted(other, applet, "generateText")).toBe(false);
  });

  it("keeps grants when a space's registry entry is relocated", async () => {
    await grantCapability(space, applet, "generateText");

    // What Manage Spaces' Locate does: same id, new path.
    const config = loadGlobalConfig();
    const id = findSpaceId(config, space) as string;
    const moved = path.join(tmpdir(), "pragma-grants-moved");
    saveGlobalConfig({ ...config, spaces: { ...config.spaces, [id]: { path: moved } } });

    expect(await isCapabilityGranted(moved, applet, "generateText")).toBe(true);
    expect(await isCapabilityGranted(space, applet, "generateText")).toBe(false);
  });

  // A served space is always registered. If that invariant breaks, reads must
  // fail closed and writes must be loud rather than discarding an approval a
  // human just clicked.
  it("reads empty and refuses to write for an unregistered space", async () => {
    const stranger = path.join(tmpdir(), "pragma-grants-unregistered");

    expect(await isCapabilityGranted(stranger, applet, "generateText")).toBe(false);
    expect(await grantedCapabilities(stranger, applet)).toEqual([]);
    await expect(grantCapability(stranger, applet, "generateText")).rejects.toThrow(/not a registered space/);
  });

  it("treats a missing grants file as nothing granted", async () => {
    expect(await grantedCapabilities(space, toolkit)).toEqual([]);
    expect(existsSync(globalGrantsPath())).toBe(false);

    await grantCapability(space, toolkit, "generateText");
    expect(await grantedCapabilities(space, toolkit)).toEqual(["generateText"]);
  });
});

describe("pruning", () => {
  it("drops a deleted document's entry on the next write to its space", async () => {
    await grantCapability(space, applet, "generateText");
    await grantCapability(space, toolkit, "generateText");
    rmSync(path.join(space, "a.applet.html"));
    expect(Object.keys(stored()).sort()).toEqual(["a.applet.html", "k.flow.html"]);

    await grantCapability(space, flow, "generateText");
    expect(Object.keys(stored()).sort()).toEqual(["f.flow.html", "k.flow.html"]);
  });

  // The other space may be on a drive that isn't mounted.
  it("leaves every other space's entries alone", async () => {
    const other = tempSpace("pragma-grants-other-");
    touch(other, "a.applet.html");
    await grantCapability(other, applet, "generateText");

    await grantCapability(space, applet, "generateText");
    expect(await isCapabilityGranted(other, applet, "generateText")).toBe(true);
  });

  it("prunes nothing while the space's own folder is missing", async () => {
    await grantCapability(space, applet, "generateText");

    await grantCapability(space, toolkit, "generateText");
    expect(Object.keys(stored()).sort()).toEqual(["a.applet.html", "k.flow.html"]);
  });
});

describe("grantPath", () => {
  it("is space-relative with / separators and dot segments resolved", async () => {
    expect(grantPath(space, path.join(space, "projects", "Scene Beats (v2).flow.html"))).toBe(
      "projects/Scene Beats (v2).flow.html",
    );
    expect(grantPath(space, path.resolve(space, "a/../b/./c.flow.html"))).toBe("b/c.flow.html");
  });

  // Folding would let two different files on a case-sensitive filesystem
  // share one key, and so each other's approvals.
  it("folds neither case nor Unicode", async () => {
    expect(grantPath(space, path.join(space, "Café.applet.html"))).toBe("Café.applet.html");
    expect(grantPath(space, path.join(space, "Cafe\u0301.applet.html"))).toBe("Cafe\u0301.applet.html");
  });
});

describe("the unattended grant", () => {
  const pinned = { path: "u.flow.html", contentHash: "d1" };

  it("is off until set, and set or withdrawn on its own", async () => {
    expect(await isUnattendedGranted(space, pinned)).toBe(false);
    await setUnattended(space, pinned, true);
    expect(await isUnattendedGranted(space, pinned)).toBe(true);
    await setUnattended(space, pinned, false);
    expect(await isUnattendedGranted(space, pinned)).toBe(false);
  });

  // A sibling of the capability map, never a key in it.
  it("sits beside the capabilities and survives grant, revoke and remap", async () => {
    await setUnattended(space, pinned, true);
    await grantCapability(space, pinned, "generateText");
    await revokeCapability(space, pinned, "generateText");
    expect(stored()["u.flow.html"]).toEqual({ contentHash: "d1", capabilities: {}, unattended: true });

    await remapGrantHash(space, pinned.path, "d1", "d2");
    expect(await isUnattendedGranted(space, { ...pinned, contentHash: "d2" })).toBe(true);
  });

  // Changing what a flow does withdraws it with everything else.
  it("counts only at the hash it was granted at", async () => {
    await setUnattended(space, pinned, true);
    expect(await isUnattendedGranted(space, { ...pinned, contentHash: "d9" })).toBe(false);
  });

  it("granted at a new hash starts the record over, capabilities included", async () => {
    await grantCapability(space, pinned, "generateText");
    await setUnattended(space, { ...pinned, contentHash: "d9" }, true);
    expect(await grantedCapabilities(space, { ...pinned, contentHash: "d9" })).toEqual([]);
    expect(await isUnattendedGranted(space, { ...pinned, contentHash: "d9" })).toBe(true);
  });

  it("given until a day, holds through that day's end and names it after", async () => {
    await setUnattended(space, pinned, true, "2026-11-18");
    expect(stored()["u.flow.html"]).toEqual({ contentHash: "d1", capabilities: {}, unattended: "2026-11-18" });
    expect(await isUnattendedGranted(space, pinned, new Date(2026, 10, 18, 23, 59))).toBe(true);
    expect(await unattendedStanding(space, pinned, new Date(2026, 10, 19))).toEqual({
      allowed: false,
      until: "2026-11-18",
    });
  });

  it("keeps its last day across a remap, and loses it when withdrawn", async () => {
    await setUnattended(space, pinned, true, "2026-11-18");
    await remapGrantHash(space, pinned.path, "d1", "d2");
    const moved = { ...pinned, contentHash: "d2" };
    expect(await unattendedStanding(space, moved, new Date(2026, 10, 1))).toEqual({
      allowed: true,
      until: "2026-11-18",
    });

    await setUnattended(space, moved, false);
    expect(await unattendedStanding(space, moved, new Date(2026, 10, 1))).toEqual({ allowed: false });
  });

  // A hand edit must not turn a typo into a leave until revoked.
  it("holds nothing when its last day names no real day", async () => {
    await setUnattended(space, pinned, true, "2026-02-30");
    expect(await unattendedStanding(space, pinned, new Date(2026, 0, 1))).toEqual({ allowed: false });
  });
});

// A grants file that exists but will not parse must not be overwritten by the
// next approval: the write path reads-modifies-writes the whole file, so
// building on an empty read would drop every other space's approvals.
describe("an unreadable grants.json", () => {
  it("refuses a grant rather than writing over what it could not read", async () => {
    const grantsPath = globalGrantsPath();
    writeFileSync(grantsPath, '{ "other_space": { "applet:x"');

    await expect(grantCapability(space, applet, "read")).rejects.toThrow();
    expect(readFileSync(grantsPath, "utf8")).toBe('{ "other_space": { "applet:x"');
  });

  it("still reports nothing granted to a check", async () => {
    writeFileSync(globalGrantsPath(), "{ broken");

    expect(await isCapabilityGranted(space, applet, "read")).toBe(false);
    expect(await grantedCapabilities(space, applet)).toEqual([]);
  });
});
