import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PublisherConnection } from "../../src/protocol/publisher.ts";
import { runReadSiteSettings, runSaveSiteSettings } from "../../src/server/siteSettingsHandler.ts";

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

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// A publisher whose schema request answers `schemaStatus`, whose site
// settings always answer, and which refuses a save naming `rejected`.
async function publisher(
  id: string,
  schemaStatus: number,
  field: string,
  rejected?: string,
): Promise<PublisherConnection> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/openapi.json") {
      response.writeHead(schemaStatus, { etag: `"${id}"` });
      response.end(schemaStatus === 200 ? JSON.stringify(schemaWith(field)) : "{}");
      return;
    }
    if (request.method === "PATCH" && rejected) {
      response.writeHead(400);
      response.end(JSON.stringify({ error: { code: "malformed_request", message: "Not valid.", field: rejected } }));
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({ [field]: null }));
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
  // The service points from the request body; the form's controls are
  // keyed from inside its `settings` member.
  it("names a refused setting by the pointer its control is keyed by", async () => {
    const dir = await siteFolder();
    const refusing = await publisher("refusing", 200, "ga_id", "/settings/ga_id");
    expect(await runSaveSiteSettings(dir, refusing, { "/ga_id": "nope" })).toMatchObject({
      ok: false,
      message: "Not valid.",
      field: "/ga_id",
    });

    const outside = await publisher("outside", 200, "ga_id", "/name");
    const saved = await runSaveSiteSettings(dir, outside, { "/ga_id": "nope" });
    expect(saved).toMatchObject({ ok: false, message: "Not valid." });
    expect((saved as { field?: string }).field).toBeUndefined();
  });
});
