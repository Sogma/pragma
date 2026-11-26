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
  const action = () => Object.assign(document.createElement("button"), { className: "row-open" });
  const size = { columns: 4, rows: 1 };

  it("ends the title's tile with the card's actions", () => {
    const card = createArrangedCard(
      [
        { part: "title", size, control: document.createElement("span") },
        { part: "line", size, label: "Lens", control: document.createElement("span") },
      ],
      [action()],
    );
    expect(card.querySelector(".data-cards-title .row-open")).not.toBeNull();
    expect(card.querySelector(".data-cards-actions")).toBeNull();
  });

  it("puts them in the card's corner when no title is on it", () => {
    const card = createArrangedCard([{ part: "heading", size, label: "Camera" }], [action()]);
    expect(card.querySelector(".data-cards-actions .row-open")).not.toBeNull();
    expect(card.querySelector(".data-cards-heading")?.textContent).toBe("Camera");
  });
});
