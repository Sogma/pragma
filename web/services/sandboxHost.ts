// What the host writes into an Applet's page before it runs: its CSP, the
// `pragma` client, the standard style when the manifest asks for it, and an
// import map for its packages.
import type { AppletImportSource } from "../../src/protocol/api.ts";
import type { AppletManifest } from "../../src/protocol/types.ts";
import { bytesToBase64 } from "../lib/base64.ts";

// Report our content height so the host grows the iframe to fit and
// scrolls it with the editor title bar, rather than the iframe scrolling
// internally under a pinned title.
//
// scrollHeight, not the iframe box: it stays the real content height
// whatever height the host just set.
const HEIGHT_REPORT = `
  var lastReportedHeight = -1;
  function reportHeight() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (h === lastReportedHeight) return;
    lastReportedHeight = h;
    window.parent.postMessage({ source: "pragma-applet", type: "resize", height: h }, "*");
  }
  if (window.ResizeObserver) new ResizeObserver(reportHeight).observe(document.documentElement);
  window.addEventListener("load", reportHeight);
  document.addEventListener("DOMContentLoaded", reportHeight);
`;

// What an Applet sees as `window.pragma` when it runs on its own: a Flow
// node's calls, inert, so one file serves both ways (see nodeClientScript
// below). On its own an Applet touches nothing, so there is nothing to call.
// Inlined for the reason at the injection helper below.
const PRAGMA_CLIENT_SCRIPT = `
(function () {
  window.pragma = {
    state: undefined,
    setState: function () {},
    setOutputs: function () {},
    onInputs: function () {},
  };
${HEIGHT_REPORT}
})();
`;

// The "standard pragma look" an applet opts into via its manifest's
// `style: "default"` — base rules for the form controls a real applet has
// needed (see docs/protocol.md's Applets → Standard style). Inlined for the
// reason given at the injection helper below.
//
// The frame can't read pragma's tokens, so :root holds copies of them, light
// and dark, each held to its web/styles/tokens.css value by a test.
const PRAGMA_APPLET_STYLE = `
:root {
  color-scheme: light dark;
  --bg-primary: #fff;
  --text-primary: #1c1c1a;
  --border: #ccc;
  --border-muted: #eee;
  --text-muted: #888;
  --bg-hover: #f0f0f0;
  --danger: #e93147;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg-primary: #101111;
    --text-primary: #ccc;
    --border: #333;
    --border-muted: #292929;
    --text-muted: #868686;
    --bg-hover: #2a2a2a;
    --danger: #c70c2a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 24px;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-primary);
}
.form { max-width: 70ch; margin: 0 auto; }
h1 { font-size: 18px; margin: 0 0 4px; }
.description { font-size: 13px; color: var(--text-muted); margin: 0 0 20px; }
.field { display: flex; flex-direction: column; gap: 6px; padding: 14px 0; border-bottom: 1px solid var(--border-muted); }
.field label { font-size: 13px; font-weight: 600; }
.field textarea, .field select {
  font: inherit;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
}
.field textarea { resize: vertical; min-height: 3em; }
.checkbox-field label { display: flex; align-items: center; gap: 8px; font-weight: normal; }
button {
  font: inherit;
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-primary);
  cursor: pointer;
  align-self: flex-start;
}
button:hover { background: var(--bg-hover); }
button:disabled { opacity: 0.5; cursor: default; }
.error { color: var(--danger); font-size: 13px; }
`;

// A `</script` anywhere in an inline script's text — even in a comment or a
// string literal — ends the <script> element for the HTML parser, silently
// truncating the rest. A backslash breaks the sequence without changing the
// running code: harmless in a comment, and `\/` is just `/` in a JS string.
// Belt-and-braces around hand-maintained client scripts.
function wrapInlineScript(body: string): string {
  return `<script>${body.replace(/<\/script/gi, "<\\/script")}</script>`;
}

// Only data: and blob: URLs load, and neither leaves the frame (see
// docs/protocol.md's Network section). Every subresource is refused, not just
// fetch: an <img> carries data out in its URL, and a <script src> would run
// code the grant's content hash never saw. Script is arbitrary anyway, so eval
// and wasm cost nothing. The frame navigating itself is index.html's to refuse.
const SANDBOX_CSP_TAG = `<meta http-equiv="Content-Security-Policy" content="${[
  "default-src data: blob:",
  "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
  "style-src 'unsafe-inline' data: blob:",
].join("; ")}">`;

// A policy governs only what the parser reaches after it, so it goes ahead of
// every guest byte, a <script src> above <head> included. After the doctype,
// though: anything before one puts the document in quirks mode.
const LEADING_DOCTYPE = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i;

// Inserts the tags right after <head> (else after <html>, else as a prefix —
// the last resort, since content before <!DOCTYPE html> can trip quirks mode)
// so window.pragma exists before any guest script runs, and an applet's own
// later <style> wins the cascade without specificity fights.
//
// Inlined, not fetched: a passphrase deployment's SameSite=Lax session cookie
// (passphraseAuth.ts) never rides a sandboxed iframe's cross-site subresource
// request, so a URL back to pragma would 302 to login on the remote-access
// target.
function injectIntoDocument(html: string, tags: string, afterPolicy = ""): string {
  const policyAt = LEADING_DOCTYPE.exec(html)?.[0].length ?? 0;
  const policy = html.slice(0, policyAt) + SANDBOX_CSP_TAG + afterPolicy;
  const rest = html.slice(policyAt);
  if (/<head[\s>]/i.test(rest)) return policy + rest.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${tags}`);
  if (/<html[\s>]/i.test(rest))
    return policy + rest.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${tags}</head>`);
  return policy + tags + rest;
}

// The client an Applet sees as a Flow node: it touches nothing; it reports
// state and outputs for the host to save, and
// hears its inputs after a run. `state` is what it last reported, written in
// as a JSON literal with `<` escaped so it can't end the script element.
function nodeClientScript(state: unknown): string {
  const stateLiteral = JSON.stringify(state ?? null).replace(/</g, "\\u003c");
  return `
(function () {
  var inputListeners = [];
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "pragma-host" || data.type !== "inputs") return;
    for (var i = 0; i < inputListeners.length; i++) inputListeners[i](data.inputs);
  });
  function post(type, payload) {
    window.parent.postMessage(Object.assign({ source: "pragma-applet", type: type }, payload), "*");
  }
  window.pragma = {
    state: ${stateLiteral},
    setState: function (value) {
      post("state", { value: value });
    },
    // Keyed by output port id; an image port takes a canvas's data URL.
    setOutputs: function (outputs) {
      post("outputs", { outputs: outputs });
    },
    onInputs: function (listener) {
      inputListeners.push(listener);
    },
  };
${HEIGHT_REPORT}
})();
`;
}

export function injectAppletNodeRuntime(
  html: string,
  manifest: AppletManifest,
  imports: readonly AppletImportSource[],
  state: unknown,
): string {
  let tags = wrapInlineScript(nodeClientScript(state));
  if (manifest.style === "default") tags += `<style>${PRAGMA_APPLET_STYLE}</style>`;
  return injectIntoDocument(html, tags, importMapTag(imports));
}

export function injectAppletRuntime(
  html: string,
  manifest: AppletManifest,
  imports: readonly AppletImportSource[] = [],
): string {
  let tags = wrapInlineScript(PRAGMA_CLIENT_SCRIPT);
  if (manifest.style === "default") tags += `<style>${PRAGMA_APPLET_STYLE}</style>`;
  return injectIntoDocument(html, tags, importMapTag(imports));
}

// Each import as a data: URL, not a blob: one: a blob URL this page makes
// belongs to its origin, which the opaque-origin frame doesn't share. The map
// sits right after the policy because a module script resolves against the
// maps that precede it. `<` is escaped so no specifier can end the element.
function importMapTag(imports: readonly AppletImportSource[]): string {
  if (imports.length === 0) return "";
  const map = Object.fromEntries(
    imports.map((entry) => [entry.specifier, `data:text/javascript;base64,${base64Utf8(entry.source)}`]),
  );
  return `<script type="importmap">${JSON.stringify({ imports: map }).replace(/</g, "\\u003c")}</script>`;
}

function base64Utf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}
