import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AppletManifest } from "../../../src/protocol/types.ts";
import { injectAppletNodeRuntime, injectAppletRuntime } from "../../../web/services/sandboxHost.ts";

function manifest(overrides: Partial<AppletManifest> = {}): AppletManifest {
  return { version: "1", ...overrides };
}

const POLICY = /<meta http-equiv="Content-Security-Policy" content="[^"]*">/.source;

describe("injectAppletRuntime", () => {
  it("leads with the policy and the client script, then the guest's markup untouched", () => {
    const html = '<html lang="fr"><head data-x="1"><title>x</title></head><body>hi</body></html>';
    const result = injectAppletRuntime(html, manifest());
    expect(result).toMatch(new RegExp(`^${POLICY}<script>`));
    expect(result.endsWith(html)).toBe(true);
  });

  it("admits only data: and blob: URLs, so no request reaches the network", () => {
    const result = injectAppletRuntime("<html><head></head></html>", manifest());
    const policy = /content="([^"]*)"/.exec(result)?.[1] ?? "";
    expect(policy.split("; ")).toEqual([
      "default-src data: blob:",
      "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:",
      "style-src 'unsafe-inline' data: blob:",
    ]);
  });

  it("puts the policy ahead of every guest byte, a <script src> above <head> included", () => {
    const html = '<script src="https://example.com/x.js"></script><html><head></head></html>';
    const result = injectAppletRuntime(html, manifest());
    expect(result).toMatch(new RegExp(`^${POLICY}<script>`));
    expect(result.endsWith(html)).toBe(true);
  });

  it("leads with a doctype of its own when the guest declares one, keeping standards mode", () => {
    const html = "<!-- hi -->\n<!DOCTYPE html><html><head></head><body></body></html>";
    const result = injectAppletRuntime(html, manifest());
    expect(result).toMatch(new RegExp(`^<!DOCTYPE html>${POLICY}`));
    expect(result.endsWith(html)).toBe(true);
    expect(injectAppletRuntime("<html><body></body></html>", manifest())).toMatch(new RegExp(`^${POLICY}`));
  });

  it("maps each import to a data: URL in an import map between the policy and the guest's markup", () => {
    const html = '<!doctype html><script type="module">import "three";</script><html><head></head></html>';
    const source = "export const label = 'café ✓';";
    const result = injectAppletRuntime(html, manifest(), [{ specifier: "three", path: "lib/three.js", source }]);
    const map = new RegExp(`^<!DOCTYPE html>${POLICY}<script type="importmap">(.*?)</script><script>`).exec(result);
    expect(map).not.toBeNull();
    const url: string = JSON.parse(map?.[1] ?? "{}").imports.three;
    expect(url.startsWith("data:text/javascript;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.slice(url.indexOf(",") + 1)), (c) => c.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe(source);
  });

  it("escapes < in the import map, so no specifier can end its element", () => {
    const result = injectAppletRuntime("<html><head></head></html>", manifest(), [
      { specifier: "</script><img>", path: "x.js", source: "" },
    ]);
    expect(result).not.toContain("</script><img>");
    expect(result).toContain("\\u003c/script>\\u003cimg>");
  });

  it("adds no import map without imports", () => {
    expect(injectAppletRuntime("<html><head></head></html>", manifest())).not.toContain("importmap");
  });

  it("includes the standard style block only when manifest.style is 'default'", () => {
    const html = "<html><head></head></html>";
    const withStyle = injectAppletRuntime(html, manifest({ style: "default" }));
    const withoutStyle = injectAppletRuntime(html, manifest());
    expect(withStyle).toContain("<style>");
    expect(withoutStyle).not.toContain("<style>");
  });

  // On its own an Applet touches nothing, so its client has only a Flow
  // node's calls, inert, and nothing that posts a request.
  it("injects a client with a node's calls, inert, and no request to post", () => {
    const result = injectAppletRuntime("<html><head></head></html>", manifest());
    expect(result).toContain("window.pragma");
    expect(result).toContain("setOutputs: function () {}");
    expect(result).not.toContain("requestId");
    for (const call of ["readNote", "writeNote", "pickImage", "wireDropzone", "generate", "getPrompt"]) {
      expect(result).not.toContain(`${call}:`);
    }
  });

  it("escapes an embedded </script> sequence so it can't prematurely close the injected tag", () => {
    // The real client script never contains this, but the escaping logic
    // itself is what this pins down.
    const html = "<html><head></head></html>";
    const result = injectAppletRuntime(html, manifest());
    // The one <script> opened by injection must be closed exactly once by
    // the matching real </script>, i.e. no stray unescaped occurrence
    // earlier in the body.
    const firstOpen = result.indexOf("<script>");
    const firstClose = result.indexOf("</script>", firstOpen);
    const bodyBetween = result.slice(firstOpen + "<script>".length, firstClose);
    expect(bodyBetween).not.toMatch(/<\/script/i);
  });
});

describe("injectAppletNodeRuntime", () => {
  const html = "<!doctype html><html><head></head><body></body></html>";

  it("writes the saved state in as a literal, with < escaped so it can't end the script", () => {
    const result = injectAppletNodeRuntime(html, manifest(), [], { note: "</script><img>", lens: 50 });
    expect(result).not.toContain("</script><img>");
    const literal = /state: (\{.*?\}),\n/.exec(result)?.[1] ?? "";
    expect(JSON.parse(literal)).toEqual({ note: "</script><img>", lens: 50 });
    expect(injectAppletNodeRuntime(html, manifest(), [], undefined)).toContain("state: null,");
  });

  it("gives a node no broker, only state, outputs and inputs, behind the same policy and import map", () => {
    const result = injectAppletNodeRuntime(
      html,
      manifest(),
      [{ specifier: "three", path: "lib/three.js", source: "" }],
      {},
    );
    expect(result).toMatch(new RegExp(`^<!DOCTYPE html>${POLICY}<script type="importmap">`));
    for (const call of ["setState:", "setOutputs:", "onInputs:"]) expect(result).toContain(call);
    for (const call of ["readNote:", "writeNote:", "generate:", "pickImage:"]) expect(result).not.toContain(call);
  });

  it("is matched by inert node calls in a standalone Applet's client", () => {
    const result = injectAppletRuntime(html, manifest());
    expect(result).toContain("state: undefined,");
    expect(result).toContain("setOutputs: function () {},");
  });
});

// Led by a newline, so a block that opens the file is found like any other.
const tokensCss = `\n${readFileSync(new URL("../../../web/styles/tokens.css", import.meta.url), "utf8")}`;

function tokenBlock(opening: string): Map<string, string> {
  const start = tokensCss.indexOf(`\n${opening} {\n`);
  const body = tokensCss.slice(start, tokensCss.indexOf("\n}", start));
  return new Map([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));
}

function declared(css: string): Map<string, string> {
  return new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}

// The frame can't read pragma's tokens, so the standard style copies them:
// each custom property it declares, by the token it copies.
const COPIES: Record<string, string> = {
  "--bg-primary": "--bg-primary",
  "--text-primary": "--text-primary",
  "--border": "--border-input",
  "--border-muted": "--border-muted",
  "--text-muted": "--text-muted",
  "--bg-hover": "--bg-hover",
  "--danger": "--color-danger",
};

describe("the standard style", () => {
  const html = injectAppletRuntime("<html><head></head></html>", manifest({ style: "default" }));
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const darkAt = style.indexOf("@media (prefers-color-scheme: dark)");
  const frame = {
    light: declared(style.slice(0, darkAt)),
    dark: declared(style.slice(darkAt, style.indexOf("\n}\n", darkAt))),
  };
  const light = tokenBlock(":root");
  const pragma = { light, dark: new Map([...light, ...tokenBlock('html[data-theme="dark"]')]) };

  for (const theme of ["light", "dark"] as const) {
    it(`holds each copy at pragma's ${theme} value for its token`, () => {
      expect([...frame[theme].keys()].sort()).toEqual(Object.keys(COPIES).sort());
      for (const [copy, token] of Object.entries(COPIES)) {
        expect(frame[theme].get(copy), `${copy} copies ${token}`).toBe(pragma[theme].get(token));
      }
    });
  }
});
