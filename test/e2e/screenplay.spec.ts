import { expect, test } from "@playwright/test";
import { treeRow } from "./tree.ts";

// A screenplay's reading view is its own editor, locked, with the lines
// Fountain never prints hidden. A switch back made at the very top has to
// land there too, or the opening synopsis comes back out of sight.
test("a screenplay switched back from reading view at the top shows its opening synopsis", async ({
  page,
  request,
}) => {
  const name = `reading-top-${Date.now()}.fountain`;
  const action = Array.from({ length: 60 }, (_, beat) => `Snow falls on the roof, beat ${beat + 1}.`).join("\n\n");
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: `= The whole scene.\n\nEXT. SNOW - DAY\n\n${action}\n` },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  const synopsis = editor.locator(".cm-line", { hasText: "The whole scene." });
  await expect(synopsis).toBeInViewport({ ratio: 1 });

  const toggle = page.locator(".editor-toolbar-reading-toggle");
  await toggle.click();
  await expect(synopsis).toHaveCount(0);
  await expect(editor.locator(".cm-line").first()).toHaveText("EXT. SNOW - DAY");

  await toggle.click();
  await expect(synopsis).toBeInViewport({ ratio: 1 });
  await expect.poll(() => editor.locator(".cm-scroller").evaluate((scroller) => scroller.scrollTop)).toBe(0);
});

// Hide format syntax holds for a screenplay too: the caret at a forced
// heading's start goes after its `.`, and a bold word keeps its marks hidden
// while Ctrl+B steps out of it.
test("keeps a screenplay's syntax hidden at the caret, as Hide format syntax does by default", async ({
  page,
  request,
}) => {
  const name = `hidden-fountain-${Date.now()}.fountain`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: ".the cellar\n\nShe opens **the** door.\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  const heading = editor.locator(".cm-line", { hasText: "the cellar" });
  await heading.click();
  await page.keyboard.press("Home");
  await page.keyboard.type("dark ");
  await expect(heading).toHaveText("dark the cellar");
  await expect.poll(content).toContain(".dark the cellar\n");

  const action = editor.locator(".cm-line", { hasText: "She opens" });
  await action.click();
  await page.keyboard.press("Home");
  for (let step = 0; step < 13; step++) await page.keyboard.press("ArrowRight");
  await expect(action).toHaveText("She opens the door.");
  await page.keyboard.press("Control+b");
  await page.keyboard.type(" old");
  await expect(action).toHaveText("She opens the old door.");
  await expect.poll(content).toContain("She opens **the** old door.");
});

// Return and Tab write a screenplay's blank lines and cues: a scene typed
// with no blank line of the writer's own, its second cue picked from the
// script's names.
test("writes a scene's blank lines and cues from Return and Tab", async ({ page, request }) => {
  const name = `typing-${Date.now()}.fountain`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "INT. KITCHEN - NIGHT\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  await editor.locator(".cm-line", { hasText: "INT. KITCHEN" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("The tap drips.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("maria");
  await page.keyboard.press("Enter");
  await expect(editor.locator(".cm-line.cm-fountain-character")).toHaveText("MARIA");
  await expect(editor.locator(".cm-line.cm-fountain-dialogue")).toHaveCount(1);
  await page.keyboard.type("Not again.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Water pools.");
  await page.keyboard.press("Enter");

  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-tooltip-autocomplete li")).toHaveText(["MARIA"]);
  // CodeMirror takes no pick in a list's first 75ms.
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Again.");
  await expect
    .poll(content)
    .toBe("INT. KITCHEN - NIGHT\n\nThe tap drips.\n\nMARIA\nNot again.\n\nWater pools.\n\nMARIA\nAgain.\n");
});

// A heading's scene number prints in both margins, out of its text: text
// typed at the end of what shows goes before the number, which a press on a
// margin selects to retype.
test("draws a scene number in the margins, typing before it and retyping it from there", async ({ page, request }) => {
  const name = `numbers-${Date.now()}.fountain`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "EXT. RUNWAY - DAY #110A#\n\nThe ramp drops.\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  // Margins wide enough to hold a number beside the page.
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  const heading = editor.locator(".cm-line", { hasText: "EXT. RUNWAY" });
  await expect(heading).toHaveAttribute("data-scene-number", "110A");
  await expect(heading).toHaveText("EXT. RUNWAY - DAY");
  const box = await heading.boundingBox();
  if (!box) throw new Error("the heading has no box");
  const middle = Math.round(box.y + box.height / 2);

  await page.mouse.click(Math.round(box.x + box.width - 20), middle);
  await page.keyboard.type(" - LATER");
  await expect.poll(content).toContain("EXT. RUNWAY - DAY - LATER #110A#\n");

  await editor.locator(".cm-line", { hasText: "The ramp" }).click();
  await page.mouse.click(Math.round(box.x - 40), middle);
  await page.keyboard.type("112");
  await expect.poll(content).toContain("EXT. RUNWAY - DAY - LATER #112#\n");
  await editor.locator(".cm-line", { hasText: "The ramp" }).click();
  await expect(heading).toHaveAttribute("data-scene-number", "112");
  await expect(heading).toHaveText("EXT. RUNWAY - DAY - LATER");
});
