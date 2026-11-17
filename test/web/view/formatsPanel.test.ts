// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { must } from "../../../web/lib/dom.ts";
import { createFormats, type FormatSettings, type TextFormat } from "../../../web/services/formats.ts";
import { wireFormatsPanel } from "../../../web/view/formatsPanel.ts";

function format(settings?: FormatSettings): TextFormat {
  return { extensions: () => [], links: () => ({ found: [], missing: [] }), embedsImages: false, settings };
}

function page(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "format-page";
  element.textContent = text;
  return element;
}

// Settings → Editor's Formats group as web/index.html has it, inside the body
// the subpages are mounted in.
function setup(register: (formats: ReturnType<typeof createFormats>) => void) {
  const root = document.createElement("div");
  root.innerHTML = `
    <section class="settings-category" data-settings-category="editor">
      <div class="settings-group">
        <h3 class="settings-group-title">Formats</h3>
        <div class="settings-card"><div id="settings-format-list" class="settings-card-list"></div></div>
      </div>
    </section>`;
  document.body.replaceChildren(root);
  const formats = createFormats();
  register(formats);
  const openSettingsSubpage = vi.fn();
  wireFormatsPanel(root, { formats, openSettingsSubpage });
  return { root, openSettingsSubpage, group: must<HTMLElement>(".settings-group", root) };
}

describe("wireFormatsPanel", () => {
  it("lists each format with a page, by its label and detail, and opens the page the format built", () => {
    const { root, openSettingsSubpage } = setup((formats) => {
      formats.register("note", format());
      formats.register(
        "screenplay",
        format({ label: "Screenplay", detail: "Fountain files (.fountain)", page: () => page("Font") }),
      );
    });
    const rows = root.querySelectorAll<HTMLButtonElement>("#settings-format-list > .settings-open-row");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.dataset.settingsItem).toBe("format-screenplay");
    expect(row?.querySelector(".settings-row-name")?.textContent).toBe("Screenplay");
    expect(row?.querySelector(".settings-row-sub")?.textContent).toBe("Fountain files (.fountain)");

    const subpage = must<HTMLElement>('.settings-subpage[data-settings-subpage="format-screenplay"]', root);
    expect(subpage.dataset.settingsParent).toBe("editor");
    expect(subpage.hidden).toBe(true);
    expect(must(".settings-subpage-back", subpage).getAttribute("aria-label")).toBe("Back to Formats");
    expect(must(".settings-subpage-title", subpage).textContent).toBe("Screenplay");
    expect(must(".format-page", subpage).textContent).toBe("Font");

    row?.click();
    expect(openSettingsSubpage).toHaveBeenCalledWith("format-screenplay");
  });

  it("lists a page given for a view that is no format's after the formats' own", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div class="settings-group"><div id="settings-format-list"></div></div>`;
    const formats = createFormats();
    formats.register("screenplay", format({ label: "Screenplay", detail: "Fountain", page: () => page("Font") }));
    const openSettingsSubpage = vi.fn();
    const code = { label: "Code", detail: "An applet's Edit code view", page: () => page("Line numbers") };
    wireFormatsPanel(root, { formats, pages: [{ id: "code", settings: code }], openSettingsSubpage });

    const rows = [...root.querySelectorAll<HTMLButtonElement>("#settings-format-list > .settings-open-row")];
    expect(rows.map((row) => row.dataset.settingsItem)).toEqual(["format-screenplay", "format-code"]);
    expect(must(".format-page", must('[data-settings-subpage="format-code"]', root)).textContent).toBe("Line numbers");
    rows[1]?.click();
    expect(openSettingsSubpage).toHaveBeenCalledWith("format-code");
  });

  it("hides the Formats group when no format has a page", () => {
    const { group } = setup((formats) => formats.register("note", format()));
    expect(group.hidden).toBe(true);
  });
});
