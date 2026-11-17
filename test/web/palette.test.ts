import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tokens.css promises every palette colour clears 3:1 against the surfaces
// it sits on, in both themes; the logo's own hexes don't, on the light ones.
const stylesDir = fileURLToPath(new URL("../../web/styles", import.meta.url));
// Led by a newline, so a block that opens the file is found like any other.
const css = `\n${readFileSync(path.join(stylesDir, "tokens.css"), "utf8")}`;
const SURFACES = ["--bg-primary", "--bg-secondary", "--bg-hover"];
const PALETTE = ["green", "cyan", "blue", "yellow", "orange", "red", "crimson"];

function tokenBlock(opening: string): Map<string, string> {
  const start = css.indexOf(`\n${opening} {\n`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return new Map([...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map(([, name, value]) => [name, value.trim()]));
}

const light = tokenBlock(":root");
const themes = { light, dark: new Map([...light, ...tokenBlock('html[data-theme="dark"]')]) };

function hexOf(tokens: Map<string, string>, name: string): string {
  const value = tokens.get(name);
  if (!value?.match(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i)) throw new Error(`${name} is not a hex colour: ${value}`);
  return value.length === 4 ? `#${[...value.slice(1)].map((digit) => digit + digit).join("")}` : value;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const sorted = (names: Iterable<string>) => [...new Set(names)].sort();

describe("the pragma palette", () => {
  for (const [theme, tokens] of Object.entries(themes)) {
    it(`clears 3:1 against every surface in the ${theme} theme`, () => {
      const short = PALETTE.flatMap((hue) =>
        SURFACES.map((surface) => ({
          hue,
          surface,
          ratio: contrast(hexOf(tokens, `--pragma-${hue}`), hexOf(tokens, surface)),
        }))
          .filter(({ ratio }) => ratio < 3)
          .map(({ hue, surface, ratio }) => `${hue} on ${surface}: ${ratio.toFixed(2)}`),
      );

      expect(short).toEqual([]);
    });
  }

  it("has a token for each of its colours, and none besides", () => {
    expect(sorted([...css.matchAll(/--pragma-([\w-]+):/g)].map(([, name]) => name))).toEqual(sorted(PALETTE));
  });

  it("gives each view a palette colour", () => {
    const views = [...css.matchAll(/^\s*--view-([\w-]+): var\(--pragma-([\w-]+)\);/gm)];

    expect(views.map(([, view]) => view).sort()).toEqual([
      "bookmarks",
      "library",
      "search",
      "source-control",
      "space",
      "websites",
    ]);
    expect(views.filter(([, , hue]) => !PALETTE.includes(hue)).map(([line]) => line.trim())).toEqual([]);
  });

  it("is read in web/styles by the names it defines only", () => {
    const views = new Set([...css.matchAll(/--view-([\w-]+):/g)].map(([, name]) => name));
    const stray = readdirSync(stylesDir, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .flatMap((file) =>
        [...readFileSync(path.join(stylesDir, file), "utf8").matchAll(/var\(--(pragma|view)-([\w-]+)\)/g)]
          .filter(([, family, name]) => !(family === "pragma" ? PALETTE.includes(name) : views.has(name)))
          .map(([read]) => `${file}: ${read}`),
      );

    expect(stray).toEqual([]);
  });
});
