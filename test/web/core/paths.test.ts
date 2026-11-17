import { describe, expect, it } from "vitest";
import type { FolderEntry } from "../../../src/protocol/api.ts";
import { basenameOf, dirnameOf } from "../../../src/protocol/rootedPath.ts";
import type { LibraryRow, SpaceTreeNode } from "../../../web/core/apiClient.ts";
import { setLibraryPermissions } from "../../../web/core/libraries.ts";
import {
  carriesDesktopFiles,
  DRAGGED_ENTRY_TYPE,
  desktopFiles,
  displayName,
  draggedPathInFlight,
  extensionOf,
  fileTypeClass,
  fileTypeLabel,
  flattenTreeFilePaths,
  folderContentsLabel,
  folderTitle,
  mediaTabKind,
  nodeFileType,
  pendingFileType,
  pragmaFileLabel,
  shownTitle,
  stripExtension,
  tableContentsLabel,
  treeTakesDrag,
  treeTotalsLabel,
  wireEntryDrag,
} from "../../../web/core/paths.ts";
import { fakeDrag, fireDrag } from "../support/drag.ts";

describe("stripExtension", () => {
  it("strips a plain extension", () => {
    expect(stripExtension("note.md")).toBe("note");
  });

  it("strips the compound .table.html extension as one unit", () => {
    expect(stripExtension("inventory.table.html")).toBe("inventory");
  });

  it("strips the compound .class.html extension as one unit", () => {
    expect(stripExtension("shots.class.html")).toBe("shots");
    expect(extensionOf("shots.class.html")).toBe(".class.html");
  });

  it("strips the compound .applet.html extension as one unit", () => {
    expect(stripExtension("model-sheet.applet.html")).toBe("model-sheet");
  });

  it("strips the compound .flow.html extension as one unit", () => {
    expect(stripExtension("outline.flow.html")).toBe("outline");
  });

  it("leaves a dotfile's leading dot untouched", () => {
    expect(stripExtension(".gitignore")).toBe(".gitignore");
  });

  it("leaves a name with no extension untouched", () => {
    expect(stripExtension("README")).toBe("README");
  });
});

describe("extensionOf", () => {
  it("returns a plain extension with its leading dot", () => {
    expect(extensionOf("note.md")).toBe(".md");
  });

  it("returns the compound .table.html extension as one unit", () => {
    expect(extensionOf("inventory.table.html")).toBe(".table.html");
  });

  it("returns the compound .flow.html extension as one unit", () => {
    expect(extensionOf("outline.flow.html")).toBe(".flow.html");
  });

  it("returns empty string for a dotfile", () => {
    expect(extensionOf(".gitignore")).toBe("");
  });

  it("returns empty string for a name with no extension", () => {
    expect(extensionOf("README")).toBe("");
  });
});

describe("displayName", () => {
  const file: SpaceTreeNode = { name: "note.md", path: "note.md", type: "file" };
  const dir: SpaceTreeNode = { name: "projects", path: "projects", type: "directory" };

  it("shows the stripped name for a file when extensions are hidden", () => {
    expect(displayName(file, false)).toBe("note");
  });

  it("shows the full name for a file when extensions are shown", () => {
    expect(displayName(file, true)).toBe("note.md");
  });

  it("never strips a directory's name, extensions shown or not", () => {
    expect(displayName(dir, false)).toBe("projects");
    expect(displayName(dir, true)).toBe("projects");
  });
});

describe("dirnameOf / basenameOf", () => {
  it("splits a nested path", () => {
    expect(dirnameOf("projects/demo/note.md")).toBe("projects/demo");
    expect(basenameOf("projects/demo/note.md")).toBe("note.md");
  });

  it("handles a root-level path with no separator", () => {
    expect(dirnameOf("note.md")).toBe("");
    expect(basenameOf("note.md")).toBe("note.md");
  });
});

describe("folderTitle", () => {
  it("names a folder whole, dots and all", () => {
    expect(folderTitle("projects/v1.2")).toBe("v1.2");
    expect(folderTitle("lib:footage/day 1")).toBe("day 1");
  });

  it("names a root as the status bar does: a library by its name once read, the space as Space", () => {
    expect(folderTitle("lib:footage")).toBe("footage");
    setLibraryPermissions([{ id: "footage", label: "Footage" } as LibraryRow]);
    expect(folderTitle("lib:footage")).toBe("Footage");
    expect(folderTitle("")).toBe("Space");
  });
});

describe("folderContentsLabel", () => {
  const entries = (folders: number, files: number) => [
    ...Array.from({ length: folders }, () => ({ type: "directory" as const })),
    ...Array.from({ length: files }, () => ({ type: "file" as const })),
  ];

  it("counts folders and files, singular for one, leaving out a part with none", () => {
    expect(folderContentsLabel(entries(2, 7))).toBe("2 folders · 7 files");
    expect(folderContentsLabel(entries(1, 1))).toBe("1 folder · 1 file");
    expect(folderContentsLabel(entries(0, 7))).toBe("7 files");
    expect(folderContentsLabel(entries(3, 0))).toBe("3 folders");
  });

  // The view says it is empty itself.
  it("says nothing of an empty folder", () => {
    expect(folderContentsLabel([])).toBe("");
  });
});

// An empty Table's "0 rows" is the useful answer, so no part is left out.
describe("tableContentsLabel", () => {
  it("counts columns, then rows, singular for one", () => {
    expect(tableContentsLabel(3, 12)).toBe("3 columns · 12 rows");
    expect(tableContentsLabel(1, 1)).toBe("1 column · 1 row");
    expect(tableContentsLabel(2, 0)).toBe("2 columns · 0 rows");
  });
});

describe("shownTitle", () => {
  it("is the title given, else the file's name without its extension", () => {
    expect(shownTitle(" Takes ", "shots/takes.table.html")).toBe("Takes");
    expect(shownTitle("  ", "shots/takes.table.html")).toBe("takes");
    expect(shownTitle(undefined, "lib:lab/story.flow.html")).toBe("story");
  });
});

describe("treeTotalsLabel", () => {
  const file = (path: string): SpaceTreeNode => ({ name: basenameOf(path), path, type: "file" });
  const folder = (path: string, children: SpaceTreeNode[]): SpaceTreeNode => ({
    name: basenameOf(path),
    path,
    type: "directory",
    children,
  });

  it("totals every file and folder under a listing, all the way down", () => {
    const listing = [
      file("README.md"),
      folder("projects", [file("projects/a.md"), folder("projects/drafts", [file("projects/drafts/b.md")])]),
      folder("empty", []),
    ];
    expect(treeTotalsLabel(listing)).toBe("3 files, 3 folders");
    expect(treeTotalsLabel([file("only.md")])).toBe("1 file, 0 folders");
    expect(treeTotalsLabel([])).toBe("0 files, 0 folders");
  });
});

describe("flattenTreeFilePaths", () => {
  it("collects every file path, skipping directory nodes themselves", () => {
    const tree: SpaceTreeNode[] = [
      {
        name: "projects",
        path: "projects",
        type: "directory",
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
    expect(flattenTreeFilePaths(tree)).toEqual(["projects/a.md", "projects/nested/b.md", "root.md"]);
  });

  it("returns an empty array for an empty tree", () => {
    expect(flattenTreeFilePaths([])).toEqual([]);
  });
});

// The tab kind and the tree's icon come from one lookup, so a PDF opens in
// the pane its row's glyph promises.
describe("mediaTabKind / fileTypeClass", () => {
  it("names each media kind for both, and nothing else", () => {
    for (const [path, kind] of [
      ["art/cover.PNG", "image"],
      ["art/logo.svg", "image"],
      ["takes/a.mov", "video"],
      ["refs/paper.pdf", "pdf"],
    ] as const) {
      expect(mediaTabKind(path), path).toBe(kind);
      expect(fileTypeClass(path), path).toBe(kind);
    }
    expect(mediaTabKind("notes/paper.pdf.md")).toBeUndefined();
  });

  it("names Pragma's own formats for their icons", () => {
    expect(fileTypeClass("shots/shots.class.html")).toBe("class");
    expect(fileTypeClass("data/takes.table.html")).toBe("table");
    expect(mediaTabKind("shots/shots.class.html")).toBeUndefined();
  });

  it("knows a README by its name in any case, and any other note as Markdown", () => {
    expect(fileTypeClass("film/README.md")).toBe("readme");
    expect(fileTypeClass("Readme.MD")).toBe("readme");
    expect(fileTypeClass("film/README.txt")).toBeUndefined();
    expect(fileTypeClass("film/notes.md")).toBe("markdown");
    expect(fileTypeLabel("readme")).toBe("Readme");
  });
});

// The extension can't say an AGENTS.md opens a scope; only its tree node can.
describe("nodeFileType", () => {
  it("gives an AGENTS.md that opens a scope Pragma's mark, and any other node its name's or extension's class", () => {
    const agents = { name: "AGENTS.md", path: "film/AGENTS.md", type: "file" } as const;
    expect(nodeFileType({ ...agents, opensScope: true })).toBe("scope");
    expect(nodeFileType(agents)).toBe("agents");
    expect(nodeFileType({ name: "README.md", path: "film/README.md", type: "file" })).toBe("readme");
    expect(nodeFileType({ name: "a.flow.html", path: "film/a.flow.html", type: "file" })).toBe("flow");
    expect(nodeFileType({ name: "todo.txt", path: "film/todo.txt", type: "file" })).toBeUndefined();
    expect(fileTypeLabel("scope")).toBe("Pragma scope");
    expect(fileTypeLabel("markdown")).toBe("Note");
  });

  it("gives a JSON file Pragma reads its colours, and any other JSON file the plain braces", () => {
    const tags = { name: "_tags.json", path: "_tags.json", type: "file" } as const;
    expect(nodeFileType({ ...tags, pragmaFile: "tags" })).toBe("pragma-file");
    expect(nodeFileType(tags)).toBe("json");
    expect(fileTypeClass("data/Export.JSON")).toBe("json");
    expect(fileTypeLabel("json")).toBe("JSON");
    expect(pragmaFileLabel("order")).toBe("Pragma order");
  });
});

// A note is created without an extension, and the server gives it .md.
describe("pendingFileType", () => {
  it("gives a note being made Markdown's class, a template its own, and any other kind its name", () => {
    expect(pendingFileType({ parentPath: "film", type: "file" })).toBe("markdown");
    expect(pendingFileType({ parentPath: "film", type: "file", kind: "note" })).toBe("markdown");
    expect(pendingFileType({ parentPath: "film", type: "file", kind: "table" })).toBe("table");
    const template = (path: string) => ({
      parentPath: "film",
      type: "file" as const,
      template: { path, label: "Shots" },
    });
    expect(pendingFileType(template("_templates/Shots.table.html"))).toBe("table");
    expect(pendingFileType(template("_templates/Shots.txt"))).toBeUndefined();
  });
});

// A dragged picture of an entry carries the browser's copy of its bytes too.
describe("the files a drag brings from the desktop", () => {
  const png = new File([new Uint8Array(8)], "shot.png", { type: "image/png" });
  const entry = { "text/plain": "stills/a.png", [DRAGGED_ENTRY_TYPE]: "file" };
  const desktop = () => fakeDrag("drop", { files: [png] }).event;
  const picture = () => fakeDrag("drop", { data: entry, files: [png] }).event;

  it("are a desktop drop's files, and never a dragged entry's", () => {
    expect([carriesDesktopFiles(desktop()), desktopFiles(desktop())]).toEqual([true, [png]]);
    expect([carriesDesktopFiles(picture()), desktopFiles(picture())]).toEqual([false, []]);
  });

  it("are all a confined tree takes", () => {
    expect([treeTakesDrag(desktop(), true), treeTakesDrag(picture(), true)]).toEqual([true, false]);
    expect([treeTakesDrag(desktop(), false), treeTakesDrag(picture(), false)]).toEqual([true, true]);
  });
});

describe("wireEntryDrag", () => {
  // Only its listeners are under test, so any event target stands in.
  const wired = (entry: Pick<FolderEntry, "path" | "type"> | undefined) => {
    const source = new EventTarget() as HTMLElement;
    wireEntryDrag(source, () => entry);
    return source;
  };

  it("writes the entry it finds, and clears it from the drag in flight once the drag ends", () => {
    const source = wired({ path: "stills/a.png", type: "file" });
    expect([...fireDrag(source, "dragstart")]).toEqual([
      ["text/plain", "stills/a.png"],
      [DRAGGED_ENTRY_TYPE, "file"],
    ]);
    expect(draggedPathInFlight()?.path).toBe("stills/a.png");
    fireDrag(source, "dragend");
    expect(draggedPathInFlight()).toBeUndefined();
  });

  it("leaves a drag claimed before it, or one it finds no entry for, unwritten", () => {
    expect(fireDrag(wired({ path: "stills/a.png", type: "file" }), "dragstart", true).size).toBe(0);
    expect(fireDrag(wired(undefined), "dragstart").size).toBe(0);
  });
});
