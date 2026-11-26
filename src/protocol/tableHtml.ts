import type { CardTile, MetadataEntry, TableColumn, TableFile } from "./types.ts";

// Pure string-building, no Node/DOM APIs — isomorphic on purpose, so the
// server (scaffolding a new file) and the client (persisting an edit) share
// one serializer rather than drifting apart. See docs/protocol.md's Tables
// section: "byte-stable for unchanged content" keeps git diffs one row wide.

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// One line per key, so a git diff stays one key wide. A key with no value
// still gets its `<dd>`: a `<dt>` with none is not a valid HTML group.
function metadataRow({ key, values }: MetadataEntry): string {
  const cells = (values.length ? values : [""]).map((value) => `<dd>${escapeHtml(value)}</dd>`).join("");
  return `    <dt>${escapeHtml(key)}</dt>${cells}\n`;
}

/** The `<dl data-role="metadata">` block a Flow and Class share
 * with a Table, every entry in order. With none it is still written, empty,
 * so a file's shape never depends on its metadata. */
export function metadataBlock(metadata: readonly MetadataEntry[] | undefined): string {
  return `  <dl data-role="metadata">\n${(metadata ?? []).map(metadataRow).join("")}  </dl>`;
}

// A name an attribute can be written with: one holding a quote, `>` or `=`
// would break the markup around it.
const ATTRIBUTE_NAME = /^[^\s"'<>/=]+$/;

/** One `<th>` of a `<thead>` of field definitions, which a Class's
 * fields share with a Table's columns. An attribute this build didn't read
 * follows the ones it writes, unless it writes one of that name. */
export function fieldHeaderCell(column: TableColumn): string {
  // An undefined value is written bare, as a boolean attribute.
  const attributes: [string, string | undefined][] = [
    ["data-field", column.id],
    ["data-type", column.unknownType ?? column.type],
  ];
  if (column.options?.length) attributes.push(["data-options", column.options.join(",")]);
  if (column.mediaFolder) attributes.push(["data-media-folder", column.mediaFolder]);
  if (column.showName) attributes.push(["data-show-name", undefined]);
  if (column.default) attributes.push(["data-default", column.default]);
  const written = new Set(attributes.map(([name]) => name));
  for (const [name, value] of column.unknownAttributes ?? []) {
    if (ATTRIBUTE_NAME.test(name) && !written.has(name.toLowerCase())) attributes.push([name, value || undefined]);
  }
  const text = attributes
    .map(([name, value]) => (value === undefined ? ` ${name}` : ` ${name}="${escapeHtml(value)}"`))
    .join("");
  return `        <th${text}>${escapeHtml(column.label)}</th>\n`;
}

function cardItem(tile: CardTile): string {
  if ("heading" in tile) return `    <li data-heading="${escapeHtml(tile.heading)}"></li>\n`;
  const columns = tile.columns ? ` data-columns="${tile.columns}"` : "";
  const rows = tile.rows ? ` data-rows="${tile.rows}"` : "";
  return `    <li data-field="${escapeHtml(tile.field)}"${columns}${rows}></li>\n`;
}

/** The `<ol data-role="card">` a Table and a Class share, its own lines
 * with a blank one before; nothing for a card never arranged, so the file
 * reads as it did before there was one. */
export function cardBlock(tiles: readonly CardTile[] | undefined): string {
  if (tiles === undefined) return "";
  return `\n  <ol data-role="card">\n${tiles.map(cardItem).join("")}  </ol>\n`;
}

/** Serializes a TableFile back to `.table.html` text. Column/row order is
 * exactly the order of the `columns`/`rows` arrays passed in. */
export function serializeTableFile(file: TableFile): string {
  const title = file.name ?? "";
  const metadata = metadataBlock(file.metadata);

  const headerCells = file.columns.map(fieldHeaderCell).join("");
  // Only ever written for a layout other than the list, so a file that never
  // named one stays byte-identical.
  const layout = file.layout && file.layout !== "list" ? ` data-layout="${escapeHtml(file.layout)}"` : "";
  const bodyRows = file.rows
    .map((row) => {
      const cells = file.columns.map((column) => `<td>${escapeHtml(row.values[column.id] ?? "")}</td>`).join("");
      return `      <tr>${cells}</tr>\n`;
    })
    .join("");

  return `<!DOCTYPE html>
<html data-format="table" data-format-version="${escapeHtml(file.version)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
</head>
<body>

${metadata}

  <table data-role="data"${layout}>
    <thead>
      <tr>
${headerCells}      </tr>
    </thead>
    <tbody>
${bodyRows}    </tbody>
  </table>
${cardBlock(file.card)}
</body>
</html>
`;
}
