import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";
import { parseFrontmatter } from "../../src/protocol/frontmatter.ts";
import { localDay } from "../../src/protocol/localDay.ts";
import { createWorldIndex, findWorldNames, resolveWorldName, worldFolder } from "../../src/protocol/worldNames.ts";
import { startTestServer, type TestServer } from "../support/testServer.ts";

// POST /api/space/create-from-template, over real HTTP against its own space,
// since the names it hands back depend on what else is in the folder.
describe("API contract — templates", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function place(relative: string, content: string): Promise<void> {
    const absolute = path.join(testServer.spaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  const read = (relative: string) => readFile(path.join(testServer.spaceRoot, relative), "utf8");

  function create(template: string, parentPath: string, name: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/create-from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template, parentPath, name }),
    });
  }

  it("makes a file from a file template, named as typed, its {{$title}} filled", async () => {
    await place("presets/templates/Screenplay/Scene.fountain", "Title: {{$title}}\n\nINT. ROOM - DAY\n");
    await mkdir(path.join(testServer.spaceRoot, "scenes-a"), { recursive: true });

    const res = await create("presets/templates/Screenplay/Scene.fountain", "scenes-a", "Opening");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: "scenes-a/Opening.fountain", type: "file" });
    expect(await read("scenes-a/Opening.fountain")).toBe("Title: Opening\n\nINT. ROOM - DAY\n");
    expect(await read("presets/templates/Screenplay/Scene.fountain")).toContain("{{$title}}");
  });

  it("leaves a Markdown template's byte order mark out of the copy, and its spacing as written", async () => {
    await place("presets/templates/Marked.md", "\uFEFF---\nstatus: draft\n---\n# {{$title}}\n");
    await mkdir(path.join(testServer.spaceRoot, "notes-bom"), { recursive: true });

    const res = await create("presets/templates/Marked.md", "notes-bom", "Opening");
    expect(res.status).toBe(200);
    expect(await read("notes-bom/Opening.md")).toBe("---\nstatus: draft\n---\n# Opening\n");
  });

  it("keeps a title no file can carry where {{$title}} is, and names the file from it", async () => {
    await place("presets/templates/Note.md", "# {{$title}}\n");
    await mkdir(path.join(testServer.spaceRoot, "notes-a"), { recursive: true });

    const res = await create("presets/templates/Note.md", "notes-a", "Part 1: Intro");
    expect(await res.json()).toEqual({ path: "notes-a/Part 1 - Intro.md", type: "file" });
    expect(await read("notes-a/Part 1 - Intro.md")).toBe("# Part 1: Intro\n");
  });

  it("refuses that name when the template has nowhere to keep it, and a taken name", async () => {
    await place("presets/templates/Shots.table.html", "<table></table>\n");
    await place("notes-b/Taken.table.html", "<table></table>\n");

    const illegal = await create("presets/templates/Shots.table.html", "notes-b", "Part 1: Intro");
    expect(illegal.status).toBe(400);
    expect(await illegal.text()).toMatch(/can't contain/);

    const taken = await create("presets/templates/Shots.table.html", "notes-b", "taken");
    expect(taken.status).toBe(409);
    expect(await taken.text()).toBe("Already exists");
  });

  // Copies are never rewritten, so a Class naming its folder by path would
  // list the template's; `this.file.folder` lists each copy's own.
  it("copies a Class reading this.file.folder, which then lists the copy's own notes", async () => {
    const own = { property: "file.folder", test: "is", values: ["this.file.folder"] };
    await place(
      "presets/templates/Shoot/shots.class.html",
      serializeClassFile({ version: "1.0", filter: [own], fields: [], views: [], links: [] }),
    );
    await place("presets/templates/Shoot/README.md", "# {{$title}}\n");
    await place("presets/templates/Shoot/Wide.md", "# Wide\n");
    await mkdir(path.join(testServer.spaceRoot, "shoots"), { recursive: true });
    const rows = async (target: string) => {
      const res = await fetch(`${testServer.baseUrl}/api/space/class?path=${encodeURIComponent(target)}`);
      return ((await res.json()) as { rows: { path: string }[] }).rows.map((row) => row.path);
    };

    expect((await create("presets/templates/Shoot", "shoots", "Day 1")).status).toBe(200);
    expect(await rows("shoots/Day 1/shots.class.html")).toEqual(["shoots/Day 1/Wide.md"]);
    expect(await rows("presets/templates/Shoot/shots.class.html")).toEqual(["presets/templates/Shoot/Wide.md"]);
  });

  it("copies a folder template whole, without its site binding, dot entries or links", async () => {
    await place("presets/templates/Project/README.md", "---\ntitle: {{$title}}\nstatus: active\n---\n\n# {{$title}}\n");
    await place("presets/templates/Project/scenes/_structure.json", '{"order":["_scene.fountain"]}\n');
    await place("presets/templates/Project/scenes/_properties.json", '{"sort":{"by":"name","order":"desc"}}\n');
    await place("presets/templates/Project/scenes/_scene.fountain", "INT. {{$title}} - DAY\n");
    await place("presets/templates/Project/_site.json", '{"id":"ste_x","slug":"x","name":"X"}\n');
    await place("presets/templates/Project/_queue.json", "[]\n");
    await place("presets/templates/Project/.notes", "private\n");
    await place("presets/templates/Project/logo.png", "not really a png");
    await mkdir(path.join(testServer.spaceRoot, "presets/templates/Project/research"), { recursive: true });
    await symlink(
      path.join(testServer.spaceRoot, "README.md"),
      path.join(testServer.spaceRoot, "presets/templates/Project/linked.md"),
    );

    const res = await create("presets/templates/Project", "", "Forbidden");
    expect(await res.json()).toEqual({ path: "Forbidden", type: "directory" });

    const readme = await read("Forbidden/README.md");
    expect(parseFrontmatter(readme).data).toEqual({ title: "Forbidden", status: "active" });
    expect(readme.endsWith("# Forbidden\n")).toBe(true);
    expect(await read("Forbidden/scenes/_structure.json")).toBe('{"order":["_scene.fountain"]}\n');
    expect(await read("Forbidden/scenes/_properties.json")).toBe('{"sort":{"by":"name","order":"desc"}}\n');
    expect(await read("Forbidden/scenes/_scene.fountain")).toBe("INT. Forbidden - DAY\n");
    expect(await read("Forbidden/logo.png")).toBe("not really a png");
    expect(existsSync(path.join(testServer.spaceRoot, "Forbidden/research"))).toBe(true);
    for (const left of ["_site.json", "_queue.json", ".notes", "linked.md"]) {
      expect(existsSync(path.join(testServer.spaceRoot, "Forbidden", left))).toBe(false);
    }
    // Built under a dot name and renamed into place: nothing of it is left.
    expect((await readdir(testServer.spaceRoot)).filter((name) => name.startsWith(".Forbidden"))).toEqual([]);
  });

  // Keeping `id` would make the copy's first publish update the original's page.
  it("drops id and pushed from a copy landing in a site, and keeps them outside one", async () => {
    await place(
      "presets/templates/Post.md",
      "---\nid: doc_original\npushed: 2026-09-03T00:00:00.000Z\n---\n\n# {{$title}}\n",
    );
    await place("site-a/_site.json", JSON.stringify({ id: "ste_a", slug: "a", name: "A" }));
    await mkdir(path.join(testServer.spaceRoot, "plain-a"), { recursive: true });

    await create("presets/templates/Post.md", "site-a", "Launch");
    expect(parseFrontmatter(await read("site-a/Launch.md")).data).toEqual({});
    await create("presets/templates/Post.md", "plain-a", "Launch");
    expect(parseFrontmatter(await read("plain-a/Launch.md")).data).toMatchObject({ id: "doc_original" });
  });

  it("refuses what isn't a template, a group, and a destination among the templates", async () => {
    await place("presets/templates/Group/Daily.md", "# {{$title}}\n");
    await place("presets/templates/README.md", "These are the space's templates.\n");
    await place("loose/Daily.md", "# {{$title}}\n");

    expect((await create("loose/Daily.md", "", "Monday")).status).toBe(400);
    const group = await create("presets/templates/Group", "", "Monday");
    expect(group.status).toBe(404);
    expect(await group.text()).toBe("No template at presets/templates/Group");
    expect((await create("presets/templates/README.md", "", "Monday")).status).toBe(404);
    expect((await create("presets/templates/Group/Daily.md", "presets/templates", "Monday")).status).toBe(400);
    expect((await create("presets/templates/Group/Daily.md", "nowhere", "Monday")).status).toBe(404);
    expect((await create("presets/templates/Group/Daily.md", "../outside", "Monday")).status).toBe(400);
  });

  // The folders `_presets.json` lists hold the templates; nothing else does.
  it("takes a template only from a listed folder, so an old _templates/ is an ordinary folder", async () => {
    await place("_templates/Old.md", "# {{$title}}\n");
    const res = await create("_templates/Old.md", "", "Old");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe("Not a template");
  });

  it("names a template in any case, as every path does", async () => {
    await place("presets/templates/Weekly.md", "# {{$title}}\n");
    await mkdir(path.join(testServer.spaceRoot, "weeks"), { recursive: true });

    const res = await create("Presets/Templates/WEEKLY.md", "weeks", "Week 1");
    expect(await res.json()).toEqual({ path: "weeks/Week 1.md", type: "file" });
    expect(await read("weeks/Week 1.md")).toBe("# Week 1\n");
  });
});

// Pragma's own templates, read from the repo's templates/builtin/ as a
// packaged build reads them from its archive.
describe("API contract — Pragma's own templates", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  const read = (relative: string) => readFile(path.join(testServer.spaceRoot, relative), "utf8");

  function create(template: string, parentPath: string, name: string, source?: string): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/create-from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ template, parentPath, name, source }),
    });
  }

  it("lists a Screenplay project and a Scene", async () => {
    const res = await fetch(`${testServer.baseUrl}/api/templates`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      templates: [
        { kind: "folder", name: "Screenplay", path: "Screenplay" },
        { kind: "file", name: "Scene.fountain", path: "Scene.fountain" },
      ],
    });
    expect((await fetch(`${testServer.baseUrl}/api/templates`, { method: "POST" })).status).toBe(405);
  });

  it("makes a screenplay project that opens a scope, its scenes in order, and a world its opening cue links", async () => {
    const res = await create("Screenplay", "", "Forbidden", "pragma");
    expect(await res.json()).toEqual({ path: "Forbidden", type: "directory" });

    const readme = await read("Forbidden/README.md");
    expect(parseFrontmatter(readme).data).not.toHaveProperty("pragma");
    expect(readme).toContain("\n# Forbidden\n");
    const agents = await read("Forbidden/AGENTS.md");
    const { pragma } = parseFrontmatter(agents).data;
    expect(pragma).toEqual({ screenplay: { world: "world/" } });
    expect(agents).toContain("\n# Forbidden\n");
    expect(JSON.parse(await read("Forbidden/scenes/_structure.json"))).toEqual({
      order: [{ name: "Opening.fountain" }],
    });
    const opening = await read("Forbidden/scenes/Opening.fountain");
    expect(opening).toMatch(/^= </);
    expect(await readdir(path.join(testServer.spaceRoot, "Forbidden/world"))).toEqual(["Protagonist.md"]);

    // By the World names rules: the scene's one character cue links the
    // placeholder character as soon as the project exists, its AGENTS.md
    // naming the world.
    const files = ["README.md", "scenes/Opening.fountain", "world/Protagonist.md"].map((file) => `Forbidden/${file}`);
    const blocks = (folder: string) => (folder === "Forbidden" ? pragma : undefined);
    const folder = worldFolder(blocks, "Forbidden/scenes/Opening.fountain") ?? "";
    const world = createWorldIndex(files, folder);
    const cue = opening.split("\n").find((line) => /^[A-Z ]+$/.test(line)) ?? "";
    expect(findWorldNames(cue, "character", (name) => resolveWorldName(world, name))).toEqual([
      { from: 0, to: cue.length, path: "Forbidden/world/Protagonist.md" },
    ]);
  });

  it("makes a scene, and refuses a template Pragma doesn't have or an unknown source", async () => {
    await mkdir(path.join(testServer.spaceRoot, "scenes-b"), { recursive: true });
    expect(await (await create("Scene.fountain", "scenes-b", "Cold open", "pragma")).json()).toEqual({
      path: "scenes-b/Cold open.fountain",
      type: "file",
    });
    expect(await read("scenes-b/Cold open.fountain")).toBe(await readFile("templates/builtin/Scene.fountain", "utf8"));
    expect((await create("Nothing.md", "", "x", "pragma")).status).toBe(404);
    expect((await create("Scene.fountain", "", "x", "elsewhere")).status).toBe(400);
  });
});

// The template space's own templates, and their dates: the moment a copy is
// made, the writer's when the request says it.
describe("API contract — dated templates", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  const read = (relative: string) => readFile(path.join(testServer.spaceRoot, relative), "utf8");

  async function startingName(template: string, now?: string): Promise<Response> {
    const query = new URLSearchParams({ template, ...(now ? { now } : {}) });
    return fetch(`${testServer.baseUrl}/api/space/template-name?${query}`);
  }

  function create(body: Record<string, string>): Promise<Response> {
    return fetch(`${testServer.baseUrl}/api/space/create-from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // A dated template has no title to ask for, so its copy starts at the day.
  it("starts a dated template's name at the writer's day, and a titled one's at nothing", async () => {
    const now = "2026-10-21T23:30:00-07:00";
    expect(await (await startingName("presets/templates/Daily Note.md", now)).json()).toEqual({ name: "2026-10-21" });
    expect(await (await startingName("presets/templates/Project", now)).json()).toEqual({ name: "" });
    expect((await startingName("presets/templates/Daily Note.md", "2026-02-30T10:00:00+01:00")).status).toBe(400);
    expect((await startingName("presets/templates/Daily Note.md", "2026-10-21")).status).toBe(400);
    expect((await startingName("presets/templates/Nothing.md")).status).toBe(404);
  });

  it("fills the dates with the writer's moment, in the frontmatter as a day", async () => {
    const res = await create({
      template: "presets/templates/Daily Note.md",
      parentPath: "",
      name: "2026-10-21",
      now: "2026-10-21T23:30:00-07:00",
    });
    expect(await res.json()).toEqual({ path: "2026-10-21.md", type: "file" });
    const note = await read("2026-10-21.md");
    expect(parseFrontmatter(note).data).toEqual({ date: "2026-10-21" });
    expect(note).toContain("\n# Wednesday, October 21\n");
  });

  it("takes the host's own day when the request names none", async () => {
    await create({ template: "presets/templates/Daily Note.md", parentPath: "", name: "Undated" });
    expect(parseFrontmatter(await read("Undated.md")).data).toEqual({ date: localDay(new Date()) });
  });

  it("makes a project from the template space's own folder template", async () => {
    await create({ template: "presets/templates/Project", parentPath: "projects", name: "Atlas" });
    expect(await read("projects/Atlas/README.md")).toContain("\n# Atlas\n");
    const agents = await read("projects/Atlas/AGENTS.md");
    expect(parseFrontmatter(agents).data).toMatchObject({ pragma: null });
    expect(agents).toContain("\n# Atlas\n");
  });
});

// Templates stay out of what offers the space's files, unless the search or
// Class is already among them.
describe("API contract — templates left out", () => {
  let testServer: TestServer;

  beforeAll(async () => {
    testServer = await startTestServer();
  });

  afterAll(async () => {
    await testServer.close();
  });

  async function place(relative: string, content: string): Promise<void> {
    const absolute = path.join(testServer.spaceRoot, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }

  it("leaves templates out of a search, unless it is narrowed to them", async () => {
    await place("presets/templates/Meeting.md", "Quokka agenda\n");
    await place("found/notes.md", "Quokka minutes\n");
    const search = async (query: string) =>
      (
        (await (await fetch(`${testServer.baseUrl}/api/space/search?${query}`)).json()) as { files: { path: string }[] }
      ).files.map((file) => file.path);

    expect(await search("q=quokka")).toEqual(["found/notes.md"]);
    expect(await search("q=quokka&dir=presets/templates")).toEqual(["presets/templates/Meeting.md"]);
  });

  it("leaves templates out of a Class's rows, unless its Folder rule names a folder among them", async () => {
    await place("presets/templates/Shot.md", "---\ntags: [shot]\n---\n\n# {{$title}}\n");
    await place(
      "presets/templates/shots.class.html",
      classFile([{ property: "file.folder", test: "within", values: ["presets/templates"] }]),
    );
    await place("all.class.html", classFile([]));
    const rows = async (target: string) =>
      (
        (await (await fetch(`${testServer.baseUrl}/api/space/class?path=${target}`)).json()) as {
          rows: { path: string }[];
        }
      ).rows.map((row) => row.path);

    expect(await rows("all.class.html")).not.toContain("presets/templates/Shot.md");
    expect(await rows("presets/templates/shots.class.html")).toEqual(["presets/templates/Shot.md"]);
  });

  function classFile(folders: { property: string; test: string; values: string[] }[]): string {
    return serializeClassFile({
      version: "1.0",
      filter: [...folders, { property: "tags", test: "has", values: ["shot"] }],
      fields: [],
      views: [],
      links: [],
    });
  }
});
