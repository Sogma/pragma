import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { credentialStore } from "../../src/config/credentials.ts";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// POST /api/space/site over real HTTP, against a stand-in for the publishing
// service that answers a create with whatever slug a test sets and records
// every delete, so a test can say what was rolled back and what never is.
describe("API contract — New Site", () => {
  let testServer: TestServer;
  let service: Server;
  let slug: string;
  let created = 0;
  const deleted: string[] = [];

  beforeAll(async () => {
    testServer = await startTestServer();
    service = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://service");
      if (req.method === "POST" && url.pathname === "/v1/sites") {
        created += 1;
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ste_new", slug, name: "Site", primary_domain: null }));
        return;
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/v1/sites/")) {
        deleted.push(url.pathname.slice("/v1/sites/".length));
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    const { port } = service.address() as AddressInfo;
    const baseURL = `http://127.0.0.1:${port}/v1`;
    saveGlobalConfig({ ...loadGlobalConfig(), publishers: [{ id: "stand-in", kind: "sogma", baseURL }] });
    await credentialStore().set(
      { kind: "publisher-keys", id: "stand-in" },
      { absent: true },
      { endpoint: baseURL, secrets: { key: "key" } },
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => service.close(() => resolve()));
    await testServer.close();
  });

  beforeEach(() => {
    deleted.length = 0;
  });

  function newSite(body: Record<string, unknown>): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/site`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentPath: "", ...body }),
    });
  }

  it("makes the site's folder from its slug", async () => {
    slug = "notes";
    const res = await newSite({ name: "Notes" });

    expect(await res.json()).toEqual({ path: "notes", siteId: "ste_new", siteSlug: "notes" });
    expect(existsSync(path.join(testServer.spaceRoot, "notes", "_site.json"))).toBe(true);
  });

  it("refuses a slug that isn't one folder name, and deletes the site it just made", async () => {
    slug = "a/../../pragma-new-site-escaped";
    const res = await newSite({ name: "Escape" });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toMatch(/^The publisher named the site/);
    expect(deleted).toEqual(["ste_new"]);
    expect(existsSync(path.join(path.dirname(testServer.spaceRoot), "pragma-new-site-escaped"))).toBe(false);
  });

  it("takes a slug that another entry's name folds to as taken", async () => {
    slug = "journal";
    await mkdir(path.join(testServer.spaceRoot, "Journal"));
    const res = await newSite({ name: "Journal" });

    expect(((await res.json()) as { message: string }).message).toBe('"journal" already exists here.');
    expect(deleted).toEqual(["ste_new"]);
  });

  it("refuses a hidden parent folder before the service is asked for a site", async () => {
    slug = "hooks";
    const before = created;
    const res = await newSite({ name: "Hooks", parentPath: ".git" });

    expect(res.status).toBe(403);
    expect(created).toBe(before);
    expect(existsSync(path.join(testServer.spaceRoot, ".git", "hooks"))).toBe(false);
  });

  it("writes no assets folder into a site under a hidden folder", async () => {
    await mkdir(path.join(testServer.spaceRoot, ".drafts", "site"), { recursive: true });
    const siteFile = path.join(testServer.spaceRoot, ".drafts", "site", "_site.json");
    await writeFile(siteFile, JSON.stringify({ id: "ste_hidden", slug: "site", name: "Site" }));
    const res = await fetch(`${testServer.baseUrl}/api/space/site/assets-folder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: ".drafts/site", assetsFolder: "images" }),
    });

    expect(res.status).toBe(403);
    expect(JSON.parse(await readFile(siteFile, "utf8"))).not.toHaveProperty("assetsFolder");
  });

  it("never deletes the site a retry names, whatever fails locally", async () => {
    await mkdir(path.join(testServer.spaceRoot, "taken"));
    const existingSite = { id: "ste_someone_else", slug: "taken", name: "Taken", primaryDomain: null };
    const res = await newSite({ existingSite });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ existingSite: { id: "ste_someone_else" } });
    expect(deleted).toEqual([]);
  });
});
