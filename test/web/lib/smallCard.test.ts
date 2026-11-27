// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TableColumn } from "../../../src/protocol/types.ts";
import {
  createArrangedCard,
  resolveSmallCard,
  smallCardFromParts,
  smallCardPart,
  smallCardSpan,
  smallCardStart,
} from "../../../web/lib/smallCard.ts";

const parts = { picture: "frame", title: "shot", badge: "size" };

describe("a small card's tiles", () => {
  it("takes its parts from the rule, never from where a tile sits", () => {
    expect(smallCardPart({ field: "frame" }, parts)).toBe("picture");
    expect(smallCardPart({ field: "size" }, parts)).toBe("badge");
    expect(smallCardPart({ field: "lens" }, parts)).toBe("line");
    expect(smallCardPart({ title: true }, parts)).toBe("title");
    expect(smallCardPart({ heading: "Camera" }, parts)).toBe("heading");
  });

  it("starts each tile as a line of the composed card", () => {
    expect(smallCardStart({ field: "frame" }, parts)).toEqual({ columns: 4, rows: 5 });
    expect(smallCardStart({ title: true }, parts)).toEqual({ columns: 3, rows: 1 });
    expect(smallCardStart({ title: true }, { title: "shot" })).toEqual({ columns: 4, rows: 1 });
    expect(smallCardStart({ field: "size" }, parts)).toEqual({ columns: 1, rows: 1 });
    expect(smallCardStart({ field: "lens" }, parts)).toEqual({ columns: 4, rows: 1 });
  });

  it("spans a tile as it says, within four columns and eight rows, a heading across", () => {
    expect(smallCardSpan({ field: "lens", columns: 2 }, parts)).toEqual({ columns: 2, rows: 1 });
    expect(smallCardSpan({ field: "lens", columns: 6, rows: 12 }, parts)).toEqual({ columns: 4, rows: 8 });
    expect(smallCardSpan({ heading: "Camera" }, parts)).toEqual({ columns: 4, rows: 1 });
  });

  it("lays the composed card out as tiles, a Class row's own title included", () => {
    expect(smallCardFromParts(parts, ["lens"], false)).toEqual([
      { field: "frame" },
      { title: true },
      { field: "size" },
      { field: "lens" },
    ]);
    expect(smallCardFromParts({}, ["status"], true)).toEqual([{ title: true }, { field: "status" }]);
    expect(smallCardFromParts({ picture: "frame" }, [], false)).toEqual([{ field: "frame" }]);
  });

  it("resolves only tiles naming one of the fields, with each one's field and label", () => {
    const fields: TableColumn[] = [
      { id: "shot", type: "text", label: "Shot" },
      { id: "lens", type: "integer", label: "Lens" },
    ];
    const resolved = resolveSmallCard(fields, [{ title: true }, { field: "gone" }, { field: "lens" }], {
      title: fields[0],
    });
    expect(resolved.map(({ part, label, field }) => [part, label, field?.id])).toEqual([
      ["title", undefined, "shot"],
      ["line", "Lens", "lens"],
    ]);
  });
});

describe("createArrangedCard", () => {
  const button = (className: string) => Object.assign(document.createElement("button"), { className });
  const size = { columns: 4, rows: 1 };

  it("holds its open and remove buttons on the card itself, outside every tile", () => {
    const tiles = [
      { part: "title" as const, size, control: document.createElement("span") },
      { part: "line" as const, size, label: "Lens", control: document.createElement("span") },
    ];
    const card = createArrangedCard(tiles, button("row-open"), button("data-cards-remove"));
    expect([...card.children].map((child) => child.className)).toEqual([
      "row-open",
      "data-cards-grid",
      "data-cards-remove",
    ]);
    expect(card.querySelector(".data-cards-tile button")).toBeNull();

    const bare = createArrangedCard([{ part: "heading", size, label: "Camera" }]);
    expect([...bare.children].map((child) => child.className)).toEqual(["data-cards-grid"]);
    expect(bare.querySelector(".data-cards-heading")?.textContent).toBe("Camera");
  });
});
