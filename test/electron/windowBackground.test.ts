import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { windowBackground } from "../../electron/windowBackground.ts";

// Led by a newline, so a block that opens the file is found like any other.
const css = `\n${readFileSync(new URL("../../web/styles/tokens.css", import.meta.url), "utf8")}`;

function token(block: string, name: string): string | undefined {
  const start = css.indexOf(`\n${block} {\n`);
  const body = css.slice(start, css.indexOf("\n}", start));
  return new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(body)?.[1]?.trim();
}

describe("windowBackground", () => {
  it("is the page's background in the light theme", () => {
    expect(windowBackground({ shouldUseDarkColors: false })).toBe(token(":root", "--bg-primary"));
  });

  it("is the page's background in the dark theme", () => {
    expect(windowBackground({ shouldUseDarkColors: true })).toBe(token('html[data-theme="dark"]', "--bg-primary"));
  });
});
