import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findSpaceId, loadGlobalConfig, rememberSpace, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import type { SpaceListResponse } from "../../src/protocol/api.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { isolateConfig, tempDir } from "../support/isolation.ts";

// Two registered spaces, the first served: what a service account holds once
// someone has added a second space, or what the desktop app's account holds
// when the service runs as it.
let served: string;
let other: string;

beforeEach(() => {
  isolateConfig();
  served = tempDir("pragma-registry-served-");
  other = tempDir("pragma-registry-other-");
  saveGlobalConfig(rememberSpace(rememberSpace(loadGlobalConfig(), other), served));
});

function routesFor(ownMachine: boolean) {
  const routes = spaceRoutes(createServedSpace(served), { ownMachine });
  const post = (route: string, body: unknown) =>
    routes().request(route, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const list = async () => (await (await routes().request("/api/space/list")).json()) as SpaceListResponse;
  const servedName = async () => ((await (await routes().request("/api/space/info")).json()) as { name: string }).name;
  return { post, list, servedName };
}

const idOf = (space: string) => findSpaceId(loadGlobalConfig(), space) as string;

describe("the space registry on a server for other devices", () => {
  it("lists only the space it serves, recents included", async () => {
    const { spaces, recent } = await routesFor(false).list();
    expect(spaces.map((space) => space.id)).toEqual([idOf(served)]);
    expect(recent.map((space) => space.id)).toEqual([idOf(served)]);
  });

  it("refuses to switch, even to a registered space", async () => {
    const { post, servedName } = routesFor(false);
    const res = await post("/api/space/switch", { path: other });
    expect(res.status).toBe(501);
    expect(await servedName()).toBe(path.basename(served));
  });

  it("renames, trusts, resets or forgets no other space", async () => {
    const { post } = routesFor(false);
    const id = idOf(other);
    for (const [route, body] of [
      ["/api/space/label", { id, label: "Seen" }],
      ["/api/space/trust", { id, trusted: true }],
      ["/api/space/grants/reset", { id }],
      ["/api/space/forget", { id }],
    ] as const) {
      const res = await post(route, body);
      expect([route, res.status, await res.text()]).toEqual([route, 400, "Not a known space"]);
    }
    expect(loadGlobalConfig().spaces?.[id]).toEqual({ path: other });
  });

  it("still renames and trusts the space it serves", async () => {
    const { post } = routesFor(false);
    const id = idOf(served);
    expect((await post("/api/space/label", { id, label: "Shared" })).status).toBe(204);
    expect((await post("/api/space/trust", { id, trusted: true })).status).toBe(204);
    expect(loadGlobalConfig().spaces?.[id]).toMatchObject({ label: "Shared", trusted: true });
  });
});

describe("the space registry on the host's own machine", () => {
  it("lists every registered space and switches to another", async () => {
    const { post, list, servedName } = routesFor(true);
    expect((await list()).spaces.map((space) => space.id).sort()).toEqual([idOf(served), idOf(other)].sort());
    expect((await post("/api/space/switch", { path: other })).status).toBe(204);
    expect(await servedName()).toBe(path.basename(other));
  });

  it("refuses a path that is not a registered space", async () => {
    const res = await routesFor(true).post("/api/space/switch", { path: "/etc" });
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Not a known space");
  });
});
