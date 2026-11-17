import { metadataBlock } from "./tableHtml.ts";
import type { FlowFile } from "./types.ts";

// Pure string-building, no Node/DOM APIs — same isomorphic reasoning as
// tableHtml.ts (see its header comment): both server (scaffolding a new
// file) and client (persisting a graph edit) call this exact function
// rather than each re-deriving their own serialization.

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// `</script>` inside embedded JSON (e.g. a prompt node's config text
// containing that literal substring) would otherwise terminate the script
// block early — the same escaping an applet's manifest block needs.
function escapeScriptContent(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

/** Serializes a flow's metadata and graph back to `.flow.html` text —
 * takes `Omit<FlowFile, "html">` since `html` is an *output* of
 * serializing, not an input a caller would have on hand. Node/edge order is
 * exactly the order of the `graph.nodes`/`graph.edges` arrays passed in —
 * byte-stable for unchanged content. */
export function serializeFlowFile(file: Omit<FlowFile, "html">): string {
  const graphJson = escapeScriptContent(JSON.stringify(file.graph));

  return `<!DOCTYPE html>
<html data-format="flow" data-format-version="${escapeHtml(file.version)}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(file.name ?? "")}</title>
  <script type="application/json" data-role="graph">${graphJson}</script>
</head>
<body>

${metadataBlock(file.metadata)}

</body>
</html>
`;
}
