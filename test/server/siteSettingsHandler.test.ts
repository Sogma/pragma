import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublisherConnection } from "../../src/protocol/publisher.ts";
import type { PublisherResolution } from "../../src/server/publishers.ts";
import { runReadSiteSettings, runSaveSiteSettings } from "../../src/server/siteSettingsHandler.ts";
import { readSiteFile } from "../../src/server/sites.ts";

// Two stand-ins for publishers, built here so the test can never reach a
// real endpoint configured on the machine running it.

const schemaWith = (field: string) => ({
  components: {
    schemas: {
      SiteSettings: { type: "object", properties: { [field]: { type: ["string", "null"], title: field } } },
    },
  },
});

const servers: Server[] = [];
const dirs: string[] = [];

// Every PATCH body a stub received, in order.
const patches: unknown[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  patches.splice(0);
});

async function bodyOf(request: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

// A publisher whose schema request answers `schemaStatus`, whose site
// settings always answer, and which refuses a save naming `rejected`. With
// `siteName` its site list holds the test's site under that name, and a
// rename is stored trimmed, as Sogma stores one.
async function publisher(
  id: string,
  schemaStatus: number,
  field: string,
  rejected?: string,
  siteName?: string,
): Promise<PublisherConnection> {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/openapi.json") {
      response.writeHead(schemaStatus, { etag: `"${id}"` });
      response.end(schemaStatus === 200 ? JSON.stringify(schemaWith(field)) : "{}");
      return;
    }
    const sent = request.method === "PATCH" ? (JSON.parse(await bodyOf(request)) as { name?: string }) : {};
    if (request.method === "PATCH") patches.push(sent);
    if (request.method === "PATCH" && rejected) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { code: "malformed_request", message: "Not valid.", field: rejected } }));
      return;
    }
    if (url.pathname === "/sites" && siteName !== undefined) {
      response.writeHead(200);
      response.end(JSON.stringify({ sites: [{ id: "site-1", name: siteName }] }));
      return;
    }
    response.writeHead(200);
    response.end(
      JSON.stringify(sent.name === undefined ? { [field]: null } : { id: "site-1", name: sent.name.trim() }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { id, label: id, kind: "sogma", baseURL: `http://127.0.0.1:${port}`, apiKey: "key" };
}

async function siteFolder(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pragma-site-settings-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "_site.json"), JSON.stringify({ id: "site-1", slug: "site", name: "Site" }));
  return dir;
}

describe("runReadSiteSettings", () => {
  it("never shows one publisher's schema for another whose schema couldn't be read", async () => {
    const dir = await siteFolder();
    const first = await publisher("first", 200, "first_field");
    const second = await publisher("second", 500, "second_field");

    const read = await runReadSiteSettings(dir, first);
    expect(read.ok && read.fields.map((field) => field.label)).toEqual(["first_field"]);

    const failed = await runReadSiteSettings(dir, second);
    expect(failed.ok).toBe(false);
  });
});

describe("runSaveSiteSettings", () => {
  const found = (connection: PublisherConnection) => async (): Promise<PublisherResolution> => ({
    ok: true,
    publisher: connection,
  });
  const unused = vi.fn(async (): Promise<PublisherResolution> => {
    throw new Error("the publisher was resolved");
  });

  it("sends the name and the edited settings in one request, then writes _site.json", async () => {
    const dir = await siteFolder();
    const changes = { edits: { "/ga_id": "G-NEW" }, name: "  Field notes ", assetsFolder: "/media/" };
    const saved = await runSaveSiteSettings(dir, found(await publisher("saving", 200, "ga_id")), changes);

    expect(saved).toEqual({ ok: true, siteName: "Field notes", assetsFolder: "media" });
    expect(patches).toEqual([{ name: "  Field notes ", settings: { ga_id: "G-NEW" } }]);
    expect(readSiteFile(dir)).toMatchObject({ name: "Field notes", assetsFolder: "media" });
  });

  // The service points from the request body; the dialog keys a setting
  // from inside its `settings` member and the name by its own field.
  it("names a refused control the way the dialog keys it, and writes nothing", async () => {
    const dir = await siteFolder();
    const changes = { edits: { "/ga_id": "nope" }, name: "New", assetsFolder: "media" };
    const refusals = [
      ["/settings/ga_id", "/ga_id"],
      ["/name", "name"],
      ["/publish_status", undefined],
    ] as const;
    for (const [rejected, field] of refusals) {
      const refusing = found(await publisher(`refusing ${rejected}`, 200, "ga_id", rejected));
      const saved = await runSaveSiteSettings(dir, refusing, changes);
      expect(saved).toMatchObject({ ok: false, message: "Not valid." });
      expect((saved as { field?: string }).field).toBe(field);
    }
    expect(readSiteFile(dir)).toEqual({ id: "site-1", slug: "site", name: "Site", primaryDomain: null });
  });

  it("refuses an assets folder outside the site before anything is sent", async () => {
    const dir = await siteFolder();
    const saved = await runSaveSiteSettings(dir, unused, { edits: { "/ga_id": "x" }, assetsFolder: "../up" });

    expect(saved).toMatchObject({ ok: false, field: "assetsFolder", status: 400 });
    expect(unused).not.toHaveBeenCalled();
    expect(patches).toEqual([]);
  });

  it("saves an assets folder alone without the publisher", async () => {
    const dir = await siteFolder();
    const saved = await runSaveSiteSettings(dir, unused, { edits: {}, assetsFolder: "media" });

    expect(saved).toEqual({ ok: true, siteName: "Site", assetsFolder: "media" });
    expect(unused).not.toHaveBeenCalled();
    expect(readSiteFile(dir)?.assetsFolder).toBe("media");
  });

  it("asks for a publisher only when something has to be sent to one", async () => {
    const dir = await siteFolder();
    const missing = async (): Promise<PublisherResolution> => ({
      ok: false,
      message: "Set up a publisher first.",
      need: { kind: "publisher" },
    });

    expect(await runSaveSiteSettings(dir, missing, { edits: {}, name: "New" })).toMatchObject({
      ok: false,
      message: "Set up a publisher first.",
      need: { kind: "publisher" },
    });
    expect(readSiteFile(dir)?.name).toBe("Site");
  });
});

describe("the site's name", () => {
  it("is read from the publisher, putting _site.json's copy right", async () => {
    const dir = await siteFolder();
    const read = await runReadSiteSettings(dir, await publisher("renamed", 200, "ga_id", undefined, "Renamed"));

    expect(read).toMatchObject({ ok: true, siteName: "Renamed", siteNameUpdated: true });
    expect(readSiteFile(dir)?.name).toBe("Renamed");
  });

  it("falls back to _site.json's copy when the publisher's can't be read", async () => {
    const dir = await siteFolder();
    const read = await runReadSiteSettings(dir, await publisher("unlisted", 200, "ga_id"));

    expect(read).toMatchObject({ ok: true, siteName: "Site" });
    expect(read.ok && read.siteNameUpdated).toBeFalsy();
  });
});
