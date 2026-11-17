import { escapeHtml, fieldHeaderCell, metadataBlock } from "./tableHtml.ts";
import type { ClassFile, ClassRule, ClassView } from "./types.ts";

// Pure string-building, isomorphic as a Table's serializer is, and
// byte-stable for unchanged content.

function rule(rule: ClassRule, indent: string): string {
  return `${indent}<li data-property="${escapeHtml(rule.property)}" data-test="${escapeHtml(rule.test)}">${escapeHtml(rule.values.join(", "))}</li>\n`;
}

// A layout is written only when it isn't the list, and an order only when
// it is descending, as a Table writes its layout.
function view(view: ClassView): string {
  const attributes = [
    ` data-name="${escapeHtml(view.name)}"`,
    view.layout !== "list" ? ` data-layout="${escapeHtml(view.layout)}"` : "",
    view.sort ? ` data-sort="${escapeHtml(view.sort.property)}"` : "",
    view.sort?.order === "desc" ? ` data-order="desc"` : "",
    view.groupBy ? ` data-group-by="${escapeHtml(view.groupBy)}"` : "",
    view.fields ? ` data-fields="${escapeHtml(view.fields.join(","))}"` : "",
  ].join("");
  if (view.filter.length === 0) return `    <li${attributes}></li>\n`;
  const rules = view.filter.map((each) => rule(each, "        ")).join("");
  return `    <li${attributes}>\n      <ul data-role="filter">\n${rules}      </ul>\n    </li>\n`;
}

// Left out when empty, so a Class with no links is written as it was
// before there were any.
function links(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  const items = paths.map((path) => `    <li>${escapeHtml(path)}</li>\n`).join("");
  return `\n  <ul data-role="links">\n${items}  </ul>\n`;
}

/** Serializes a ClassFile back to `.class.html` text, in the order
 * its arrays hold. */
export function serializeClassFile(file: ClassFile): string {
  const filter = file.filter.map((each) => rule(each, "    ")).join("");
  const fields = file.fields.map(fieldHeaderCell).join("");
  const views = file.views.map(view).join("");

  return `<!DOCTYPE html>
<html data-format="class" data-format-version="${escapeHtml(file.version)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(file.name ?? "")}</title>
</head>
<body>

${metadataBlock(file.metadata)}

  <ul data-role="filter">
${filter}  </ul>
${links(file.links)}
  <table data-role="fields">
    <thead>
      <tr>
${fields}      </tr>
    </thead>
  </table>

  <ol data-role="views">
${views}  </ol>

</body>
</html>
`;
}
