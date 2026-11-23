import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { parseClassFile } from "../../src/protocol/classFile.ts";
import { parseFlowFile } from "../../src/protocol/flowFile.ts";
import { metadataText } from "../../src/protocol/metadata.ts";
import { parseTableFile, readMetadataBlock, readTableFile } from "../../src/protocol/tableFile.ts";
import { metadataBlock, serializeTableFile } from "../../src/protocol/tableHtml.ts";
import type { TableFile } from "../../src/protocol/types.ts";
import { tempDir } from "../support/isolation.ts";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(dirname, "../../templates/space/projects/getting-started/writing-prompts.table.html");

// Conformance tests for the `.table.html` format itself (docs/protocol.md's
// Tables section), not for node-html-parser specifically — these assert on
// the read/serialize input/output contract, so they survive a parser swap.
describe(".table.html round-tripping", () => {
  it("is byte-stable: serializing an unchanged read reproduces the file exactly", async () => {
    const raw = await readFile(fixture, "utf8");
    const parsed = await readTableFile(fixture);
    expect(serializeTableFile(parsed)).toBe(raw);
  });

  it("parse(serialize(x)) is a fixed point for a freshly built table", async () => {
    const file: TableFile = {
      version: "1.0",
      name: "Round-trip test",
      metadata: [
        { key: "description", values: ['A table with special chars: <>&"'] },
        { key: "tags", values: ["studio", "reference"] },
        { key: "status", values: [] },
      ],
      columns: [{ id: "value", type: "text", label: "Prompt" }],
      rows: [{ values: { value: "First row" } }, { values: { value: 'Second <row> & "quoted"' } }],
    };

    const dir = tempDir("pragma-tablefile-test-");
    const filePath = path.join(dir, "roundtrip.table.html");
    const firstPass = serializeTableFile(file);
    await writeFile(filePath, firstPass, "utf8");

    const reparsed = await readTableFile(filePath);
    const secondPass = serializeTableFile(reparsed);

    // Not just "equal data" — literally the same bytes, matching the
    // format's own byte-stability guarantee (see tableHtml.ts).
    expect(secondPass).toBe(firstPass);
  });

  // The layout is what a reader opens in, carried as one attribute on the
  // data table and written only when it is not the list — a file that never
  // named one must not gain an attribute from being saved.
  it("round-trips data-layout, and writes nothing for the list", async () => {
    const dir = tempDir("pragma-tablefile-layout-");
    const base: TableFile = {
      version: "1.0",
      columns: [{ id: "take", type: "text", label: "Take" }],
      rows: [{ values: { take: "one" } }],
    };
    const cards = path.join(dir, "cards.table.html");
    await writeFile(cards, serializeTableFile({ ...base, layout: "cards" }), "utf8");
    expect(await readFile(cards, "utf8")).toContain('<table data-role="data" data-layout="cards">');
    expect((await readTableFile(cards)).layout).toBe("cards");

    const list = path.join(dir, "list.table.html");
    await writeFile(list, serializeTableFile({ ...base, layout: "list" }), "utf8");
    expect(await readFile(list, "utf8")).toContain('<table data-role="data">');
    expect((await readTableFile(list)).layout).toBeUndefined();
    expect(serializeTableFile(await readTableFile(list))).toBe(serializeTableFile(base));
  });

  // A drop folder is written only when set, so a media column that never
  // named one saves byte-identical.
  it("round-trips data-media-folder, and writes nothing without one", async () => {
    const dir = tempDir("pragma-tablefile-media-");
    const file: TableFile = {
      version: "1.0",
      columns: [
        { id: "still", type: "media", label: "Still", mediaFolder: "lib:refs/shots" },
        { id: "take", type: "media", label: "Take" },
      ],
      rows: [],
    };
    const html = serializeTableFile(file);
    expect(html).toContain('<th data-field="still" data-type="media" data-media-folder="lib:refs/shots">Still</th>');
    expect(html).toContain('<th data-field="take" data-type="media">Take</th>');
    const filePath = path.join(dir, "media.table.html");
    await writeFile(filePath, html, "utf8");
    const reparsed = await readTableFile(filePath);
    expect(reparsed.columns.map((column) => column.mediaFolder)).toEqual(["lib:refs/shots", undefined]);
    expect(serializeTableFile(reparsed)).toBe(html);
  });

  // The default is a timestamp's alone, and written only when set, so a
  // column that never asked for one saves byte-identical.
  it("round-trips a timestamp's data-default, and reads it on no other type", () => {
    const file: TableFile = {
      version: "1.0",
      columns: [
        { id: "added", type: "timestamp", label: "Added", default: "now" },
        { id: "due", type: "timestamp", label: "Due" },
      ],
      rows: [{ values: { added: "2026-10-07T12:32:05Z", due: "" } }],
    };
    const html = serializeTableFile(file);
    expect(html).toContain('<th data-field="added" data-type="timestamp" data-default="now">Added</th>');
    expect(html).toContain('<th data-field="due" data-type="timestamp">Due</th>');
    const reparsed = parseTableFile(html);
    expect(reparsed?.columns.map((column) => column.default)).toEqual(["now", undefined]);
    expect(reparsed && serializeTableFile(reparsed)).toBe(html);

    const onText = html.replace('data-type="timestamp" data-default="now"', 'data-type="text" data-default="now"');
    expect(parseTableFile(onText)?.columns[0].default).toBeUndefined();
  });

  // A media column hides its file names unless it says to show them, the
  // same in a Class's fields.
  it("round-trips a media column's data-show-name, and reads it on no other type", () => {
    const file: TableFile = {
      version: "1.0",
      columns: [
        { id: "still", type: "media", label: "Still", mediaFolder: "stills", showName: true },
        { id: "take", type: "media", label: "Take" },
      ],
      rows: [{ values: { still: "stills/a.png", take: "" } }],
    };
    const html = serializeTableFile(file);
    expect(html).toContain(
      '<th data-field="still" data-type="media" data-media-folder="stills" data-show-name>Still</th>',
    );
    expect(html).toContain('<th data-field="take" data-type="media">Take</th>');
    const reparsed = parseTableFile(html);
    expect(reparsed?.columns.map((column) => column.showName)).toEqual([true, undefined]);
    expect(reparsed && serializeTableFile(reparsed)).toBe(html);

    const onText = html.replace('data-type="media" data-media-folder="stills"', 'data-type="text"');
    expect(parseTableFile(onText)?.columns[0].showName).toBeUndefined();
  });

  it("reads the fixture's real rows", async () => {
    const parsed = await readTableFile(fixture);
    expect(parsed.columns.map((c) => c.id)).toEqual(["value"]);
    expect(parsed.rows.length).toBe(6);
    expect(parsed.rows[0]?.values.value).toBe("A locked door with no key");
  });
});

// The split a saving caller depends on: blank is a new table to fill in,
// unreadable is a file that an empty table saved back would erase.
describe("parseTableFile: blank versus unreadable", () => {
  it("reads blank text as an empty table", () => {
    expect(parseTableFile("  \n")).toMatchObject({ columns: [], rows: [] });
  });

  it("is undefined for non-blank text without a table root", async () => {
    const raw = await readFile(fixture, "utf8");
    expect(parseTableFile(raw)?.rows.length).toBe(6);
    expect(parseTableFile(raw.replace(' data-format="table"', ""))).toBeUndefined();
  });
});

// The block a Flow and Class share with a Table, read and written by one
// pair of functions so the kinds can't drift apart.
describe("the metadata block", () => {
  it("groups as HTML does: a key's values are the <dd>s after it, and a run of <dt>s shares them", () => {
    const root = parse(`<body><dl data-role="metadata">
      <dd>Before any key.</dd>
      <dt>description</dt><dd>First.</dd>
      <dt>tags</dt><dd>studio</dd><dd> </dd><dd>reference</dd>
      <dt>author</dt><dt>editor</dt><dd>Lina</dd>
      <dt>status</dt><dd></dd>
      <dt>description</dt><dd>Second.</dd>
      <dt> </dt><dd>No key.</dd>
    </dl></body>`);
    expect(readMetadataBlock(root)).toEqual([
      { key: "description", values: ["First."] },
      { key: "tags", values: ["studio", "reference"] },
      { key: "author", values: ["Lina"] },
      { key: "editor", values: ["Lina"] },
      { key: "status", values: [] },
    ]);
    expect(readMetadataBlock(parse("<body></body>"))).toEqual([]);
  });

  it("is read alike by a Table, a Flow and a Class", () => {
    const block = `<dl data-role="metadata"><dt>description</dt><dd>First.</dd><dt>tags</dt><dd>a</dd><dd>b</dd></dl>`;
    const document = (format: string) =>
      `<html data-format="${format}"><head><title>T</title></head><body>${block}</body></html>`;
    const expected = [
      { key: "description", values: ["First."] },
      { key: "tags", values: ["a", "b"] },
    ];
    expect(parseTableFile(document("table"))?.metadata).toEqual(expected);
    expect(parseFlowFile(document("flow"))?.metadata).toEqual(expected);
    expect(parseClassFile(document("class"))?.metadata).toEqual(expected);
    expect(metadataText(parseTableFile(document("table"))?.metadata, "description")).toBe("First.");
  });

  it("writes every entry in order, a line each, and the empty block with none", () => {
    expect(
      metadataBlock([
        { key: "description", values: ['A <b> & "c"'] },
        { key: "tags", values: ["a", "b"] },
        { key: "status", values: [] },
      ]),
    ).toBe(
      '  <dl data-role="metadata">\n' +
        "    <dt>description</dt><dd>A &lt;b&gt; &amp; &quot;c&quot;</dd>\n" +
        "    <dt>tags</dt><dd>a</dd><dd>b</dd>\n" +
        "    <dt>status</dt><dd></dd>\n" +
        "  </dl>",
    );
    expect(metadataBlock([])).toBe('  <dl data-role="metadata">\n  </dl>');
    expect(metadataBlock(undefined)).toBe('  <dl data-role="metadata">\n  </dl>');
  });
});
