// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createActiveRowMarker } from "../../../web/view/treeRows.ts";

// Rows as the tree draws them: a label, then one guide line per folder above.
function row(path: string, folders: string[]): HTMLLIElement {
  const item = document.createElement("li");
  const label = document.createElement("span");
  label.className = "node-label";
  label.dataset.path = path;
  const guides = document.createElement("span");
  guides.className = "tree-guides";
  for (const folder of folders) {
    const line = document.createElement("span");
    line.dataset.folder = folder;
    guides.appendChild(line);
  }
  item.append(label, guides);
  return item;
}

function activeFolders(root: ParentNode): (string | undefined)[] {
  return [...root.querySelectorAll<HTMLElement>(".tree-guides > .active")].map((line) => line.dataset.folder);
}

describe("createActiveRowMarker", () => {
  it("moves the darker guide to the highlighted row's folder in rows already drawn", () => {
    const root = document.createElement("ul");
    root.append(
      row("lib:footage/a", []),
      row("lib:footage/a/b", ["lib:footage/a"]),
      row("lib:footage/a/b/c.md", ["lib:footage/a", "lib:footage/a/b"]),
      row("lib:footage/a/d.md", ["lib:footage/a"]),
    );
    const marker = createActiveRowMarker(root);

    marker.set("lib:footage/a/b/c.md");
    expect(activeFolders(root)).toEqual(["lib:footage/a/b"]);
    expect(marker.holds("lib:footage/a/b")).toBe(true);
    expect(root.querySelectorAll(".node-label.active")).toHaveLength(1);

    marker.set("lib:footage/a/d.md");
    expect(activeFolders(root)).toEqual(["lib:footage/a", "lib:footage/a", "lib:footage/a"]);

    // A file at the top of its root sits in no folder's guide.
    marker.set("lib:footage/top.md");
    expect(activeFolders(root)).toEqual([]);

    // Pointed nowhere, as a tab showing no file points it, it unmarks all.
    marker.set("lib:footage/a/d.md");
    marker.set(undefined);
    expect(activeFolders(root)).toEqual([]);
    expect(marker.holds("lib:footage/a")).toBe(false);
    expect(root.querySelectorAll(".node-label.active")).toHaveLength(0);
  });

  it("tells a subscriber each time the highlight moves to another path, until it stops", () => {
    const marker = createActiveRowMarker(document.createElement("ul"));
    const heard: (string | undefined)[] = [];
    const stop = marker.subscribe((path) => heard.push(path));
    marker.set("a.md");
    marker.set("a.md");
    marker.set("b/c.md");
    marker.set(undefined);
    stop();
    marker.set("d.md");
    expect(heard).toEqual(["a.md", "b/c.md", undefined]);
  });
});
