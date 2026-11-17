// @vitest-environment jsdom
// jsdom because splitting off the properties lifts the leading heading
// through markdownRender.ts, which builds a DOM node to do it.
import { ChangeSet, Text } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import type { FileResponse, SavedDocumentDates, TextFileResponse } from "../../../web/core/apiClient.ts";
import { createDocuments, type DocumentEvent } from "../../../web/services/documents.ts";
import type { SaveQueue } from "../../../web/services/saveQueue.ts";

type Scheduled = { path: string; content: string; onWritten?: (dates: SavedDocumentDates | undefined) => void };

// Nothing scheduled here is ever written, so a path once scheduled stays
// unsettled for the rest of the test.
function fakeQueue(): SaveQueue & { scheduled: Scheduled[] } {
  const scheduled: Scheduled[] = [];
  const revisions = new Map<string, string>();
  const busy = (path: string) => scheduled.some((entry) => entry.path === path);
  return {
    scheduled,
    schedule: (path, content, onWritten) => void scheduled.push({ path, content, onWritten }),
    flush: vi.fn(async () => true),
    hasPending: () => scheduled.length > 0,
    pendingContent: (path) => scheduled.findLast((entry) => entry.path === path)?.content,
    state: () => ({ failedPaths: [], conflictPaths: [] }),
    subscribe: () => () => {},
    noteRevision: vi.fn<SaveQueue["noteRevision"]>((path, revision) => {
      if (!busy(path)) revisions.set(path, revision);
    }),
    settledRevision: (path) => (busy(path) ? undefined : revisions.get(path)),
    resolveConflict: vi.fn(),
    move: vi.fn(),
    pause: () => () => {},
    rebase: vi.fn(async () => {}),
    saveNow: vi.fn(async () => true),
  };
}

function noteFile(overrides: Partial<TextFileResponse> = {}): TextFileResponse {
  return {
    kind: "text",
    path: "notes/song.md",
    revision: "rev-1",
    documentType: "note",
    content: "---\ntags:\n  - a\n---\n\n# Song\n\nfirst line\n",
    toolkits: [],
    classLinks: [],
    ...overrides,
  };
}

function setup(file: TextFileResponse = noteFile(), fetched?: FileResponse) {
  const queue = fakeQueue();
  const fetchFile = vi.fn(async () => fetched ?? file);
  const documents = createDocuments({ queue, fetchFile });
  return { documents, queue, fetchFile };
}

describe("createDocuments", () => {
  it("splits a note into body, frontmatter, title, and line offset", () => {
    const { documents } = setup();
    const model = documents.adopt(noteFile());

    expect(model.body()).toBe("first line\n");
    expect(model.properties()).toEqual({ tags: ["a"] });
    expect(model.title()).toEqual({ text: "Song", placeholder: "song" });
    expect(model.lineOffset()).toBe(7);
    expect(model.content()).toBe("---\ntags:\n  - a\n---\n\n# Song\n\nfirst line\n");
  });

  it("keeps a screenplay whole: no frontmatter, no title", () => {
    const { documents } = setup();
    const model = documents.adopt(noteFile({ path: "s.fountain", documentType: "screenplay", content: "INT. ROOM\n" }));

    expect(model.body()).toBe("INT. ROOM\n");
    expect(model.properties()).toBeUndefined();
    expect(model.title()).toBeUndefined();
    expect(model.lineOffset()).toBe(0);
  });

  it("setBody schedules a save of the recomposed file and notifies", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());
    const seen: string[] = [];
    model.subscribe((event) => seen.push(event.kind));

    model.setBody("second line\n");
    model.setBody("second line\n"); // unchanged: nothing scheduled

    expect(queue.scheduled).toHaveLength(1);
    expect(queue.scheduled[0]).toMatchObject({ path: "notes/song.md" });
    expect(queue.scheduled[0].content).toBe("---\ntags:\n  - a\n---\n\n# Song\n\nsecond line\n");
    expect(seen).toEqual(["body"]);
  });

  it("applyBodyChanges applies a change set against the body, saves, and announces it with its origin", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());
    const seen: DocumentEvent[] = [];
    model.subscribe((event) => seen.push(event));
    const origin = {};

    model.applyBodyChanges(ChangeSet.of({ from: 0, insert: "0 " }, model.bodyText().length), {
      origin,
      userEvent: "input.type",
    });

    expect(model.body()).toBe("0 first line\n");
    expect(model.bodyText().toString()).toBe("0 first line\n");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "body", origin, userEvent: "input.type" });
    expect(queue.scheduled.at(-1)?.content).toBe("---\ntags:\n  - a\n---\n\n# Song\n\n0 first line\n");
  });

  it("refuses a change set built against a body of another length", () => {
    const { documents } = setup();
    const model = documents.adopt(noteFile());
    expect(() => model.applyBodyChanges(ChangeSet.of({ from: 0, insert: "x" }, 3))).toThrow(/can't apply/);
    expect(model.body()).toBe("first line\n");
  });

  it("setBody is one whole-body change", () => {
    const { documents } = setup();
    const model = documents.adopt(noteFile());
    const seen: DocumentEvent[] = [];
    model.subscribe((event) => seen.push(event));

    model.setBody("replaced\n", "me");

    expect(seen[0]).toMatchObject({ kind: "body", origin: "me" });
    const change = seen[0].kind === "body" ? seen[0].changes : undefined;
    expect(change?.length).toBe("first line\n".length);
    expect(change?.newLength).toBe("replaced\n".length);
    expect(model.body()).toBe("replaced\n");
  });

  it("saves a body edit with the heading as the file held it, and counts its own lines", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content: "A long\ntitle\n===\nfirst line\n" }));

    model.setBody("second line\n");
    expect(queue.scheduled.at(-1)?.content).toBe("A long\ntitle\n===\nsecond line\n");

    const properties = model.properties() as Record<string, unknown>;
    properties.mood = "blue";
    model.notePropertiesChanged();
    expect(queue.scheduled.at(-1)?.content).toBe("---\nmood: blue\n---\n\nA long\ntitle\n===\nsecond line\n");
    expect(model.lineOffset()).toBe(7);
  });

  it("saves the blank lines the file has after its block, and one after a block made anew", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content: "---\ntags:\n  - a\n---\n# Song\nfirst line\n" }));
    expect(model.lineOffset()).toBe(5);

    model.setBody("second line\n");
    expect(queue.scheduled.at(-1)?.content).toBe("---\ntags:\n  - a\n---\n# Song\nsecond line\n");

    const properties = model.properties() as Record<string, unknown>;
    delete properties.tags;
    model.notePropertiesChanged();
    expect(queue.scheduled.at(-1)?.content).toBe("# Song\nsecond line\n");
    properties.mood = "blue";
    model.notePropertiesChanged();
    expect(queue.scheduled.at(-1)?.content).toBe("---\nmood: blue\n---\n\n# Song\nsecond line\n");
    expect(model.lineOffset()).toBe(5);
  });

  it("a title edit moves the line offset only when the heading appears or disappears", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());

    model.setTitleText("Song 2");
    expect(model.lineOffset()).toBe(7);
    model.setTitleText("");
    expect(model.lineOffset()).toBe(5);
    expect(queue.scheduled.at(-1)?.content).toBe("---\ntags:\n  - a\n---\n\nfirst line\n");
  });

  it("in-place property edits are announced through notePropertiesChanged", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());
    const properties = model.properties() as Record<string, unknown>;

    properties.mood = "blue";
    model.notePropertiesChanged();

    expect(model.lineOffset()).toBe(8);
    expect(queue.scheduled.at(-1)?.content).toContain("mood: blue");
  });

  it("folds the server's dates into the frontmatter after a write", () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());
    const seen: string[] = [];
    model.subscribe((event) => seen.push(event.kind));

    model.setBody("x");
    queue.scheduled[0].onWritten?.({ created: "2026-09-10", updated: "2026-09-11" });

    expect(model.properties()).toMatchObject({ created: "2026-09-10", updated: "2026-09-11" });
    expect(model.content()).toBe("---\ntags:\n  - a\ncreated: 2026-09-10\nupdated: 2026-09-11\n---\n\n# Song\n\nx");
    expect(seen).toEqual(["body", "saved"]);
  });

  it("writes the frontmatter back as it was when only the body changed", () => {
    const content = "---\n# shot metadata\nstatus: draft   # wip\ntags: [shot, night]\n---\n\n# Song\n\nfirst line\n";
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content }));

    model.setBody("second line\n");

    expect(queue.scheduled.at(-1)?.content).toBe(content.replace("first", "second"));
  });

  it("rewrites only the property that changed, and renames a key where it stands", () => {
    const content = "---\n# shot metadata\nstatus: draft   # wip\ntags: [shot, night]\n---\n\nfirst line\n";
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content }));
    const properties = model.properties() as Record<string, unknown>;

    properties.status = "approved";
    model.notePropertiesChanged();
    expect(queue.scheduled.at(-1)?.content).toBe(content.replace("draft", "approved"));

    // Renamed as the property editor renames: the object refilled in order.
    const renamed = Object.entries(properties).map(([key, value]) => [key === "tags" ? "labels" : key, value]);
    for (const key of Object.keys(properties)) delete properties[key];
    Object.assign(properties, Object.fromEntries(renamed));
    model.notePropertiesChanged();
    expect(queue.scheduled.at(-1)?.content).toBe(content.replace("draft", "approved").replace("tags:", "labels:"));
  });

  it("moves a property's lines, its comment with them, when only the order changed", () => {
    const content = "---\nstatus: draft   # wip\n# the night shoot\ntags: [shot, night]\n---\n\nfirst line\n";
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content }));
    const properties = model.properties() as Record<string, unknown>;

    // Moved as the property editor moves one: the object refilled in order.
    const moved = { tags: properties.tags, status: properties.status };
    for (const key of Object.keys(properties)) delete properties[key];
    Object.assign(properties, moved);
    model.notePropertiesChanged();

    expect(queue.scheduled.at(-1)?.content).toBe(
      "---\n# the night shoot\ntags: [shot, night]\nstatus: draft   # wip\n---\n\nfirst line\n",
    );
  });

  it("keeps a block that doesn't parse in the body, private, and saves the text as typed", async () => {
    const content = "---\ntitle: Chapter 1: The Start\n---\n\n# Chapter 1\n\nfirst line\n";
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content }));

    expect(model.body()).toBe(content);
    expect(model.properties()).toBeUndefined();
    expect(model.title()).toBeUndefined();
    expect(model.lineOffset()).toBe(0);
    expect(model.frontmatterError()).toBe("line 2: Nested mappings are not allowed in compact mappings");
    expect(model.isPrivate()).toBe(true);

    model.setBody(content.replace("first", "second"));
    expect(queue.scheduled.at(-1)?.content).toBe(content.replace("first", "second"));
    await expect(documents.editProperties("notes/song.md", () => {})).rejects.toThrow(
      "frontmatter isn't valid YAML (line 2: Nested mappings are not allowed in compact mappings)",
    );
  });

  it("answers whether it's private from its properties when its block parses", () => {
    const { documents } = setup();
    expect(documents.adopt(noteFile()).isPrivate()).toBe(false);
    expect(documents.adopt(noteFile({ path: "p.md", content: "---\nvisibility: private\n---\nx" })).isPrivate()).toBe(
      true,
    );
    expect(documents.adopt(noteFile({ path: "s.fountain", documentType: "screenplay" })).isPrivate()).toBe(false);
  });

  it("counts the block's comment lines into the line offset after a property edit", () => {
    const { documents } = setup();
    const model = documents.adopt(noteFile({ content: "---\n# shot metadata\nstatus: draft\n---\n\nfirst line\n" }));
    expect(model.lineOffset()).toBe(5);

    (model.properties() as Record<string, unknown>).status = "approved";
    model.notePropertiesChanged();

    expect(model.lineOffset()).toBe(5);
  });

  it("shares one model per path and forgets it on the last release, flushing first", async () => {
    const { documents, queue } = setup();
    const first = documents.adopt(noteFile());
    first.setBody("edited\n");
    const second = documents.adopt(noteFile()); // a fresh fetch must not clobber the edit

    expect(second).toBe(first);
    expect(documents.get("notes/song.md")?.body()).toBe("edited\n");

    await documents.release("notes/song.md");
    expect(documents.get("notes/song.md")).toBe(first);
    await documents.release("notes/song.md");
    expect(documents.get("notes/song.md")).toBeUndefined();
    expect(queue.flush).toHaveBeenCalledWith("notes/song.md");
  });

  // Reopening a file whose save hasn't landed: the queue is still holding
  // content newer than anything on disk, so building the model from the
  // fetch would hand the next keystroke a stale base — and latest-wins would
  // then discard the queued content, losing the edit through the very queue
  // that was keeping it safe.
  it("builds a reopened model from content the queue hasn't written yet", async () => {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile());
    model.setBody("still unwritten\n");
    await documents.release("notes/song.md");
    expect(documents.get("notes/song.md")).toBeUndefined();

    // The fetch returns what is actually on disk, which is the older copy.
    const reopened = documents.adopt(noteFile());

    expect(reopened.body()).toBe("still unwritten\n");
    expect(queue.pendingContent("notes/song.md")).toContain("still unwritten");
  });

  it("builds from the fetch when the queue holds nothing for that path", async () => {
    const { documents } = setup();

    expect(documents.adopt(noteFile()).body()).toBe("first line\n");
  });

  it("reloadPaths() re-reads only open models and reports the ones that can't be read", async () => {
    const { documents, fetchFile } = setup();
    documents.adopt(noteFile());
    fetchFile.mockRejectedValueOnce(new Error("404"));

    expect(await documents.reloadPaths(["notes/song.md", "notes/never-opened.md"])).toEqual(["notes/song.md"]);
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it("reload() replaces a settled working copy from disk and reports a kind change", async () => {
    const { documents, fetchFile } = setup();
    const model = documents.adopt(noteFile());
    fetchFile.mockResolvedValueOnce(
      noteFile({ revision: "rev-2", content: "# New\n\nfrom disk\n", toolkits: [], classLinks: [] }),
    );

    expect(await model.reload()).toBe(true);
    expect(model.body()).toBe("from disk\n");
    expect(model.title()?.text).toBe("New");

    fetchFile.mockResolvedValueOnce({ kind: "table", path: "notes/song.md" } as FileResponse);
    expect(await model.reload()).toBe(false);
    expect(model.body()).toBe("from disk\n");
  });

  it("reload() reads nothing in while an edit is on its way to disk, or disk still holds the copy's revision", async () => {
    const { documents, fetchFile } = setup();
    const model = documents.adopt(noteFile());
    const events: DocumentEvent[] = [];
    model.subscribe((event) => events.push(event));

    fetchFile.mockResolvedValueOnce(noteFile({ content: "# Song\n\nunchanged revision\n" }));
    expect(await model.reload()).toBe(true);
    expect(model.body()).toBe("first line\n");

    model.setBody("local edit\n");
    fetchFile.mockResolvedValueOnce(noteFile({ revision: "rev-2", content: "# New\n\nfrom disk\n" }));
    expect(await model.reload()).toBe(true);
    expect(model.body()).toBe("local edit\n");
    expect(events.map((event) => event.kind)).toEqual(["body"]);
  });

  it("move() re-keys a file and everything under a folder, and a rename updates the title placeholder", () => {
    const { documents } = setup();
    const song = documents.adopt(noteFile());
    const other = documents.adopt(noteFile({ path: "notes/other.md" }));
    documents.adopt(noteFile({ path: "elsewhere.md" }));
    const events: DocumentEvent["kind"][] = [];
    song.subscribe((event) => events.push(event.kind));

    documents.move("notes", "archive/notes");

    expect(song.path).toBe("archive/notes/song.md");
    expect(other.path).toBe("archive/notes/other.md");
    expect(documents.get("archive/notes/song.md")).toBe(song);
    expect(documents.get("notes/song.md")).toBeUndefined();
    expect(documents.get("elsewhere.md")).toBeDefined();
    expect(events).toEqual([]);

    documents.move("archive/notes/song.md", "archive/notes/ballad.md");
    expect(song.title()?.placeholder).toBe("ballad");
    expect(events).toEqual(["title"]);
  });

  it("editProperties edits a note nothing has open, saves it, and keeps no model", async () => {
    const { documents, queue, fetchFile } = setup();
    await documents.editProperties("notes/song.md", (properties) => {
      properties.description = "A short one.";
    });

    expect(fetchFile).toHaveBeenCalledWith("notes/song.md");
    expect(queue.scheduled.at(-1)?.content).toBe(
      "---\ntags:\n  - a\ndescription: A short one.\n---\n\n# Song\n\nfirst line\n",
    );
    expect(queue.flush).toHaveBeenCalledWith("notes/song.md");
    expect(documents.get("notes/song.md")).toBeUndefined();
  });

  it("editProperties edits an open note's live model, unsaved edits and all, and tells its views", async () => {
    const { documents, queue, fetchFile } = setup();
    const model = documents.adopt(noteFile());
    model.setBody("edited line\n");
    const events: DocumentEvent["kind"][] = [];
    model.subscribe((event) => events.push(event.kind));

    await documents.editProperties("notes/song.md", (properties) => {
      properties.description = "A short one.";
    });

    expect(fetchFile).not.toHaveBeenCalled();
    expect(events).toContain("properties");
    expect(queue.scheduled.at(-1)?.content).toContain("description: A short one.\n---\n\n# Song\n\nedited line\n");
    expect(documents.get("notes/song.md")).toBe(model);
  });
});

describe("a note edited whole, as Source mode edits it", () => {
  // The model and a recorder of what it tells its views.
  function edited(content = noteFile().content) {
    const { documents, queue } = setup();
    const model = documents.adopt(noteFile({ content }));
    const events: DocumentEvent[] = [];
    model.subscribe((event) => events.push(event));
    // An edit at `from` of the whole file, as a view holding all of it makes one.
    const edit = (from: number, to: number, insert: string) =>
      model.applyContentChanges(ChangeSet.of({ from, to, insert }, model.content().length), { origin: "source" });
    return { model, queue, events, edit, kinds: () => events.map((event) => event.kind) };
  }

  it("holds the file as its head and its body", () => {
    const { model } = edited();
    expect(model.head()).toBe("---\ntags:\n  - a\n---\n\n# Song\n\n");
    expect(model.head() + model.body()).toBe(model.content());
  });

  it("takes a keystroke in the body as a change to the body, the head left as it was", () => {
    const { model, queue, events, edit } = edited();
    const at = model.content().indexOf("line");
    edit(at, at, "new ");
    expect(model.body()).toBe("first new line\n");
    // A change against the body as it was, which a formatted view applies as is.
    expect(events).toEqual([expect.objectContaining({ kind: "body", origin: "source" })]);
    const [event] = events;
    if (event.kind !== "body") throw new Error("not a body change");
    expect(event.changes.apply(Text.of(["first line", ""])).toString()).toBe("first new line\n");
    expect(queue.scheduled.at(-1)?.content).toBe("---\ntags:\n  - a\n---\n\n# Song\n\nfirst new line\n");
  });

  it("reads the properties and the title again from an edit to the head", () => {
    const { model, edit, kinds } = edited();
    const tag = model.content().indexOf("- a") + 2;
    edit(tag, tag + 1, "b");
    expect(model.properties()).toEqual({ tags: ["b"] });
    expect(kinds()).toEqual(["properties"]);

    const title = model.content().indexOf("Song");
    edit(title, title + 4, "Tune");
    expect(model.title()?.text).toBe("Tune");
    expect(model.body()).toBe("first line\n");
    expect(kinds()).toEqual(["properties", "title"]);
  });

  it("lifts a title typed above a body that had none, the body losing that line", () => {
    const { model, edit, kinds } = edited("words\n\nmore\n");
    edit(0, 0, "# ");
    expect(model.title()?.text).toBe("words");
    expect(model.body()).toBe("more\n");
    expect(kinds()).toEqual(["body", "title"]);
    expect(model.content()).toBe("# words\n\nmore\n");
  });

  // The editor holds what the user typed, so the file must come back exactly
  // that, or its next edit lands on text the editor doesn't show.
  it("composes back to exactly the text edited, even text a save from parts would change", () => {
    const { model, edit } = edited("");
    for (const [from, insert] of [
      [0, "---\ntags: [a]\n---"],
      [17, "\n"],
      [18, "\n\nbody"],
      [0, "\n"],
    ] as const) {
      const before = model.content();
      edit(from, from, insert);
      expect(model.content()).toBe(before.slice(0, from) + insert + before.slice(from));
    }
    // A blank line above it, the block is text again, the line its gap.
    expect(model.properties()).toEqual({});
    expect(model.body()).toBe("---\ntags: [a]\n---\n\n\nbody");
  });

  it("keeps the blank lines a note with no block opens with when it is saved", () => {
    const { model } = edited("\n\n# Low\n\nbody");
    expect(model.title()?.text).toBe("Low");
    expect(model.content()).toBe("\n\n# Low\n\nbody");
  });
});
