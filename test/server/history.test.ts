import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGlobalConfig, saveGlobalConfig } from "../../src/config/loadConfig.ts";
import {
  historyFiles,
  historyVersion,
  historyVersions,
  moveHistory,
  noteKnown,
  noticeRevision,
  writeDocument,
} from "../../src/server/history.ts";
import { spaceRoutes } from "../../src/server/routes.ts";
import { createServedSpace } from "../../src/server/servedSpace.ts";
import { revisionOf } from "../../src/server/spaceFiles.ts";
import { isolateConfig, tempDir, tempSpace } from "../support/isolation.ts";

const MINUTE = 60 * 1000;

// History is host state in the install-global config directory, so each
// test gets a throwaway one, and a space registered in it.
beforeEach(() => {
  isolateConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

async function space(files: Record<string, string> = {}): Promise<string> {
  const root = tempSpace("pragma-history-space-");
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

// The versions kept for a file, newest first, as their text and label.
async function kept(root: string, spacePath: string): Promise<{ text: string | undefined; source: string }[]> {
  const versions = await historyVersions(root, spacePath);
  return Promise.all(
    versions.map(async (version) => ({
      text: (await historyVersion(root, spacePath, version.id))?.content,
      source: version.source,
    })),
  );
}

describe("writeDocument", () => {
  it("keeps the text a save replaces, and writes the new one", async () => {
    const root = await space({ "note.md": "first" });
    await writeDocument(root, path.join(root, "note.md"), "second", { source: "edit" });
    expect(await readFile(path.join(root, "note.md"), "utf8")).toBe("second");
    expect(await kept(root, "note.md")).toEqual([{ text: "first", source: "edit" }]);
  });

  it("keeps one version per five minutes of your own saves", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = await space({ "note.md": "a" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "b", { source: "edit" });
    vi.advanceTimersByTime(4 * MINUTE);
    await writeDocument(root, file, "c", { source: "edit" });
    expect((await kept(root, "note.md")).map(({ text }) => text)).toEqual(["a"]);

    vi.advanceTimersByTime(2 * MINUTE);
    await writeDocument(root, file, "d", { source: "edit" });
    expect((await kept(root, "note.md")).map(({ text }) => text)).toEqual(["c", "a"]);
  });

  it("always keeps what another writer replaces, and your next save keeps what it wrote", async () => {
    const root = await space({ "note.md": "mine" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "mine, edited", { source: "edit" });
    await writeDocument(root, file, "the flow's", { source: "flow", detail: "flows/tidy.flow.html" });
    await writeDocument(root, file, "mine again", { source: "edit" });

    expect(await kept(root, "note.md")).toEqual([
      { text: "the flow's", source: "edit" },
      { text: "mine, edited", source: "flow" },
      { text: "mine", source: "edit" },
    ]);
    expect((await historyVersions(root, "note.md"))[1].detail).toBe("flows/tidy.flow.html");
  });

  it("never keeps a text twice in a row", async () => {
    const root = await space({ "note.md": "same" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "other", { source: "flow" });
    await writeFile(file, "same");
    await writeDocument(root, file, "other", { source: "flow" });
    expect((await kept(root, "note.md")).map(({ text }) => text)).toEqual(["same"]);
  });

  it("keeps nothing for a write that changes nothing, so the next change keeps its own label", async () => {
    const root = await space({ "note.md": "mine" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "mine", { source: "flow", detail: "flows/tidy.flow.html" });
    expect(await kept(root, "note.md")).toEqual([]);

    await writeDocument(root, file, "mine, edited", { source: "edit" });
    expect(await kept(root, "note.md")).toEqual([{ text: "mine", source: "edit" }]);
  });

  it("gives another writer's change the place of one that came to nothing", async () => {
    const root = await space({ "note.md": "first" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "typed", { source: "edit" });
    await writeDocument(root, file, "first", { source: "edit" });
    await writeDocument(root, file, "the flow's", { source: "flow", detail: "flows/tidy.flow.html" });

    expect(await kept(root, "note.md")).toEqual([{ text: "first", source: "flow" }]);
    expect((await historyVersions(root, "note.md"))[0].detail).toBe("flows/tidy.flow.html");
  });

  it("keeps nothing for a new file, another kind, a dot folder, a large file, or a space without an id", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const root = await space({ "data.json": "{}", ".trash/old.md": "gone", "big.md": big });
    await writeDocument(root, path.join(root, "new.md"), "fresh", { source: "edit" });
    await writeDocument(root, path.join(root, "data.json"), "[]", { source: "edit" });
    await writeDocument(root, path.join(root, ".trash/old.md"), "x", { source: "edit" });
    await writeDocument(root, path.join(root, "big.md"), "small now", { source: "edit" });
    expect(await historyFiles(root)).toEqual([]);

    const unregistered = tempDir("pragma-history-unregistered-");
    await writeFile(path.join(unregistered, "note.md"), "first");
    await writeDocument(unregistered, path.join(unregistered, "note.md"), "second", { source: "edit" });
    expect(await historyFiles(unregistered)).toEqual([]);
  });

  it("keeps nothing with history turned off", async () => {
    const root = await space({ "note.md": "first" });
    saveGlobalConfig({ ...loadGlobalConfig(), keepHistory: false });
    await writeDocument(root, path.join(root, "note.md"), "second", { source: "edit" });
    expect(await historyFiles(root)).toEqual([]);
  });

  it("keeps fifty versions of a file, and a week of them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = await space({ "note.md": "0" });
    const file = path.join(root, "note.md");
    for (let index = 1; index <= 55; index++) await writeDocument(root, file, String(index), { source: "flow" });
    const versions = await kept(root, "note.md");
    expect(versions).toHaveLength(50);
    expect(versions[0].text).toBe("54");

    vi.advanceTimersByTime(8 * 24 * 60 * MINUTE);
    expect(await historyVersions(root, "note.md")).toEqual([]);
    expect(await historyFiles(root)).toEqual([]);
  });
});

describe("a change made outside Pragma", () => {
  it("keeps the text a window was last served once something else writes over it", async () => {
    const root = await space({ "note.md": "as served" });
    const file = path.join(root, "note.md");
    noteKnown(root, file, "as served");
    await writeFile(file, "an agent's");
    noticeRevision(root, file, revisionOf("an agent's"));
    await vi.waitFor(async () =>
      expect(await kept(root, "note.md")).toEqual([{ text: "as served", source: "outside" }]),
    );
  });

  it("takes none of Pragma's own writes for one, even a check landing as it writes", async () => {
    const root = await space({ "note.md": "as served" });
    const file = path.join(root, "note.md");
    noteKnown(root, file, "as served");
    noticeRevision(root, file, revisionOf("as served"));
    await writeDocument(root, file, "saved", { source: "edit" });
    noticeRevision(root, file, revisionOf("as served"));
    noticeRevision(root, file, revisionOf("saved"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await kept(root, "note.md")).toEqual([{ text: "as served", source: "edit" }]);
  });

  it("keeps the last text of a file deleted outside Pragma", async () => {
    const root = await space({ "note.md": "last words" });
    const file = path.join(root, "note.md");
    noteKnown(root, file, "last words");
    await rm(file);
    noticeRevision(root, file, null);
    await vi.waitFor(async () =>
      expect(await kept(root, "note.md")).toEqual([{ text: "last words", source: "outside" }]),
    );
  });
});

describe("moveHistory", () => {
  it("carries a file's versions, and a folder's files', to where they moved", async () => {
    const root = await space({ "a.md": "a1", "notes/b.md": "b1" });
    await writeDocument(root, path.join(root, "a.md"), "a2", { source: "flow" });
    await writeDocument(root, path.join(root, "notes/b.md"), "b2", { source: "flow" });

    await moveHistory(root, path.join(root, "a.md"), path.join(root, "c.md"));
    await moveHistory(root, path.join(root, "notes"), path.join(root, "kept"));

    expect((await historyFiles(root)).map((file) => file.path).sort()).toEqual(["c.md", "kept/b.md"]);
    expect((await kept(root, "kept/b.md")).map(({ text }) => text)).toEqual(["b1"]);
    expect(await historyVersions(root, "a.md")).toEqual([]);
  });
});

describe("the history routes", () => {
  function request(root: string, url: string, init?: RequestInit) {
    return spaceRoutes(createServedSpace(root), { ownMachine: true })().request(url, init);
  }

  it("lists files newest first, a file's versions, and one version's text", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = await space({ "older.md": "o1", "newer.md": "n1" });
    await writeDocument(root, path.join(root, "older.md"), "o2", { source: "flow" });
    vi.advanceTimersByTime(MINUTE);
    await writeDocument(root, path.join(root, "newer.md"), "n2", { source: "flow" });

    const files = await (await request(root, "/api/history")).json();
    expect(files.files.map((file: { path: string }) => file.path)).toEqual(["newer.md", "older.md"]);

    const { versions } = await (await request(root, "/api/history/file?path=newer.md")).json();
    expect(versions).toHaveLength(1);
    const version = await request(root, `/api/history/version?path=newer.md&id=${versions[0].id}`);
    expect(await version.json()).toEqual({ content: "n1", current: "n2" });
    expect((await request(root, "/api/history/version?path=newer.md&id=../../config")).status).toBe(404);
  });

  it("answers an older version with the next one's text, which its change left", async () => {
    const root = await space({ "note.md": "one" });
    const file = path.join(root, "note.md");
    await writeDocument(root, file, "two", { source: "flow" });
    await writeDocument(root, file, "three", { source: "copilot" });
    const [newest, older] = await historyVersions(root, "note.md");
    const answer = async (id: string) => (await request(root, `/api/history/version?path=note.md&id=${id}`)).json();

    expect(await answer(older.id)).toEqual({ content: "one", next: "two", current: "three" });
    expect(await answer(newest.id)).toEqual({ content: "two", current: "three" });
  });

  it("answers a deleted file's version with no text now", async () => {
    const root = await space({ "gone.md": "g1" });
    await writeDocument(root, path.join(root, "gone.md"), "g2", { source: "flow" });
    await rm(path.join(root, "gone.md"));
    const [version] = await historyVersions(root, "gone.md");
    const answer = await request(root, `/api/history/version?path=gone.md&id=${version.id}`);
    expect(await answer.json()).toEqual({ content: "g1" });
  });

  it("keeps a version for a save through the file route, and clears them all", async () => {
    const root = await space({ "note.md": "before" });
    const saved = await request(root, "/api/file?path=note.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "after" }),
    });
    expect(saved.status).toBe(200);
    expect(await kept(root, "note.md")).toEqual([{ text: "before", source: "edit" }]);

    expect((await request(root, "/api/history/clear", { method: "POST" })).status).toBe(204);
    expect(await historyFiles(root)).toEqual([]);
  });

  it("labels a save by what made it, and brings back a deleted file's folder for a restore", async () => {
    const root = await space({ "note.md": "typed" });
    const put = (spacePath: string, body: object) =>
      request(root, `/api/file?path=${encodeURIComponent(spacePath)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put("note.md", { content: "restored", source: "restored" })).status).toBe(200);
    expect((await put("note.md", { content: "accepted", source: "copilot" })).status).toBe(200);
    expect((await put("note.md", { content: "made up", source: "anything" })).status).toBe(200);
    expect(await kept(root, "note.md")).toEqual([
      { text: "accepted", source: "edit" },
      { text: "restored", source: "copilot" },
      { text: "typed", source: "restored" },
    ]);

    expect((await put("gone/away.md", { content: "back", source: "restored" })).status).toBe(200);
    expect(await readFile(path.join(root, "gone", "away.md"), "utf8")).toBe("back");
  });

  it("names the Flow whose proposal a save was, by a Flow file's path only", async () => {
    const root = await space({ "note.md": "typed" });
    const put = (body: object) =>
      request(root, "/api/file?path=note.md", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await put({ content: "tidied", source: "flow", flow: "flows/tidy.flow.html" })).status).toBe(200);
    expect((await put({ content: "odd", source: "flow", flow: "notes/plain.md" })).status).toBe(200);
    const versions = await historyVersions(root, "note.md");
    expect(versions.map(({ source, detail }) => ({ source, detail }))).toEqual([
      { source: "flow", detail: undefined },
      { source: "flow", detail: "flows/tidy.flow.html" },
    ]);
  });

  it("notices a served file changed outside Pragma when a window asks after it", async () => {
    const root = await space({ "note.md": "served" });
    await request(root, "/api/file?path=note.md");
    await writeFile(path.join(root, "note.md"), "changed elsewhere");
    await request(root, "/api/space/changes?file=note.md");
    await vi.waitFor(async () => expect(await kept(root, "note.md")).toEqual([{ text: "served", source: "outside" }]));
  });

  it("reads and saves the setting", async () => {
    const root = await space();
    expect(await (await request(root, "/api/history/settings")).json()).toEqual({ keepHistory: true });
    const off = await request(root, "/api/history/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keepHistory: false }),
    });
    expect(off.status).toBe(204);
    expect(await (await request(root, "/api/history/settings")).json()).toEqual({ keepHistory: false });
    expect(loadGlobalConfig().keepHistory).toBe(false);
  });
});
