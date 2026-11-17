// @vitest-environment jsdom
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, URL as NodeURL } from "node:url";
import { MathJaxMhchemFontExtension } from "@mathjax/mathjax-mhchem-font-extension/js/chtml.js";
import { MathJaxTexFont } from "@mathjax/mathjax-tex-font/js/chtml.js";
import { describe, expect, it } from "vitest";
import { mathEngine } from "../../web/mathJax.ts";

// jsdom replaces the global URL, which takes no file: address.
const root = fileURLToPath(new NodeURL("../..", import.meta.url));

describe("the MathJax engine", () => {
  const engine = mathEngine();

  it("typesets TeX as HTML, inline or as display math", () => {
    const inline = engine.render("x^2", false);
    expect(inline.localName).toBe("mjx-container");
    expect(inline.hasAttribute("display")).toBe(false);
    expect(inline.querySelector("mjx-msup")).not.toBeNull();
    expect(engine.render("\\frac{a}{b}", true).getAttribute("display")).toBe("true");
  });

  it("keeps only web links, each opening outside the app", () => {
    expect(engine.render("\\href{javascript:alert(1)}{x}", false).querySelector("a")).toBeNull();
    expect(engine.render("\\href{notes/a.md}{x}", false).querySelector("a")).toBeNull();
    const link = engine.render("\\href{https://example.com}{x}", false).querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("keeps a formula's classes and styles off the app's", () => {
    const node = engine.render("\\class{dialog-close}{x} \\style{position:fixed}{y}", false);
    expect(node.querySelector(".dialog-close")).toBeNull();
    const styles = [...node.querySelectorAll("[style]")].map((el) => el.getAttribute("style"));
    expect(styles.join(";")).not.toContain("position");
  });

  it("shows an error as the TeX, its message as the app's hover hint", () => {
    const error = engine.render("\\frac{a", false).querySelector("mjx-merror");
    expect(error?.textContent).toBe("\\frac{a");
    expect(error?.getAttribute("data-tooltip")).toBe("Missing close brace");
    expect(error?.hasAttribute("title")).toBe(false);
  });

  it("typesets chemistry", () => {
    expect(engine.render("\\ce{H2O ->[heat] H2 + O2}", false).querySelector("mjx-merror")).toBeNull();
  });

  it("turns physics on for the session only when a formula asks", () => {
    const undefinedMacro = (node: HTMLElement) => node.querySelector('mjx-mtext[style*="red"]') !== null;
    const before = engine.generation;
    expect(undefinedMacro(engine.render("\\dv{x}{t}", false))).toBe(true);
    expect(engine.render("\\usepackage{physics} \\dv{x}{t}", false).querySelector("mjx-mfrac")).not.toBeNull();
    expect(engine.generation).toBe(before + 1);
    expect(engine.render("\\dv{y}{t}", false).querySelector("mjx-mfrac")).not.toBeNull();
    engine.render("\\require{physics}", false);
    expect(engine.generation).toBe(before + 1);
  });

  it("calls a package it doesn't have an error", () => {
    const error = engine.render("\\usepackage{amsmath} x", false).querySelector("mjx-merror");
    expect(error?.getAttribute("data-tooltip")).toBe("Unknown package amsmath");
  });

  it("adds its stylesheet to the page once, naming no font file", () => {
    engine.updateStyles();
    engine.render("\\mathfrak{A}", false);
    engine.updateStyles();
    const sheets = document.head.querySelectorAll<HTMLStyleElement>("#MJX-CHTML-styles");
    expect(sheets).toHaveLength(1);
    const rules = [...(sheets[0].sheet?.cssRules ?? [])].map((rule) => rule.cssText).join("\n");
    const css = `${sheets[0].textContent}\n${rules}`;
    expect(css).toContain("mjx-container");
    expect(css).not.toMatch(/@font-face|url\(/);
  });
});

describe("web/styles/math.css", () => {
  // Each face the stylesheet declares, family to file.
  const declared = new Map(
    [
      ...readFileSync(path.join(root, "web/styles/math.css"), "utf8").matchAll(
        /@font-face\s*\{\s*font-family:\s*"([^"]+)";\s*src:\s*url\("([^"]+)"\)/g,
      ),
    ].map(([, family, url]) => [family, url]),
  );

  it("declares each face MathJax names, from the file it names", () => {
    const fonts = (
      MathJaxTexFont as unknown as { defaultFonts: Record<string, { "font-family": string; src: string }> }
    ).defaultFonts;
    const named = new Map(
      Object.values(fonts).map((face) => [face["font-family"], face.src.match(/\/([^/"]+\.woff2)/)?.[1]]),
    );
    for (const family of MathJaxMhchemFontExtension.fonts ?? []) named.set(family, `${family.toLowerCase()}.woff2`);
    expect(named.size).toBeGreaterThan(20);
    expect([...declared.keys()].sort()).toEqual([...named.keys()].sort());
    for (const [family, file] of named) expect(path.basename(declared.get(family) ?? "")).toBe(file);
  });

  it("points each face at a file the font package ships", () => {
    for (const url of declared.values()) expect(existsSync(path.join(root, "web/styles", url))).toBe(true);
  });
});
