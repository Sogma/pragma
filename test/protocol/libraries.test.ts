import { describe, expect, it } from "vitest";
import { libraryDeclarations, serializeLibrariesFile, withLibraryChange } from "../../src/protocol/libraries.ts";

describe("the libraries a space declares", () => {
  it("are its entries in file order, each id once, a blank label reading as the id", () => {
    const file = {
      libraries: [
        { id: "footage", label: " Footage " },
        { id: "stills", label: "  " },
        { id: "footage", label: "Again" },
        { id: "refs" },
      ],
    };
    expect(libraryDeclarations(file)).toEqual([
      { id: "footage", label: "Footage" },
      { id: "stills", label: "stills" },
      { id: "refs", label: "refs" },
    ]);
  });

  it("read a description trimmed, and a blank or non-text one as none", () => {
    const file = {
      libraries: [
        { id: "footage", label: "Footage", description: "  Reels from the shoot  " },
        { id: "stills", label: "Stills", description: "   " },
        { id: "refs", label: "Refs", description: 7 },
      ],
    };
    expect(libraryDeclarations(file)).toStrictEqual([
      { id: "footage", label: "Footage", description: "Reels from the shoot" },
      { id: "stills", label: "Stills" },
      { id: "refs", label: "Refs" },
    ]);
  });

  // The id is what `lib:<id>/…` names, so an entry no such path could name
  // declares nothing: it is left in the file, never read as a library.
  it("leave out an entry whose id no lib: path can name", () => {
    const file = { libraries: [{ id: "Footage" }, { id: "a/b" }, { id: "" }, { label: "No id" }, "refs", null] };
    expect(libraryDeclarations(file)).toEqual([]);
    expect(libraryDeclarations(undefined)).toEqual([]);
    expect(libraryDeclarations({ libraries: "footage" })).toEqual([]);
  });
});

describe("changing one library", () => {
  const file = { libraries: [{ id: "footage", label: "Footage", note: "kept" }, { id: "Bad" }] };

  it("declares a new id last, and leaves one already declared as it is", () => {
    expect(withLibraryChange(file, { add: { id: "stills", label: "Stills" } }).libraries).toEqual([
      ...file.libraries,
      { id: "stills", label: "Stills" },
    ]);
    expect(withLibraryChange(file, { add: { id: "footage", label: "Other" } })).toEqual(file);
    expect(withLibraryChange(undefined, { add: { id: "stills", label: "Stills" } })).toEqual({
      libraries: [{ id: "stills", label: "Stills" }],
    });
  });

  it("declares a new id with its description, and with none when it is blank", () => {
    expect(
      withLibraryChange(undefined, { add: { id: "stills", label: "Stills", description: " Frames " } }),
    ).toStrictEqual({ libraries: [{ id: "stills", label: "Stills", description: "Frames" }] });
    expect(withLibraryChange(undefined, { add: { id: "stills", label: "Stills", description: " " } })).toStrictEqual({
      libraries: [{ id: "stills", label: "Stills" }],
    });
  });

  it("describes by id, in place, a blank description taking the key out", () => {
    const described = {
      libraries: [{ id: "footage", label: "Footage", description: "Old", note: "kept" }, { id: "Bad" }],
    };
    const [changed] = withLibraryChange(described, { describe: "footage", description: " Reels " })
      .libraries as object[];
    expect(changed).toStrictEqual({ id: "footage", label: "Footage", description: "Reels", note: "kept" });
    expect(Object.keys(changed)).toEqual(["id", "label", "description", "note"]);
    expect(withLibraryChange(described, { describe: "footage", description: "  " }).libraries).toStrictEqual([
      { id: "footage", label: "Footage", note: "kept" },
      { id: "Bad" },
    ]);
    expect(withLibraryChange(file, { describe: "footage", description: "New" }).libraries).toStrictEqual([
      { id: "footage", label: "Footage", note: "kept", description: "New" },
      { id: "Bad" },
    ]);
  });

  it("relabels or removes by id, keeping every other key and entry", () => {
    expect(withLibraryChange(file, { relabel: "footage", label: "Reels" }).libraries).toEqual([
      { id: "footage", label: "Reels", note: "kept" },
      { id: "Bad" },
    ]);
    expect(withLibraryChange({ ...file, other: 1 }, { remove: "footage" })).toEqual({
      libraries: [{ id: "Bad" }],
      other: 1,
    });
  });

  it("is written one library to a line", () => {
    expect(
      serializeLibrariesFile({
        libraries: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
      }),
    ).toBe('{\n  "libraries": [\n    { "id": "a", "label": "A" },\n    { "id": "b", "label": "B" }\n  ]\n}\n');
    expect(serializeLibrariesFile({ libraries: [] })).toBe('{\n  "libraries": []\n}\n');
  });
});
