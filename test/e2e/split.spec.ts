import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { openFolder, treeRow } from "./tree.ts";

// Two editor groups (docs/architecture.md's Workspace and UI ownership section), end to end: the
// one place the groups' layout, the header's strips over them and focus are
// checked together in a real browser.

async function leftEdge(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("not laid out");
  return box.x;
}

test("splits the editor, keeps each strip over its group, restores both, and merges them back", async ({ page }) => {
  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  const strips = page.locator("#header-tabs > .editor-group-tabs");

  await page.locator('.node-label[data-path="README.md"]').click();
  await groups.first().locator(".cm-content").click();
  await page.keyboard.press("Control+Backslash");
  await expect(groups).toHaveCount(2);
  await expect(strips).toHaveCount(2);
  await expect(groups.nth(1).locator(".editor-cm")).toContainText("This is a Pragma space");
  await expect(strips.nth(0)).toHaveClass(/unfocused/);
  await expect(strips.nth(1)).not.toHaveClass(/unfocused/);

  // Each group has its own status bar, the two side by side in one row.
  const bars = groups.locator(".editor-statusbar");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0)).toBeVisible();
  await expect(bars.nth(1)).toBeVisible();
  const [leftBar, rightBar] = [await bars.nth(0).boundingBox(), await bars.nth(1).boundingBox()];
  expect(leftBar?.y).toBe(rightBar?.y);
  expect(Math.abs((rightBar?.x ?? 0) - (await leftEdge(groups.nth(1))))).toBeLessThanOrEqual(1);

  // Hidden, the assistant leaves its toggle in the header, so the header's
  // tab area is narrower than the row of groups under it.
  await page.locator("#header-assistant-toggle").click();
  await expect(page.locator("#assistant")).toBeHidden();
  expect(Math.abs((await leftEdge(strips.nth(1))) - (await leftEdge(groups.nth(1))))).toBeLessThanOrEqual(1);

  await page.reload();
  await expect(groups).toHaveCount(2);
  await expect(strips.nth(1).locator(".editor-tab")).toHaveText(["README"]);
  expect(Math.abs((await leftEdge(strips.nth(1))) - (await leftEdge(groups.nth(1))))).toBeLessThanOrEqual(1);

  // The left group shows README too, so moving the right one's only tab
  // there focuses that tab, and the group it empties closes.
  await strips.nth(1).locator(".editor-tab").click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Move to the side" }).click();
  await expect(groups).toHaveCount(1);
  await expect(strips).toHaveCount(1);
  await expect(strips.first().locator(".editor-tab")).toHaveText(["README"]);
});

// A table is open in one group at a time, so moving it is how it crosses.
test("drags a tab onto the other strip, carrying a table to the other group", async ({ page }) => {
  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  const strips = page.locator("#header-tabs > .editor-group-tabs");

  await openFolder(page, "projects/getting-started");
  await page.locator('.node-label[data-path="README.md"]').click();
  await groups.first().locator(".cm-content").click();
  await page.keyboard.press("Control+Backslash");
  await expect(groups).toHaveCount(2);
  // The new group has focus, so the tree opens the table there, in place of README.
  await page.locator('.node-label[data-path="projects/getting-started/writing-prompts.table.html"]').click();
  await expect(groups.nth(1).locator(".editor-table")).toBeVisible();

  // Carried to the far end of the first strip: past README's middle, so after it.
  await carryTab(page, strips.nth(1).locator(".editor-tab"), strips.nth(0), 0.9);
  await expect(groups).toHaveCount(1);
  await expect(strips.first().locator(".editor-tab")).toHaveText(["README", "writing-prompts"]);
  await expect(groups.first().locator(".editor-table")).toBeVisible();

  // Along its own strip a drag reorders, and the group keeps showing the table.
  const pills = strips.first().locator(".editor-tab");
  await carryTab(page, pills.nth(1), pills.nth(0), 0.1);
  await expect(pills).toHaveText(["writing-prompts", "README"]);
  await expect(groups.first().locator(".editor-table")).toBeVisible();
});

// Carries a pill with the pointer to `share` of the way along `target`'s box,
// in steps, as a hand would: the drag lifts a pill only once it has moved.
async function carryTab(page: Page, pill: Locator, target: Locator, share: number): Promise<void> {
  const from = await pill.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("the pill or its target is not laid out");
  const y = from.y + from.height / 2;
  await page.mouse.move(from.x + from.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width * share, y, { steps: 12 });
  await page.mouse.up();
}

// Every test here drives the one saved layout, so each leaves a single group
// behind it, as it found.
async function closeSecondGroup(page: Page): Promise<void> {
  await page.locator("#header-tabs > .editor-group-tabs").nth(1).locator(".editor-tab-close").click();
  await expect(page.locator("#editor-groups > .editor-group")).toHaveCount(1);
}

// The text at the top edge of a group's document: the editor's line there,
// or the reading page's block. A line drawn blank, a code block's fence,
// gives way to the last one above it with text.
async function topText(group: Locator): Promise<string> {
  return group.evaluate((element) => {
    const reading = element.querySelector<HTMLElement>(".editor-reading");
    const page = reading !== null && !reading.hidden;
    const scroller = page
      ? reading
      : (element.querySelector(".editor-document.has-title") ?? element.querySelector(".cm-scroller"));
    if (!scroller) return "";
    const edge = scroller.getBoundingClientRect().top + 1;
    let text = "";
    for (const row of element.querySelectorAll(page ? "[data-line]" : ".cm-line")) {
      if (row.getBoundingClientRect().top <= edge && row.textContent?.trim()) text = row.textContent;
    }
    return text.replace(/^- /, "").trim();
  });
}

// Scrolls a group's document so the first row matching `pattern` at or below
// its top edge sits at the edge, 4px into it, and returns that row's text.
// It looks two frames on, once an editor has drawn the lines a scroll showed.
async function scrollRowToTop(group: Locator, pattern: RegExp): Promise<string> {
  return group.evaluate(
    async (element, { source, flags }) => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const match = new RegExp(source, flags);
      const reading = element.querySelector<HTMLElement>(".editor-reading");
      const page = reading !== null && !reading.hidden;
      const scroller = page
        ? reading
        : (element.querySelector<HTMLElement>(".editor-document.has-title") ??
          element.querySelector<HTMLElement>(".cm-scroller"));
      if (!scroller) throw new Error("nothing scrolls");
      const top = scroller.getBoundingClientRect().top;
      for (const row of element.querySelectorAll<HTMLElement>(page ? "li" : ".cm-line")) {
        const box = row.getBoundingClientRect();
        if (box.top < top || !match.test(row.textContent ?? "")) continue;
        scroller.scrollTop += box.top - top + 4;
        return (row.textContent ?? "").replace(/^- /, "").trim();
      }
      throw new Error(`no row matches ${match} below the top`);
    },
    { source: pattern.source, flags: pattern.flags },
  );
}

// A note of numbered list items between headings and code blocks, which
// stand taller on the page than in the text, created under a fresh name.
async function createItemsNote(request: APIRequestContext): Promise<string> {
  const name = `scroll-sync-${Date.now()}.md`;
  const parts = Array.from({ length: 12 }, (_, part) => {
    const items = Array.from({ length: 8 }, (_, item) => `- Item ${part + 1}.${item + 1}`).join("\n");
    const code = Array.from({ length: 6 }, (_, line) => `code ${part + 1}.${line + 1}`).join("\n");
    return `## Part ${part + 1}\n\n${items}\n\n\`\`\`\n${code}\n\`\`\``;
  });
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: `# Scroll test\n\n${parts.join("\n\n")}\n` },
  });
  expect(created.ok()).toBe(true);
  return name;
}

test("scrolls a note edited on one side and read on the other as one", async ({ page, request }) => {
  const name = await createItemsNote(request);

  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  await (await treeRow(page, name)).click();
  await groups.first().locator(".cm-line").first().click();
  await page.keyboard.press("Control+Backslash");
  await expect(groups).toHaveCount(2);
  const [editing, reading] = [groups.nth(0), groups.nth(1)];

  // Scrolled before the pair forms: the reading side joins at the editor's place.
  await editing.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop = 1200;
  });
  const before = await scrollRowToTop(editing, /^- Item \d+\.\d+$/);
  await reading.locator(".editor-toolbar-reading-toggle").click();
  await expect.poll(() => topText(reading)).toBe(before);
  // Each side's tab wears the pair's mark.
  await expect(page.locator(".editor-tab.active > .editor-tab-sync")).toHaveCount(2);

  // Code blocks and headings stand taller on the page than in the text, so
  // only a match by line keeps the two on one item this far down.
  await editing.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop += 2500;
  });
  const down = await scrollRowToTop(editing, /^- Item \d+\.\d+$/);
  expect(down).not.toBe(before);
  await expect.poll(() => topText(reading)).toBe(down);

  // Scrolling the page brings the editor along. The pause is the writer's:
  // a side just moved takes its next moment of scrolling for the move's echo.
  await page.waitForTimeout(200);
  await reading.locator(".editor-reading").evaluate((scroller) => {
    scroller.scrollTop -= 1500;
  });
  const back = await scrollRowToTop(reading, /^Item \d+\.\d+$/);
  expect(back).not.toBe(down);
  await expect.poll(() => topText(editing)).toBe(back);

  // Two editing views of one note each keep their own place, and wear no mark.
  await reading.locator(".editor-toolbar-reading-toggle").click();
  await expect(page.locator(".editor-tab-sync")).toHaveCount(0);
  const kept = await topText(reading);
  await editing.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop += 3000;
  });
  await page.waitForTimeout(300);
  expect(await topText(reading)).toBe(kept);
  expect(await topText(editing)).not.toBe(kept);

  await closeSecondGroup(page);
});

test("opens a note picked in the tree on both sides of a pair, from either side", async ({ page, request }) => {
  const first = await createItemsNote(request);
  const second = `pair-follow-${Date.now()}.md`;
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name: second, type: "file", content: "# Followed\n\nOpened on both sides.\n" },
  });
  expect(created.ok()).toBe(true);
  const stem = (name: string) => name.replace(/\.md$/, "");
  const shown = () =>
    page.locator("#header-tabs > .editor-group-tabs .editor-tab.active .editor-tab-label").allTextContents();
  const marks = page.locator(".editor-tab.active > .editor-tab-sync");

  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  await (await treeRow(page, first)).click();
  await groups.first().locator(".cm-line").first().click();
  await page.keyboard.press("Control+Backslash");
  await expect(groups).toHaveCount(2);
  await groups.nth(1).locator(".editor-toolbar-reading-toggle").click();
  await expect(marks).toHaveCount(2);

  // Picked while the reading side has focus: the editor follows.
  await (await treeRow(page, second)).click();
  await expect.poll(shown).toEqual([stem(second), stem(second)]);
  await expect(marks).toHaveCount(2);

  // Picked while the editor has focus: the page follows.
  await groups.first().locator(".cm-line").first().click();
  await (await treeRow(page, first)).click();
  await expect.poll(shown).toEqual([stem(first), stem(first)]);
  await expect(marks).toHaveCount(2);

  await closeSecondGroup(page);
});

test("keeps a screenplay read beside its editor level, its lines formatted however far it jumps", async ({
  page,
  request,
}) => {
  const name = `scroll-sync-${Date.now()}.fountain`;
  const scenes = Array.from({ length: 60 }, (_, scene) => {
    const beats = Array.from({ length: 6 }, (_, beat) => `Beat ${scene + 1}.${beat + 1}.`).join("\n\n");
    return `INT. ROOM ${scene + 1} - DAY\n\n[[a note the page leaves out]]\n\n${beats}\n\nALICE\nA line in scene ${scene + 1}.`;
  });
  const created = await request.post("/api/space/create", {
    data: { parentPath: "", name, type: "file", content: `${scenes.join("\n\n")}\n` },
  });
  expect(created.ok()).toBe(true);

  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  await (await treeRow(page, name)).click();
  await groups.first().locator(".cm-line").first().click();
  await page.keyboard.press("Control+Backslash");
  await expect(groups).toHaveCount(2);
  const [editing, reading] = [groups.nth(0), groups.nth(1)];
  await reading.locator(".editor-toolbar-reading-toggle").click();

  // Far past what the reading side has parsed: its formatting has to catch up.
  await editing.locator(".cm-scroller").evaluate((scroller) => {
    scroller.scrollTop = scroller.scrollHeight * 0.8;
  });
  const beat = await scrollRowToTop(editing, /^Beat \d+\.\d+\.$/);
  await expect.poll(() => topText(reading)).toBe(beat);
  await expect(reading.locator(".cm-fountain-character").first()).toBeVisible();

  await closeSecondGroup(page);
});

test("reads or edits a note on the side at the place it is open at", async ({ page, request }) => {
  const name = await createItemsNote(request);
  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  const [left, right] = [groups.nth(0), groups.nth(1)];
  await (await treeRow(page, name)).click();
  const pick = async (label: string) => {
    await left.getByRole("button", { name: "More options" }).click();
    await page.locator(".context-menu button", { hasText: label }).click();
  };

  // From the editor: the page opens beside it at its place, and the
  // keyboard stays in the editor.
  await left.locator(".editor-document").evaluate((scroller) => {
    scroller.scrollTop = 1500;
  });
  const edited = await scrollRowToTop(left, /^- Item \d+\.\d+$/);
  await pick("Read on the side");
  await expect(right.locator(".editor-reading")).toBeVisible();
  await expect.poll(() => topText(right)).toBe(edited);
  expect(await left.evaluate((group) => group.contains(document.activeElement))).toBe(true);
  await closeSecondGroup(page);

  // From the page: the editor opens beside it at its place, and typing
  // starts there rather than pulling both back to the top.
  await left.locator(".editor-toolbar-reading-toggle").click();
  await left.locator(".editor-reading").evaluate((scroller) => {
    scroller.scrollTop += 1200;
  });
  const read = await scrollRowToTop(left, /^Item \d+\.\d+$/);
  await pick("Edit on the side");
  await expect(right.locator(".editor-document")).toBeVisible();
  await expect.poll(() => topText(right)).toBe(read);
  expect(await topText(left)).toBe(read);
  // Typed at the start of the next item's text, which the page shows in place.
  await page.keyboard.type("typed here ");
  await expect(right.locator(".cm-line", { hasText: "typed here" })).toBeInViewport();
  await expect(left.getByText(/^typed here Item \d+\.\d+$/)).toBeInViewport();
  expect(await topText(left)).toBe(read);

  await closeSecondGroup(page);
  await left.locator(".editor-toolbar-reading-toggle").click();
});

// A preview covers its group, toolbar and all, but not the divider that lies
// over the group's first pixels.
test("resizes the groups while the right one previews a file", async ({ page }) => {
  await page.goto("/");
  const groups = page.locator("#editor-groups > .editor-group");
  await (await treeRow(page, "README.md")).click();
  await (await treeRow(page, "projects/getting-started")).click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "Open to the side" }).click();
  await expect(groups).toHaveCount(2);
  const right = groups.nth(1);
  await right.locator(".gallery-tile", { hasText: "sample-scene" }).click();
  await expect(right.locator(".file-preview")).toBeVisible();

  const divider = await page.locator(".editor-group-divider").boundingBox();
  if (!divider) throw new Error("the divider is not laid out");
  const before = await leftEdge(right);
  const [x, y] = [divider.x + divider.width / 2, divider.y + divider.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Short of the left group's least width.
  await page.mouse.move(x - 60, y, { steps: 12 });
  await page.mouse.up();
  expect(await leftEdge(right)).toBeLessThan(before - 40);
  await expect(right.locator(".file-preview")).toBeVisible();

  await closeSecondGroup(page);
});
