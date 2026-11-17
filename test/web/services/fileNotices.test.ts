import { describe, expect, it, vi } from "vitest";
import { createFileNotices, type NoticesByPath } from "../../../web/services/fileNotices.ts";

interface Written {
  level: string;
  content: string;
  reveal: ReturnType<typeof vi.fn<() => boolean>>;
  kept: ReturnType<typeof vi.fn<() => boolean>>;
}

function setup() {
  const entries: Written[] = [];
  const showConsole = vi.fn();
  const notices = createFileNotices({
    log: (level, _kind, _label, content) => {
      const entry = { level, content, reveal: vi.fn(() => true), kept: vi.fn(() => true) };
      entries.push(entry);
      return entry;
    },
    showConsole,
  });
  let published: NoticesByPath = new Map();
  notices.subscribe((next) => {
    published = next;
  });
  // Clear empties the Console of every entry written so far.
  const clear = () => {
    for (const entry of entries) {
      entry.kept.mockReturnValue(false);
      entry.reveal.mockReturnValue(false);
    }
  };
  return { notices, entries, showConsole, clear, published: () => published };
}

const note = (content: string, count = 1) => ({ level: "info" as const, kind: "VIDEO", label: "Clip", content, count });

describe("fileNotices", () => {
  it("logs a file's problems once, not again when it reopens with them or one is fixed", () => {
    const { notices, entries, published } = setup();
    notices.reportProblems("a.flow.html", ["one", "two"]);
    expect(entries.map((entry) => entry.content)).toEqual(["one\ntwo"]);
    expect(published().get("a.flow.html")).toEqual({ error: 0, warn: 2, info: 0 });

    notices.reportProblems("a.flow.html", ["one", "two"]);
    notices.reportProblems("a.flow.html", ["two"]);
    expect(entries).toHaveLength(1);
    expect(published().get("a.flow.html")?.warn).toBe(1);

    notices.reportProblems("a.flow.html", ["two", "three"]);
    expect(entries.map((entry) => entry.content)).toEqual(["one\ntwo", "two\nthree"]);

    notices.reportProblems("a.flow.html", []);
    expect(published().has("a.flow.html")).toBe(false);
  });

  it("reveals the latest problems entry while it lists what's wrong now, else writes a fresh one", () => {
    const { notices, entries, showConsole, clear } = setup();
    notices.reportProblems("a.flow.html", ["one", "two"]);
    notices.reveal("a.flow.html", "warn");
    expect(showConsole).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(1);
    expect(entries[0].reveal).toHaveBeenCalledTimes(1);

    notices.reportProblems("a.flow.html", ["two"]);
    notices.reveal("a.flow.html", "warn");
    expect(entries.map((entry) => entry.content)).toEqual(["one\ntwo", "two"]);
    expect(entries[1].reveal).toHaveBeenCalledTimes(1);

    clear();
    notices.reveal("a.flow.html", "warn");
    expect(entries.map((entry) => entry.content)).toEqual(["one\ntwo", "two", "two"]);
    expect(entries[2].reveal).toHaveBeenCalledTimes(1);
  });

  it("counts each source's notices by level, and a source beginning again drops only its own", () => {
    const { notices, entries, published } = setup();
    notices.reportProblems("a.flow.html", ["one"]);
    notices.begin("a.flow.html", "run");
    notices.add("a.flow.html", "run", note("mode: used omni_reference", 2));
    notices.add("a.flow.html", "toolkit", { ...note("The call failed."), level: "error" });
    expect(entries).toHaveLength(3);
    expect(published().get("a.flow.html")).toEqual({ error: 1, warn: 1, info: 2 });

    notices.begin("a.flow.html", "run");
    expect(published().get("a.flow.html")).toEqual({ error: 1, warn: 1, info: 0 });
    notices.begin("a.flow.html", "toolkit");
    notices.reportProblems("a.flow.html", []);
    expect(published().has("a.flow.html")).toBe(false);
  });

  it("opens the Console at a level's first notice, writing every one Clear took again", () => {
    const { notices, entries, clear } = setup();
    notices.add("a.flow.html", "run", note("first"));
    notices.add("a.flow.html", "run", note("second"));
    notices.add("a.flow.html", "publish", { ...note("too big"), level: "warn" });

    notices.reveal("a.flow.html", "info");
    expect(entries[0].reveal).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(3);

    clear();
    notices.reveal("a.flow.html", "info");
    expect(entries.map((entry) => entry.content)).toEqual(["first", "second", "too big", "first", "second"]);
    expect(entries[3].reveal).toHaveBeenCalledTimes(1);
  });
});
