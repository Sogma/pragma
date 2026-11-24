import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPACE_ICON } from "../../../web/lib/spaceIcon.ts";

// sidebar.css lights the icon by its parts' classes, so a class renamed on one
// side alone leaves that part in the button's text colour, unnoticed.
describe("the Space icon", () => {
  it("has one colour rule for each of its parts' classes, and none besides", () => {
    const css = readFileSync(new URL("../../../web/styles/sidebar.css", import.meta.url), "utf8");
    const parts = new Set([...SPACE_ICON.matchAll(/class="([\w-]+)"/g)].map(([, name]) => name));
    const lit = [...css.matchAll(/\.(space-icon-[\w-]+)/g)].map(([, name]) => name);
    expect(lit.sort()).toEqual([...parts].sort());
  });
});
