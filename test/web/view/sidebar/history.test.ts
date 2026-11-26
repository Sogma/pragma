// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryFile, HistoryVersion } from "../../../../web/core/apiClient.ts";

const files: HistoryFile[] = [];
const versions = new Map<string, HistoryVersion[]>();

vi.mock("../../../../web/core/apiClient.ts", () => ({
  fetchHistoryFiles: vi.fn(async () => files),
  fetchHistoryVersions: vi.fn(async (path: string) => versions.get(path) ?? []),
}));

const { createHistorySection } = await import("../../../../web/view/sidebar/history.ts");
const { replacedBy } = await import("../../../../web/core/versionText.ts");

const NOW = new Date(2026, 10, 1, 15, 30).getTime();
const HOUR = 60 * 60 * 1000;

function section(exists: (path: string) => boolean = () => true) {
  const openVersion = vi.fn();
  const setCount = vi.fn();
  const history = createHistorySection({ exists, showExtensions: () => false, openVersion });
  history.showCountIn(setCount);
  const rows = () => [...history.body.querySelectorAll<HTMLElement>(".history-file > .node-label")];
  return { history, openVersion, setCount, rows };
}

describe("the History section", () => {
  beforeEach(() => {
    files.length = 0;
    versions.clear();
  });

  it("lists the files with versions, newest first, and counts them", async () => {
    files.push({ path: "notes/today.md", latest: NOW - HOUR }, { path: "draft.fountain", latest: NOW - 30 * HOUR });
    const { history, setCount, rows } = section();
    history.refresh();
    await vi.waitFor(() => expect(rows()).toHaveLength(2));
    expect(rows().map((row) => row.querySelector(".node-name")?.textContent)).toEqual(["today", "draft"]);
    expect(rows()[0].querySelector(".history-folder")?.textContent).toBe("notes");
    expect(setCount).toHaveBeenLastCalledWith("2");
  });

  it("says when no versions are kept yet", async () => {
    const { history, setCount } = section();
    history.refresh();
    await vi.waitFor(() =>
      expect(history.body.querySelector(".stack-section-message")?.textContent).toBe("No earlier versions yet."),
    );
    expect(setCount).toHaveBeenLastCalledWith("");
  });

  it("opens a file to its versions, each opening beside it", async () => {
    files.push({ path: "a.md", latest: NOW });
    const edited: HistoryVersion = { id: "v2", time: NOW, source: "edit" };
    const flowed: HistoryVersion = { id: "v1", time: NOW - HOUR, source: "flow", detail: "flows/tidy.flow.html" };
    versions.set("a.md", [edited, flowed]);
    const { history, openVersion, rows } = section();
    history.refresh();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    rows()[0].click();
    const versionRows = () => [...history.body.querySelectorAll<HTMLElement>(".history-version > .node-label")];
    await vi.waitFor(() => expect(versionRows()).toHaveLength(2));
    expect(versionRows().map((row) => row.querySelector(".history-source")?.textContent)).toEqual([
      "You",
      "Flow: tidy",
    ]);
    versionRows()[1].click();
    expect(openVersion).toHaveBeenCalledWith("a.md", flowed);

    rows()[0].click();
    expect(versionRows()).toHaveLength(0);
  });

  it("marks a file the space no longer holds as deleted", async () => {
    files.push({ path: "gone.md", latest: NOW });
    const { history, rows } = section((path) => path !== "gone.md");
    history.refresh();
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0].closest(".history-file")?.classList.contains("gone")).toBe(true);
    expect(rows()[0].dataset.tooltip).toBe("gone.md, deleted");
  });
});

describe("how History names a writer", () => {
  it("names who made each change", () => {
    const named = (source: HistoryVersion["source"]) => replacedBy({ id: "x", time: 0, source });
    expect(
      ["edit", "copilot", "links", "published", "restored", "outside"].map((source) => named(source as never)),
    ).toEqual(["You", "Copilot", "Links updated", "Published", "Restored", "Changed outside Pragma"]);
  });
});
