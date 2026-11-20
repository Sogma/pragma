// @vitest-environment jsdom
import { type Completion, CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileResponse } from "../../web/core/apiClient.ts";
import { setPresets } from "../../web/core/presets.ts";
import { wikilinkCompletion, wikilinkSource } from "../../web/wikilinkCompletion.ts";
import { wikilinkSyntax } from "../../web/wikilinkSyntax.ts";
import { polyfillRangeRects } from "./support/codemirrorJsdom.ts";

polyfillRangeRects();

const FILES = [
  "projects/a/README.md",
  "projects/a/scenes/one.md",
  "projects/a/scenes/two.md",
  "projects/a/cast/bob.md",
  "projects/a/cast/draft [old].md",
  "projects/a/shot.png",
  "projects/b/README.md",
  "projects/b/bob.md",
  "loose.md",
  "_templates/Meeting.md",
];
const FOLDERS = ["projects", "projects/a", "projects/a/scenes", "projects/a/cast", "projects/b", "_templates"];
// Both projects open a scope, so `projects/a` and `projects/b` link each
// other from the root.
const SCOPES = new Set(["projects/a", "projects/b"]);

const views: EditorView[] = [];
afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

function note(content: string): FileResponse {
  return { kind: "text", path: "", revision: "", content, documentType: "note", toolkits: [], classLinks: [] };
}

interface Options {
  writesWikilinks?: boolean;
  files?: string[];
  libraryFiles?: string[];
}

// `^` in `doc` marks the cursor.
function setup(
  doc: string,
  titles: Record<string, string> = {},
  docPath = "projects/a/scenes/one.md",
  { writesWikilinks = true, files = FILES, libraryFiles = [] }: Options = {},
) {
  const loadFile = vi.fn(async (address: string) => note(titles[address] ?? ""));
  const deps = {
    docPath: () => docPath,
    scope: (path: string) => ({ docPath: path, files, folders: FOLDERS, scopes: SCOPES }),
    libraryFiles: async () => libraryFiles,
    loadFile,
    writesWikilinks: () => writesWikilinks,
  };
  const cursor = doc.indexOf("^");
  const view = new EditorView({
    state: EditorState.create({
      doc: doc.replace("^", ""),
      selection: { anchor: cursor },
      extensions: [markdown({ extensions: wikilinkSyntax }), wikilinkCompletion(deps)],
    }),
    parent: document.body,
  });
  views.push(view);
  const result = () => wikilinkSource(deps)(new CompletionContext(view.state, view.state.selection.main.head, false));
  return { view, result, loadFile };
}

async function pick(view: EditorView, result: Promise<CompletionResult | null>, label: string, detail?: string) {
  const options = (await result)?.options ?? [];
  const option = options.find((o) => o.label === label && (detail === undefined || o.detail === detail));
  if (!option || typeof option.apply !== "function") throw new Error(`no option ${label}`);
  option.apply(view, option as Completion, (await result)?.from ?? 0, view.state.selection.main.head);
}

const listed = async (result: Promise<CompletionResult | null>) =>
  (await result)?.options.map((o) => `${o.detail ?? "(here)"}: ${o.label}`) ?? [];

describe("when the suggester opens", () => {
  it("opens on `[[` and on a target being typed", async () => {
    expect((await setup("see [[^").result())?.from).toBe(6);
    expect((await setup("see [[bo^]]").result())?.from).toBe(6);
  });

  it("stays closed outside a link's target half", async () => {
    expect(await setup("see [^").result()).toBeNull();
    expect(await setup("see [[a|b^]]").result()).toBeNull();
    expect(await setup("see [[a]] ^").result()).toBeNull();
  });

  it("stays closed inside code", async () => {
    expect(await setup("`[[^`").result()).toBeNull();
    expect(await setup("```\n[[^\n```").result()).toBeNull();
  });
});

describe("what it offers", () => {
  it("lists the document's folder, then its scope, files before folders, never the document itself", async () => {
    const labels = await listed(setup("[[^").result());
    expect(labels.slice(0, 4)).toEqual([
      "(here): two",
      "projects/a: shot",
      "projects/a: README",
      "projects/a/cast: bob",
    ]);
    expect(labels).toContain("projects: a/");
    expect(labels).not.toContain("(here): one");
  });

  // A name beside the note needs no folder; a root one shows `/`, or it
  // would read as beside the note too.
  it("shows the folder only for an entry outside the note's own", async () => {
    const options = (await setup("[[^").result())?.options ?? [];
    expect(options.find((o) => o.label === "two")?.detail).toBeUndefined();
    expect(options.find((o) => o.label === "loose")?.detail).toBe("/");
  });

  it("ranks the scope's match above an equal one elsewhere", async () => {
    const options = (await setup("[[bob^").result())?.options;
    expect(options?.map((o) => o.detail)).toEqual(["projects/a/cast", "projects/b"]);
  });

  it("offers folders, named with their `/`, a name match first", async () => {
    expect(await listed(setup("[[cast^").result())).toEqual(["projects/a: cast/", "projects/a/cast: bob"]);
  });

  it("leaves out an entry whose name a wikilink can't hold", async () => {
    expect((await setup("[[draft^").result())?.options).toEqual([]);
  });

  // The space's content never links into a preset.
  it("leaves a listed preset folder's files out, unless the document is among them", async () => {
    setPresets({ folders: [{ kind: "templates", written: "_templates/", path: "_templates" }] });
    try {
      expect((await setup("[[meeting^").result())?.options).toEqual([]);
      const amongThem = (await setup("[[meeting^", {}, "_templates/Agenda.md").result())?.options;
      expect(amongThem?.map((o) => o.label)).toEqual(["Meeting"]);
    } finally {
      setPresets({ folders: [] });
    }
  });

  it("matches by name past a typed `./`, `../` or `/`", async () => {
    expect((await setup("[[../bob^").result())?.options.map((o) => o.detail)).toEqual([
      "projects/a/cast",
      "projects/b",
    ]);
    expect((await setup("[[/bob^").result())?.options.map((o) => o.detail)).toEqual(["projects/a/cast", "projects/b"]);
  });

  it("offers a space document the libraries' files, and a library document none", async () => {
    const libraryFiles = ["lib:footage/stills/bob.png"];
    const fromSpace = await listed(setup("[[bob^", {}, undefined, { libraryFiles }).result());
    expect(fromSpace).toContain("lib:footage/stills: bob");
    const fromLibrary = await listed(setup("[[bob^", {}, "lib:footage/notes/x.md", { libraryFiles }).result());
    expect(fromLibrary).not.toContain("lib:footage/stills: bob");
  });
});

describe("what a pick writes", () => {
  it("writes an entry in the note's scope relative and closes the link", async () => {
    const { view, result } = setup("see [[bo^ more");
    await pick(view, result(), "bob", "projects/a/cast");

    expect(view.state.doc.toString()).toBe("see [[../cast/bob]] more");
    expect(view.state.selection.main.head).toBe("see [[../cast/bob]]".length);
  });

  it("consumes the closing brackets already there", async () => {
    const { view, result } = setup("[[bo^]] after");
    await pick(view, result(), "bob", "projects/a/cast");

    expect(view.state.doc.toString()).toBe("[[../cast/bob]] after");
  });

  it("adds the title as display text once it loads, when it differs from the name", async () => {
    const { view, result } = setup("[[^", { "projects/a/cast/bob.md": "# Bob Smith\n" });
    await pick(view, result(), "bob", "projects/a/cast");

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("[[../cast/bob|Bob Smith]]"));
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("writes no display text when the title is the name", async () => {
    const { view, result, loadFile } = setup("[[^", { "projects/a/cast/bob.md": "# bob\n" });
    await pick(view, result(), "bob", "projects/a/cast");

    await vi.waitFor(() => expect(loadFile).toHaveBeenCalled());
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("[[../cast/bob]]");
  });

  it("writes an entry in another scope from the root, always piped", async () => {
    const { view, result } = setup("[[^");
    await pick(view, result(), "bob", "projects/b");

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("[[/projects/b/bob|bob]]"));
  });

  it("writes a folder with its `/`", async () => {
    const { view, result } = setup("[[cast^");
    await pick(view, result(), "cast/");
    expect(view.state.doc.toString()).toBe("[[../cast/]]");
  });

  it("names a library file outright", async () => {
    const { view, result } = setup("[[bob^", {}, undefined, { libraryFiles: ["lib:footage/stills/bob.png"] });
    await pick(view, result(), "bob", "lib:footage/stills");
    expect(view.state.doc.toString()).toBe("[[lib:footage/stills/bob.png|bob]]");
  });

  it("reads no title from a file that has none", async () => {
    const { view, result, loadFile } = setup("[[^");
    await pick(view, result(), "shot", "projects/a");

    await Promise.resolve();
    expect(loadFile).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe("[[../shot.png]]");
  });

  it("keeps display text the link already has", async () => {
    const { view, result, loadFile } = setup("[[bo^|Bob]]");
    await pick(view, result(), "bob", "projects/a/cast");

    expect(view.state.doc.toString()).toBe("[[../cast/bob|Bob]]");
    expect(loadFile).not.toHaveBeenCalled();
  });

  it("lands the title where the link went, through text typed meanwhile", async () => {
    const { view, result } = setup("[[^", { "projects/a/cast/bob.md": "# Bob Smith\n" });
    await pick(view, result(), "bob", "projects/a/cast");
    view.dispatch({ changes: { from: 0, insert: "Hi " } });

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("Hi [[../cast/bob|Bob Smith]]"));
  });

  it("drops the title if the link was edited before it loaded", async () => {
    const { view, result, loadFile } = setup("[[^", { "projects/a/cast/bob.md": "# Bob Smith\n" });
    await pick(view, result(), "bob", "projects/a/cast");
    view.dispatch({ changes: { from: 2, to: 13, insert: "x" } });

    await vi.waitFor(() => expect(loadFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    expect(view.state.doc.toString()).toBe("[[x]]");
  });
});

describe("a file of no kind", () => {
  const files = [...FILES, "projects/a/scenes/budget.csv"];

  it("is offered under its full name, and linked by its path", async () => {
    const { view, result } = setup("[[budg^", {}, undefined, { files });
    expect((await result())?.options.map((o) => o.label)).toEqual(["budget.csv"]);
    await pick(view, result(), "budget.csv");

    expect(view.state.doc.toString()).toBe("[[budget.csv]]");
  });
});

describe("what a pick writes with wikilinks off", () => {
  const markdownLinks = { writesWikilinks: false };

  it("writes a Markdown link by the same rule, `.md` kept, named for the file", async () => {
    const { view, result } = setup("see [[bo^ more", {}, undefined, markdownLinks);
    await pick(view, result(), "bob", "projects/b");

    expect(view.state.doc.toString()).toBe("see [bob](/projects/b/bob.md) more");
    expect(view.state.selection.main.head).toBe("see [bob](/projects/b/bob.md)".length);
  });

  it("consumes the closing brackets already there", async () => {
    const { view, result } = setup("[[bo^]] after", {}, undefined, markdownLinks);
    await pick(view, result(), "bob", "projects/a/cast");

    expect(view.state.doc.toString()).toBe("[bob](../cast/bob.md) after");
  });

  it("names the link for the title once it loads", async () => {
    const { view, result } = setup("[[^", { "projects/a/cast/bob.md": "# Bob Smith\n" }, undefined, markdownLinks);
    await pick(view, result(), "bob", "projects/a/cast");

    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("[Bob Smith](../cast/bob.md)"));
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("keeps display text the link already has as the link's text", async () => {
    const { view, result, loadFile } = setup("[[bo^|Bob]] after", {}, undefined, markdownLinks);
    await pick(view, result(), "bob", "projects/a/cast");

    expect(view.state.doc.toString()).toBe("[Bob](../cast/bob.md) after");
    expect(loadFile).not.toHaveBeenCalled();
  });

  it("drops the title if the link was edited before it loaded", async () => {
    const { view, result, loadFile } = setup("[[^", { "projects/a/cast/bob.md": "# Bob Smith\n" }, undefined, {
      writesWikilinks: false,
    });
    await pick(view, result(), "bob", "projects/a/cast");
    view.dispatch({ changes: { from: 1, to: 4, insert: "Robert" } });

    await vi.waitFor(() => expect(loadFile).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve));
    expect(view.state.doc.toString()).toBe("[Robert](../cast/bob.md)");
  });

  it("writes a folder with its `/`, encoded", async () => {
    const { view, result } = setup("[[cast^", {}, undefined, markdownLinks);
    await pick(view, result(), "cast/");
    expect(view.state.doc.toString()).toBe("[cast](../cast/)");
  });
});
