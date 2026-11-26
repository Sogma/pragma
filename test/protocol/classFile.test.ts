import { describe, expect, it } from "vitest";
import { parseClassFile } from "../../src/protocol/classFile.ts";
import { serializeClassFile } from "../../src/protocol/classHtml.ts";

// Hand-written, in an order of its own: views before the Class's filter,
// so a view's filter can't be taken for it. A list of sources is no part of
// a Class, so it reads as nothing and is never written back.
const handWritten = `<!DOCTYPE html>
<html data-format="class" data-format-version="1.0">
<head><meta charset="utf-8"><title>Shot prompts</title></head>
<body>
  <dl data-role="metadata"><dt>description</dt><dd>Every shot's prompt.</dd></dl>
  <ol data-role="views">
    <li data-name="Needs a frame" data-sort="scene" data-order="desc">
      <ul data-role="filter">
        <li data-property="status" data-test="is">approved</li>
        <li data-property="frame" data-test="empty"></li>
      </ul>
    </li>
    <li data-name="Board" data-layout="cards" data-group-by="status" data-fields=" frame, status ,"></li>
    <li data-name="Titles" data-fields=""></li>
  </ol>
  <ul data-role="links"><li>../tools/lyrics.flow.html</li><li> </li><li>/tools/polish.flow.html</li></ul>
  <ul data-role="sources"><li data-subfolders="include">.</li></ul>
  <ul data-role="filter"><li data-property="file.folder" data-test="within">., /archive/shots</li><li data-property="tags" data-test="has">shot, still</li></ul>
  <table data-role="fields"><thead><tr>
    <th data-field="status" data-type="select" data-options="draft,approved">Status</th>
    <th data-field="frame" data-type="media" data-media-folder="frames" data-show-name>Frame</th>
  </tr></thead></table>
</body></html>`;

describe("parseClassFile", () => {
  it("reads the Class's filter, fields, views, each with its own filter, and links", () => {
    expect(parseClassFile(handWritten)).toEqual({
      version: "1.0",
      name: "Shot prompts",
      metadata: [{ key: "description", values: ["Every shot's prompt."] }],
      filter: [
        { property: "file.folder", test: "within", values: [".", "/archive/shots"] },
        { property: "tags", test: "has", values: ["shot", "still"] },
      ],
      fields: [
        { id: "status", type: "select", label: "Status", options: ["draft", "approved"] },
        { id: "frame", type: "media", label: "Frame", mediaFolder: "frames", showName: true },
      ],
      views: [
        {
          name: "Needs a frame",
          layout: "list",
          sort: { property: "scene", order: "desc" },
          filter: [
            { property: "status", test: "is", values: ["approved"] },
            { property: "frame", test: "empty", values: [] },
          ],
        },
        { name: "Board", layout: "cards", groupBy: "status", fields: ["frame", "status"], filter: [] },
        { name: "Titles", layout: "list", fields: [], filter: [] },
      ],
      links: ["../tools/lyrics.flow.html", "/tools/polish.flow.html"],
    });
  });

  it("reads blank text as a new, empty Class, and other files as none", () => {
    expect(parseClassFile("  ")).toEqual({ version: "1.0", filter: [], fields: [], views: [], links: [] });
    expect(parseClassFile('<html data-format="table"></html>')).toBeUndefined();
    expect(parseClassFile("not a class")).toBeUndefined();
  });

  it("keeps a test it doesn't know, and drops a rule missing its property or test", () => {
    const file = parseClassFile(
      '<html data-format="class"><body><ul data-role="filter"><li data-property="a" data-test="near">x</li><li data-test="is">y</li></ul></body></html>',
    );
    expect(file?.filter).toEqual([{ property: "a", test: "near", values: ["x"] }]);
  });
});

describe("serializeClassFile", () => {
  it("writes what it read in a fixed shape, byte-stable from then on", () => {
    const written = serializeClassFile(parseClassFile(handWritten) ?? fail());
    expect(serializeClassFile(parseClassFile(written) ?? fail())).toBe(written);
    expect(written).toContain(
      '    <li data-name="Board" data-layout="cards" data-group-by="status" data-fields="frame,status"></li>\n',
    );
    expect(written).toContain('    <li data-name="Titles" data-fields=""></li>\n');
    expect(written).not.toContain("sources");
    expect(written).toContain(
      '    <li data-property="file.folder" data-test="within">., /archive/shots</li>\n    <li data-property="tags" data-test="has">shot, still</li>\n',
    );
    expect(written).not.toContain('data-layout="list"');
    expect(written).not.toContain('data-order="asc"');
    expect(written).toContain(
      '  <ul data-role="links">\n    <li>../tools/lyrics.flow.html</li>\n    <li>/tools/polish.flow.html</li>\n  </ul>\n',
    );
  });

  it("writes no links for a Class with none, as it wrote one before there were any", () => {
    const written = serializeClassFile({ version: "1.0", filter: [], fields: [], views: [], links: [] });
    expect(written).not.toContain("links");
    expect(written).toContain(
      '  <dl data-role="metadata">\n  </dl>\n\n  <ul data-role="filter">\n  </ul>\n\n  <table data-role="fields">',
    );
  });

  // The card is the body's own child, between the fields and the views, and
  // written only once arranged.
  it("reads and writes a card between the fields and the views, and none without one", () => {
    const empty = { version: "1.0", filter: [], fields: [], views: [], links: [] };
    expect(serializeClassFile(empty)).toContain('  </table>\n\n  <ol data-role="views">');
    const written = serializeClassFile({ ...empty, card: [{ field: "status", columns: 2 }, { heading: "Look" }] });
    expect(written).toContain(
      '  </table>\n\n  <ol data-role="card">\n    <li data-field="status" data-columns="2"></li>\n    <li data-heading="Look"></li>\n  </ol>\n\n  <ol data-role="views">',
    );
    expect(parseClassFile(written)?.card).toEqual([{ field: "status", columns: 2 }, { heading: "Look" }]);
    expect(parseClassFile(handWritten)?.card).toBeUndefined();
  });

  it("reads and writes a small card after the row card's block, and none without one", () => {
    const empty = { version: "1.0", filter: [], fields: [], views: [], links: [] };
    expect(serializeClassFile(empty)).not.toContain("small-card");
    const smallCard = [{ title: true as const, columns: 3 }, { field: "status" }];
    const written = serializeClassFile({ ...empty, card: [{ heading: "Look" }], smallCard });
    expect(written).toContain(
      '  </ol>\n\n  <ol data-role="small-card">\n    <li data-title data-columns="3"></li>\n    <li data-field="status"></li>\n  </ol>\n\n  <ol data-role="views">',
    );
    const read = parseClassFile(written);
    expect(read?.smallCard).toEqual(smallCard);
    expect(read?.card).toEqual([{ heading: "Look" }]);
    expect(parseClassFile(handWritten)?.smallCard).toBeUndefined();
  });
});

function fail(): never {
  throw new Error("expected a Class");
}
