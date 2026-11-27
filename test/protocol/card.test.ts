import { describe, expect, it } from "vitest";
import { cardTiles, cardWithField, cardWithFieldRenamed, cardWithoutField } from "../../src/protocol/card.ts";
import type { TableColumn } from "../../src/protocol/types.ts";

const fields: TableColumn[] = [
  { id: "a", type: "text", label: "A" },
  { id: "b", type: "integer", label: "B" },
];

describe("cardTiles", () => {
  it("shows every field in order when the file arranges none", () => {
    expect(cardTiles(fields, undefined)).toEqual([{ field: "a" }, { field: "b" }]);
  });

  it("keeps the tiles naming a field, and the headings, in the card's order", () => {
    expect(
      cardTiles(fields, [{ field: "b", columns: 2 }, { field: "gone" }, { heading: "H" }, { field: "a" }]),
    ).toEqual([{ field: "b", columns: 2 }, { heading: "H" }, { field: "a" }]);
  });

  it("shows nothing for a card emptied of tiles", () => {
    expect(cardTiles(fields, [])).toEqual([]);
  });
});

describe("cardWithField and cardWithoutField", () => {
  it("puts a new field at the end of an arranged card, once, and starts no card", () => {
    expect(cardWithField([{ heading: "H" }, { field: "a" }], "b")).toEqual([
      { heading: "H" },
      { field: "a" },
      { field: "b" },
    ]);
    expect(cardWithField([{ field: "b", rows: 2 }], "b")).toEqual([{ field: "b", rows: 2 }]);
    expect(cardWithField([], "b")).toEqual([{ field: "b" }]);
    expect(cardWithField(undefined, "b")).toBeUndefined();
  });

  it("takes a deleted field's tile off the card, keeping its headings", () => {
    expect(cardWithoutField([{ field: "a" }, { heading: "a" }, { field: "b" }], "a")).toEqual([
      { heading: "a" },
      { field: "b" },
    ]);
    expect(cardWithoutField(undefined, "a")).toBeUndefined();
  });

  it("does the same for a small card, keeping its title", () => {
    const small = [{ title: true as const, columns: 3 }, { field: "a" }];
    expect(cardWithField(small, "b")).toEqual([...small, { field: "b" }]);
    expect(cardWithoutField(small, "a")).toEqual([{ title: true, columns: 3 }]);
  });

  // A heading that happens to read as the old key is text, not the field.
  it("keeps a renamed field's tile where it was, as it was, and starts no card", () => {
    expect(cardWithFieldRenamed([{ heading: "a" }, { field: "a", rows: 2 }, { field: "b" }], "a", "c")).toEqual([
      { heading: "a" },
      { field: "c", rows: 2 },
      { field: "b" },
    ]);
    expect(cardWithFieldRenamed([{ title: true as const }, { field: "a", columns: 3 }], "a", "c")).toEqual([
      { title: true },
      { field: "c", columns: 3 },
    ]);
    expect(cardWithFieldRenamed(undefined, "a", "c")).toBeUndefined();
  });
});
