import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RootPathsResponse, SpaceTreeNode } from "../../../web/core/apiClient.ts";

// spaceTree is a module-level singleton (matches main.ts's single tree per
// space) — each test gets a fresh module instance via vi.resetModules() so
// tests don't leak tree state into each other.
async function freshSpaceTree() {
  vi.resetModules();
  return import("../../../web/core/spaceTree.ts");
}

const SAMPLE_TREE: SpaceTreeNode[] = [
  {
    name: "projects",
    path: "projects",
    type: "directory",
    sortable: true,
    children: [
      { name: "a.md", path: "projects/a.md", type: "file" },
      {
        name: "nested",
        path: "projects/nested",
        type: "directory",
        children: [{ name: "b.md", path: "projects/nested/b.md", type: "file" }],
      },
    ],
  },
  { name: "root.md", path: "root.md", type: "file" },
];

// The listing a tree implies, with nothing the tree hides.
function listingOf(tree: readonly SpaceTreeNode[], extra: Partial<RootPathsResponse> = {}): RootPathsResponse {
  const files: string[] = [];
  const folders: string[] = [];
  const walk = (nodes: readonly SpaceTreeNode[]) => {
    for (const node of nodes) {
      if (node.type === "file") files.push(node.path);
      else {
        folders.push(node.path);
        walk(node.children ?? []);
      }
    }
  };
  walk(tree);
  return {
    files: [...files, ...(extra.files ?? [])],
    folders: [...folders, ...(extra.folders ?? [])],
    scopes: extra.scopes ?? [],
  };
}

// A fake server: the tree and the listing for the space, and for each
// library named in `libraries` its tree and listing.
function serve(
  tree: SpaceTreeNode[],
  paths: RootPathsResponse = listingOf(tree),
  libraries: Record<string, SpaceTreeNode[]> = {},
) {
  return vi.fn(async (url: string) => {
    if (String(url) === "/api/space/libraries") {
      return Response.json({
        libraries: Object.keys(libraries).map((id) => ({
          id,
          label: id,
          path: `/${id}`,
          access: "read-only",
          missing: false,
        })),
      });
    }
    const library = /^\/api\/space\/libraries\/([^/]+)\/(tree|paths)/.exec(String(url));
    if (library) {
      const libraryTree = libraries[library[1]];
      if (!libraryTree) return new Response("Unknown library", { status: 404 });
      return Response.json(library[2] === "tree" ? libraryTree : listingOf(libraryTree));
    }
    return Response.json(String(url).startsWith("/api/space/paths") ? paths : tree);
  });
}

describe("getTree / refresh", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts empty before any refresh()", async () => {
    const spaceTree = await freshSpaceTree();
    expect(spaceTree.getTree()).toEqual([]);
  });

  it("refresh() fetches and stores the tree and the space's listing, and returns the tree", async () => {
    const spaceTree = await freshSpaceTree();
    const fetchMock = serve(SAMPLE_TREE);
    vi.stubGlobal("fetch", fetchMock);
    const result = await spaceTree.refresh();
    expect(result).toEqual(SAMPLE_TREE);
    expect(spaceTree.getTree()).toEqual(SAMPLE_TREE);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/space/tree", "/api/space/paths"]);
  });
});

// A picker offers the space's content, which never holds a template.
describe("offeredFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("leaves the templates out of what a picker offers", async () => {
    const spaceTree = await freshSpaceTree();
    const tree: SpaceTreeNode[] = [
      {
        name: "_templates",
        path: "_templates",
        type: "directory",
        children: [{ name: "Run.flow.html", path: "_templates/Run.flow.html", type: "file" }],
      },
      { name: "Run.flow.html", path: "Run.flow.html", type: "file" },
      { name: "root.md", path: "root.md", type: "file" },
    ];
    vi.stubGlobal("fetch", serve(tree));
    await spaceTree.refresh();
    expect(spaceTree.offeredFiles()).toEqual(["Run.flow.html", "root.md"]);
  });
});

describe("findDirectoryNode / findDirectoryChildren", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", serve(SAMPLE_TREE));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds a top-level directory node", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.findDirectoryNode("projects")?.name).toBe("projects");
  });

  it("finds a nested directory node", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.findDirectoryNode("projects/nested")?.name).toBe("nested");
  });

  it("returns undefined for a path that doesn't exist", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.findDirectoryNode("nope")).toBeUndefined();
  });

  it("returns the root's children for an empty dirPath", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.findDirectoryChildren("")).toEqual(SAMPLE_TREE);
  });

  it("returns a nested directory's children", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.findDirectoryChildren("projects/nested")?.map((node) => node.name)).toEqual(["b.md"]);
  });

  it("returns the live array reference, so an in-place mutation is visible on the next read", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    const children = spaceTree.findDirectoryChildren("projects");
    children?.push({ name: "c.md", path: "projects/c.md", type: "file" });
    expect(spaceTree.findDirectoryChildren("projects")?.some((node) => node.name === "c.md")).toBe(true);
  });
});

describe("fileTypeAt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives Pragma's mark, by path alone, to an AGENTS.md the tree says opens a scope", async () => {
    const spaceTree = await freshSpaceTree();
    const tree: SpaceTreeNode[] = [
      {
        name: "film",
        path: "film",
        type: "directory",
        children: [
          { name: "agents.md", path: "film/agents.md", type: "file", opensScope: true },
          { name: "shots.table.html", path: "film/shots.table.html", type: "file" },
          {
            name: "notes",
            path: "film/notes",
            type: "directory",
            children: [{ name: "AGENTS.md", path: "film/notes/AGENTS.md", type: "file" }],
          },
        ],
      },
      { name: "README.md", path: "README.md", type: "file" },
    ];
    vi.stubGlobal("fetch", serve(tree));
    await spaceTree.refresh();
    expect(spaceTree.fileTypeAt("film/agents.md")).toBe("scope");
    expect(spaceTree.fileTypeAt("README.md")).toBe("readme");
    expect(spaceTree.fileTypeAt("film/shots.table.html")).toBe("table");
    // One that opens no scope, and any in a library, wears the mark in grey.
    expect(spaceTree.fileTypeAt("film/notes/AGENTS.md")).toBe("agents");
    expect(spaceTree.fileTypeAt("lib:film/AGENTS.md")).toBe("agents");
  });

  it("gives a JSON file the tree marks as Pragma's its colours, by path alone", async () => {
    const spaceTree = await freshSpaceTree();
    const tree: SpaceTreeNode[] = [
      { name: "_tags.json", path: "_tags.json", type: "file", pragmaFile: "tags" },
      { name: "data.json", path: "data.json", type: "file" },
    ];
    vi.stubGlobal("fetch", serve(tree));
    await spaceTree.refresh();
    expect(spaceTree.fileTypeAt("_tags.json")).toBe("pragma-file");
    expect(spaceTree.fileTypeAt("data.json")).toBe("json");
    expect(spaceTree.fileTypeAt("lib:film/_tags.json")).toBe("json");
  });
});

describe("resolving a written path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The listing holds what the tree hides: a file of no kind, a folder.
  async function withListing() {
    const spaceTree = await freshSpaceTree();
    vi.stubGlobal(
      "fetch",
      serve(SAMPLE_TREE, listingOf(SAMPLE_TREE, { files: ["projects/budget.csv"], scopes: ["projects/nested"] })),
    );
    await spaceTree.refresh();
    return spaceTree;
  }

  it("reads a wikilink as a path from the document's folder, never as a name", async () => {
    const spaceTree = await withListing();
    const wikilink = (target: string, docPath: string) => spaceTree.resolvePathFrom(docPath, target, "wikilink");
    expect(wikilink("a", "projects/note.md")).toEqual({ path: "projects/a.md", type: "file" });
    expect(wikilink("nested/b", "projects/note.md")?.path).toBe("projects/nested/b.md");
    expect(wikilink("b", "projects/note.md")).toBeUndefined();
    expect(wikilink("/root", "projects/note.md")?.path).toBe("root.md");
    expect(wikilink("nested/", "projects/note.md")).toEqual({ path: "projects/nested", type: "directory" });
  });

  it("finds a file the tree doesn't show", async () => {
    const spaceTree = await withListing();
    expect(spaceTree.resolvePathFrom("projects/note.md", "budget.csv", "wikilink")?.path).toBe("projects/budget.csv");
  });

  it("builds one index per listing, and a new one once a refresh replaces it", async () => {
    const spaceTree = await withListing();
    expect(spaceTree.resolvePathFrom("note.md", "new", "wikilink")).toBeUndefined();
    const added: SpaceTreeNode = { name: "new.md", path: "new.md", type: "file" };
    vi.stubGlobal("fetch", serve([...SAMPLE_TREE, added]));
    await spaceTree.refresh();
    expect(spaceTree.resolvePathFrom("note.md", "new", "wikilink")?.path).toBe("new.md");
  });

  it("names the space's scopes for writing, and none for a library", async () => {
    const spaceTree = await withListing();
    expect([...spaceTree.scopesOf("projects/note.md")]).toEqual(["projects/nested"]);
    expect([...spaceTree.scopesOf("lib:footage/note.md")]).toEqual([]);
  });

  it("resolves reading view's links and embeds by the listing, case and all", async () => {
    const spaceTree = await withListing();
    const resolvers = spaceTree.readingResolvers("projects/note.md");
    expect(resolvers.wikilink("A")).toBe("projects/a.md");
    expect(resolvers.link("A.md")).toBe("projects/a.md");
    // A folder ends in `/`, which is what opens its gallery.
    expect(resolvers.link("nested")).toBe("projects/nested/");
    expect(resolvers.wikilink("nested/")).toBe("projects/nested/");
    expect(resolvers.link("#top")).toBeUndefined();
    // Not in the listing: still the path as written, so it can say what's missing.
    expect(resolvers.link("gone.md")).toBe("projects/gone.md");
    expect(resolvers.image("photo.png")).toBe("/api/file/raw?path=projects%2Fphoto.png");
    expect(resolvers.image("a.md")).toBeUndefined();
  });

  // The root searched is the referring document's. A library note's link
  // must not land on a space file of the same path — that is a confidently
  // wrong file, which is worse than no link at all.
  it("reads a library document's links in its own library, once its listing lands", async () => {
    const spaceTree = await freshSpaceTree();
    const fetchMock = serve([{ name: "cover.md", path: "cover.md", type: "file" }], undefined, {
      footage: [{ name: "cover.md", path: "cover.md", type: "file" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    await spaceTree.refresh();
    const landed = vi.fn();
    spaceTree.onLibraryTreeLoaded(landed);

    expect(spaceTree.resolvePathFrom("lib:footage/read-me.md", "cover", "wikilink")).toBeUndefined();
    await vi.waitFor(() => expect(landed).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/api/space/libraries/footage/paths", expect.anything());
    expect(spaceTree.resolvePathFrom("lib:footage/read-me.md", "cover", "wikilink")?.path).toBe("lib:footage/cover.md");
    expect(spaceTree.resolvePathFrom("note.md", "cover", "wikilink")?.path).toBe("cover.md");
  });
});

// What a media cell draws offline without asking: only what a current
// listing of the space lacks, matched as entry names compare.
describe("listedAsGone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says nothing before the first read", async () => {
    const spaceTree = await freshSpaceTree();
    expect(spaceTree.listedAsGone("projects/gone.png")).toBe(false);
  });

  it("names only a space path the listing lacks, never a library's", async () => {
    const spaceTree = await freshSpaceTree();
    vi.stubGlobal("fetch", serve(SAMPLE_TREE, listingOf(SAMPLE_TREE, { files: ["projects/budget.csv"] })));
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("projects/gone.png")).toBe(true);
    expect(spaceTree.listedAsGone("projects/budget.csv")).toBe(false);
    expect(spaceTree.listedAsGone("Projects/A.md")).toBe(false);
    expect(spaceTree.listedAsGone("projects/nested")).toBe(false);
    expect(spaceTree.listedAsGone("lib:footage/gone.png")).toBe(false);
  });

  it("says nothing while a noted write may be missing from the listing", async () => {
    const spaceTree = await freshSpaceTree();
    vi.stubGlobal("fetch", serve(SAMPLE_TREE));
    await spaceTree.refresh();
    spaceTree.noteUnlistedWrites();
    expect(spaceTree.listedAsGone("projects/gone.png")).toBe(false);
    await spaceTree.refresh();
    expect(spaceTree.listedAsGone("projects/gone.png")).toBe(true);
  });
});

// A library's listing loads the first time something asks, and says so when
// it lands; nothing loads for a library nobody reads.
describe("a library, loaded on first use", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks once for a library that fails to load, until it is forgotten", async () => {
    const spaceTree = await freshSpaceTree();
    const fetchMock = vi.fn(async () => new Response("Unknown library", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    spaceTree.resolvePathFrom("lib:gone/read-me.md", "cover", "wikilink");
    spaceTree.resolvePathFrom("lib:gone/read-me.md", "cover", "wikilink");
    await new Promise((resolve) => setTimeout(resolve, 0));
    spaceTree.resolvePathFrom("lib:gone/read-me.md", "cover", "wikilink");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    spaceTree.forgetLibraryTree("gone");
    spaceTree.resolvePathFrom("lib:gone/read-me.md", "cover", "wikilink");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("drops a forgotten listing, and a load the forget overtook", async () => {
    const spaceTree = await freshSpaceTree();
    const listing = (file: string) => Response.json({ files: [file], folders: [], scopes: [] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce(listing("old.md"));
    spaceTree.resolvePathFrom("lib:footage/x.md", "old", "wikilink");
    await vi.waitFor(() =>
      expect(spaceTree.resolvePathFrom("lib:footage/x.md", "old", "wikilink")?.path).toBe("lib:footage/old.md"),
    );

    let release: (response: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (release = resolve)));
    spaceTree.forgetLibraryTree("footage");
    expect(spaceTree.resolvePathFrom("lib:footage/x.md", "old", "wikilink")).toBeUndefined();
    spaceTree.forgetLibraryTree("footage");
    fetchMock.mockResolvedValueOnce(listing("new.md"));
    spaceTree.resolvePathFrom("lib:footage/x.md", "new", "wikilink");
    release(listing("old.md"));
    await vi.waitFor(() =>
      expect(spaceTree.resolvePathFrom("lib:footage/x.md", "new", "wikilink")?.path).toBe("lib:footage/new.md"),
    );
    expect(spaceTree.resolvePathFrom("lib:footage/x.md", "old", "wikilink")).toBeUndefined();
  });
});

describe("what a `[[` offers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the document's root's files and folders, with its scopes", async () => {
    const spaceTree = await freshSpaceTree();
    vi.stubGlobal("fetch", serve(SAMPLE_TREE, listingOf(SAMPLE_TREE, { scopes: ["projects"] })));
    await spaceTree.refresh();
    const scope = spaceTree.linkScope("projects/note.md");
    expect(scope?.files).toEqual(["projects/a.md", "projects/nested/b.md", "root.md"]);
    expect(scope?.folders).toEqual(["projects", "projects/nested"]);
    expect([...(scope?.scopes ?? [])]).toEqual(["projects"]);
  });

  it("offers every library's files to a space document, loading each the first time", async () => {
    const spaceTree = await freshSpaceTree();
    vi.stubGlobal(
      "fetch",
      serve(SAMPLE_TREE, undefined, { footage: [{ name: "a.png", path: "stills/a.png", type: "file" }] }),
    );
    expect(await spaceTree.libraryFiles()).toEqual(["lib:footage/stills/a.png"]);
  });
});

describe("site images and the assets folder", () => {
  const SITE_TREE: SpaceTreeNode[] = [
    {
      name: "blog",
      path: "blog",
      type: "directory",
      site: { name: "Blog", assetsFolder: "assets" },
      children: [
        { name: "post.md", path: "blog/post.md", type: "file" },
        { name: "icon.png", path: "blog/icon.png", type: "file" },
        { name: "mark.svg", path: "blog/mark.svg", type: "file" },
        {
          name: "assets",
          path: "blog/assets",
          type: "directory",
          children: [{ name: "logo.webp", path: "blog/assets/logo.webp", type: "file" }],
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", serve(SITE_TREE));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists every image under a site", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.imagesUnder("blog")).toEqual(["blog/icon.png", "blog/mark.svg", "blog/assets/logo.webp"]);
  });

  it("puts a pasted image in the site's assets folder", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    expect(spaceTree.imageFolderFor("blog/post.md")).toBe("blog/assets");
    expect(spaceTree.imageFolderFor("elsewhere/note.md")).toBe("elsewhere");
  });
});

describe("markdownLinks", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", serve(SAMPLE_TREE));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists each linked file once, in order of first mention, with where it is named, then the targets that name nothing", async () => {
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    const note = [
      "---",
      "tags: [[x]]",
      "---",
      "See [[nested/b]], then [a](a.md) and [[nested/b|again]], and [its folder](nested/).",
      "Gone: [[b]] and [lost](lost.md).",
      "Skipped: ![shot](a.png), [site](https://example.com), [top](#top).",
      "`[[in code]]`",
    ].join("\n");
    const span = (before: string, text: string) => {
      const from = note.indexOf(before) + before.length;
      return { from, to: from + text.length };
    };
    expect(spaceTree.markdownLinks("projects/note.md", note)).toEqual({
      found: [
        { path: "projects/nested/b.md", mentions: [span("See [[", "nested/b"), span("and [[", "nested/b")] },
        { path: "projects/a.md", mentions: [span("[a](", "a.md")] },
      ],
      missing: ["b", "lost.md"],
    });
  });

  it("finds nothing outside a loaded root", async () => {
    const spaceTree = await freshSpaceTree();
    expect(spaceTree.markdownLinks("lib:footage/read-me.md", "[[a]]")).toEqual({ found: [], missing: ["a"] });
  });
});

describe("inTreeOrder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("orders paths as the tree draws them, each root's tree in turn, and puts paths no tree holds last", async () => {
    const library: SpaceTreeNode[] = [
      { name: "z.md", path: "z.md", type: "file" },
      { name: "a.md", path: "a.md", type: "file" },
    ];
    vi.stubGlobal("fetch", serve(SAMPLE_TREE, undefined, { footage: library }));
    const spaceTree = await freshSpaceTree();
    await spaceTree.refresh();
    await spaceTree.loadLibraryTree("footage");
    expect(
      spaceTree.inTreeOrder([
        "gone.md",
        "lib:footage/a.md",
        "root.md",
        "projects/nested/b.md",
        "lib:footage/z.md",
        "projects/a.md",
      ]),
    ).toEqual(["projects/a.md", "projects/nested/b.md", "root.md", "lib:footage/z.md", "lib:footage/a.md", "gone.md"]);
  });
});
