import { expect, type Locator, type Page, test } from "@playwright/test";
import { treeRow } from "./tree.ts";

// A note formatted while it is edited, and the ⋮ menu's Source mode, end to
// end: the syntax the caret reveals, a wikilink opened by a click and a
// checkbox's one-character write need real layout and real clicks.

async function toggleSourceMode(page: Page): Promise<void> {
  await page.locator('.editor-toolbar-box button[aria-label="More options"]').click();
  await page.locator(".context-menu button", { hasText: "Source mode" }).click();
}

// The editor line at the top edge of its scroller, read two frames on, once
// the editor has drawn the lines a scroll showed. A blank line there gives
// way to the last one above it with text.
async function topLine(editor: Locator): Promise<string> {
  return editor.evaluate(async (element) => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const scroller = element.closest(".editor-document");
    if (!scroller) return "";
    const edge = scroller.getBoundingClientRect().top + 1;
    let text = "";
    for (const row of element.querySelectorAll(".cm-line")) {
      if (row.getBoundingClientRect().top <= edge && row.textContent?.trim()) text = row.textContent;
    }
    return text;
  });
}

test("formats a note while it is edited, opens a wikilink on a click, and keeps Source mode", async ({
  page,
  request,
}) => {
  const name = `formatting-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "# Plan\n\nSee **this** and [[README]].\n\n- [ ] first\n" },
  });
  expect(created.ok()).toBe(true);

  // With Hide format syntax off, the caret shows the syntax it touches.
  await page.addInitScript(() => localStorage.setItem("pragma:hide-format-syntax", "false"));
  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  const prose = editor.locator(".cm-line", { hasText: /^See / });
  await expect(prose).toHaveText("See this and README.");

  // The caret in the title shows its # in the margin; leaving it hides it.
  const title = page.locator(".editor-document .editor-title-input");
  const titleMark = () =>
    page
      .locator(".editor-document > .editor-title-bar > .editor-title-inner")
      .evaluate((inner) => getComputedStyle(inner, "::before").content);
  await title.click();
  await expect.poll(titleMark).toContain("#");
  await title.blur();
  await expect.poll(titleMark).toBe("none");

  // The caret on the bold word shows its marks; moving it away hides them.
  await prose.locator(".cm-md-strong").click();
  await expect(prose).toHaveText("See **this** and README.");
  await page.keyboard.press("End");
  await expect(prose).toHaveText("See this and README.");

  // The checkbox writes the one character between its brackets.
  await editor.locator("input.cm-md-task").click();
  await expect
    .poll(async () => ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content)
    .toContain("- [x] first");

  // A wikilink opens its file in place, as reading view's does.
  await prose.locator(".cm-md-link").click();
  await expect(editor).toContainText("This is a Pragma space");
  await (await treeRow(page, name)).click();

  // Source mode shows the whole file as written, through reading view and a
  // reload: its title's heading is a line of the text, not a title bar.
  await toggleSourceMode(page);
  await expect(prose).toHaveText("See **this** and [[README]].");
  await expect(editor.locator(".cm-line").first()).toHaveText("# Plan");
  await expect(page.locator(".editor-document > .editor-title-bar")).toHaveCount(0);
  const toggle = page.locator(".editor-toolbar-reading-toggle");
  await toggle.click();
  await expect(prose).toBeHidden();
  await toggle.click();
  await expect(prose).toHaveText("See **this** and [[README]].");
  await page.reload();
  await expect(prose).toHaveText("See **this** and [[README]].");

  // The tests share one saved layout, so the group leaves formatted.
  await toggleSourceMode(page);
  await expect(prose).toHaveText("See this and README.");
});

// Sized headings change every height below them, so a switch holds the line
// at the top by line, not by pixel.
test("keeps the line at the top in place across a switch into and out of Source mode", async ({ page, request }) => {
  const name = `formatting-place-${Date.now()}.md`;
  const parts = Array.from({ length: 30 }, (_, part) => `## Part ${part + 1}\n\nWords of part ${part + 1}.`);
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: `# Long\n\n${parts.join("\n\n")}\n` },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const editor = page.locator(".editor-cm");
  await expect(editor.locator(".cm-line").first()).toHaveText("Part 1");
  await page.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop = 1200;
  });
  await expect.poll(() => topLine(editor)).toMatch(/^(Part|Words of part) \d+/);
  const before = await topLine(editor);

  // Source mode shows the whole file, its title's heading first.
  await toggleSourceMode(page);
  await expect(editor.locator(".cm-line").first()).toHaveText("# Long");
  await expect.poll(() => topLine(editor)).toBe(before.startsWith("Part") ? `## ${before}` : before);

  await toggleSourceMode(page);
  await expect.poll(() => topLine(editor)).toBe(before);
});

// The Format column turned on from ⋮, under the toolbar's box, and its writes
// reaching the file: a press on a button leaves the selection it acts on.
test("turns the Format column on from ⋮ and writes a mark and a kind of line from it", async ({ page, request }) => {
  const name = `format-column-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "# Notes\n\nOne word here\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const column = page.locator(".format-column");
  await expect(column).toBeHidden();
  await page.locator('.editor-toolbar-box button[aria-label="More options"]').click();
  await page.locator(".context-menu button", { hasText: /^Format…$/ }).click();
  await expect(column).toBeVisible();
  // Measured once it has slid into place.
  await expect(column).not.toHaveClass(/is-opening/);

  const box = await page.locator(".editor-toolbar-box").boundingBox();
  const drawn = await column.boundingBox();
  if (!box || !drawn) throw new Error("the toolbar's box or the column isn't laid out");
  expect(Math.round(drawn.x + drawn.width)).toBe(Math.round(box.x + box.width));
  expect(drawn.y).toBeGreaterThan(box.y + box.height);

  await page.locator(".editor-cm .cm-line", { hasText: "One word" }).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Control+Shift+ArrowLeft");
  await column.locator('button[aria-label="Bold"]').click();
  await expect.poll(content).toContain("One word **here**");

  await column.locator('button[aria-label="Formatting"]').click();
  await page.locator(".context-menu button", { hasText: "Heading 2" }).click();
  await expect.poll(content).toContain("## One word **here**");

  // Heading 1 is the title, which the bar holds: the cursor goes there.
  await column.locator('button[aria-label="Formatting"]').click();
  await page.locator(".context-menu button", { hasText: "Heading 1" }).click();
  await expect(page.locator(".editor-title-input")).toBeFocused();
  expect(await content()).toContain("# Notes\n\n## One word **here**");
});

// A drag on the column's foot, measured on the real layout: two tools' worth
// brings Strikethrough and Highlight in below Link, and the count holds
// across a reload.
test("drags the Format column's foot to bring more tools in", async ({ page, request }) => {
  const name = `format-column-drag-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "# Notes\n\nOne word here\n" },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const column = page.locator(".format-column");
  await page.locator('.editor-toolbar-box button[aria-label="More options"]').click();
  await page.locator(".context-menu button", { hasText: /^Format…$/ }).click();
  await expect(column).not.toHaveClass(/is-opening/);
  const labels = () =>
    column
      .locator("button")
      .evaluateAll((buttons) =>
        buttons.filter((button) => !(button as HTMLElement).hidden).map((button) => button.getAttribute("aria-label")),
      );
  expect((await labels()).slice(0, 4)).toEqual(["Formatting", "Bold", "Italic", "Code"]);

  const handle = await column.locator(".format-column-handle").boundingBox();
  if (!handle) throw new Error("the column's handle isn't laid out");
  const x = Math.round(handle.x + handle.width / 2);
  const y = Math.round(handle.y + handle.height / 2);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 64, { steps: 8 });
  await page.mouse.up();
  expect((await labels()).slice(0, 7)).toEqual([
    "Formatting",
    "Bold",
    "Italic",
    "Code",
    "Link",
    "Strikethrough",
    "Highlight",
  ]);

  await page.reload();
  await expect(column).toBeVisible();
  await expect(column.locator('button[aria-label="Highlight"]')).toBeVisible();
});

// A screenplay's column writes plain Fountain or a forcing mark from its
// picker, and Ctrl+U reaches Underline past CodeMirror's own binding for it.
test("writes a screenplay's scene heading from the picker and underlines a word with Ctrl+U", async ({
  page,
  request,
}) => {
  const name = `format-column-${Date.now()}.fountain`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "Snow falls on the roof.\n\nThe cellar stairs\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  await page.goto("/");
  await (await treeRow(page, name)).click();
  await page.locator('.editor-toolbar-box button[aria-label="More options"]').click();
  await page.locator(".context-menu button", { hasText: /^Format…$/ }).click();
  const column = page.locator(".format-column");
  await expect(column).toBeVisible();

  await page.locator(".editor-cm .cm-line", { hasText: "The cellar stairs" }).click();
  await column.locator('button[aria-label="Formatting"]').click();
  await page.locator(".context-menu button", { hasText: /^Scene heading$/ }).click();
  await expect.poll(content).toContain("\n.The cellar stairs\n");

  await page.locator(".editor-cm .cm-line", { hasText: "Snow falls" }).click();
  await page.keyboard.press("Home");
  for (let step = 0; step < 6; step++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+u");
  await expect.poll(content).toContain("Snow _falls_ on the roof.");
});

// Hide format syntax's rules need a real caret: arrows over hidden marks, a
// blank typed at a run's end, Mod+B stepping out of the run, and Backspace
// back into it.
test("keeps a note's syntax hidden at the caret, as Hide format syntax does by default", async ({ page, request }) => {
  const name = `hidden-syntax-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "# Plan\n\nSee **this** word.\n" },
  });
  expect(created.ok()).toBe(true);
  const content = async () =>
    ((await (await request.get(`/api/file?path=${name}`)).json()) as { content: string }).content;

  await page.goto("/");
  await expect(page.locator("#setting-hide-format-syntax")).toHaveAttribute("aria-checked", "true");
  await (await treeRow(page, name)).click();
  const prose = page.locator(".editor-cm .cm-line", { hasText: "See" });
  await prose.click();
  await page.keyboard.press("Home");
  for (let step = 0; step < 8; step++) await page.keyboard.press("ArrowRight");
  await expect(prose).toHaveText("See this word.");

  await page.keyboard.type(" bold");
  await page.keyboard.press("Control+b");
  await page.keyboard.type(" plain");
  await expect(prose).toHaveText("See this bold plain word.");
  await expect.poll(content).toContain("See **this bold** plain word.");

  for (let step = 0; step < 6; step++) await page.keyboard.press("Backspace");
  await page.keyboard.type("!");
  await expect(prose).toHaveText("See this bold! word.");
  await expect.poll(content).toContain("See **this bold!** word.");
});

test("opens a link's menu above Cut, Copy and Paste, the link kept folded, and opens it in a new tab", async ({
  page,
  request,
}) => {
  const name = `link-menu-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: "# Links\n\nSee [[README]] first.\n" },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  await (await treeRow(page, name)).click();
  const prose = page.locator(".editor-cm .cm-line", { hasText: /^See / });
  await expect(prose).toHaveText("See README first.");
  const pills = page.locator(".editor-group-tabs").first().locator(".editor-tab");
  const before = await pills.count();

  await prose.locator('[data-space-path="README.md"]').click({ button: "right" });
  const menu = page.locator(".context-menu");
  await expect(menu.locator("button")).toHaveText([
    "Open",
    "Open in new tab",
    "Open to the side",
    "Reveal in links",
    "Cut",
    "Copy",
    "Paste",
    "Select All",
  ]);
  // A caret put in the link would show its brackets under the menu.
  await expect(prose).toHaveText("See README first.");

  await menu.locator("button", { hasText: "Open in new tab" }).click();
  await expect(pills).toHaveCount(before + 1);
  await expect(page.locator(".editor-tab.active .editor-tab-label")).toHaveText("README");

  // Later tests restore this layout, so the tab opened here goes again, and
  // the note with it.
  await page.locator(".editor-tab.active .editor-tab-close").click();
  await expect(pills).toHaveCount(before);
  const deleted = await request.post("/api/space/delete", { data: { path: name, trash: false } });
  expect(deleted.ok()).toBe(true);
});
