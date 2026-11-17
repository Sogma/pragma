// Settings → Editor → Formats: a row per registered format with a page of its
// own, and per page given for a text view that is no document type's format
// (Edit code), opening that page as a subpage. Whoever owns the page builds
// its content; this frames it as every Settings subpage is framed.
//
// The subpages are mounted when this runs, which must come before the
// Settings panel collects its subpages, or no row could open one.
import { buildOpenRow, must } from "../lib/dom.ts";
import type { FormatRegistry, FormatSettings } from "../services/formats.ts";

export interface FormatsPanelDeps {
  formats: FormatRegistry;
  // Listed after the formats' pages, each as `format-<id>`.
  pages?: readonly { id: string; settings: FormatSettings }[];
  openSettingsSubpage: (id: string) => void;
}

export function wireFormatsPanel(root: HTMLElement, deps: FormatsPanelDeps): void {
  const list = must<HTMLElement>("#settings-format-list", root);
  const formatPages = deps.formats
    .list()
    .flatMap(({ documentType, format }) => (format.settings ? [{ id: documentType, settings: format.settings }] : []));
  for (const page of [...formatPages, ...(deps.pages ?? [])]) {
    const id = `format-${page.id}`;
    root.append(subpage(id, page.settings));
    list.append(buildOpenRow(id, [rowText(page.settings)], () => deps.openSettingsSubpage(id)));
  }
  // A Formats heading over no rows would list nothing.
  const group = list.closest<HTMLElement>(".settings-group");
  if (group) group.hidden = list.childElementCount === 0;
}

function rowText(settings: FormatSettings): HTMLElement {
  const name = document.createElement("span");
  name.className = "settings-row-name";
  name.textContent = settings.label;
  const detail = document.createElement("span");
  detail.className = "settings-row-sub";
  detail.textContent = settings.detail;
  const meta = document.createElement("span");
  meta.className = "settings-list-row-meta";
  meta.append(name, detail);
  return meta;
}

function subpage(id: string, settings: FormatSettings): HTMLElement {
  const icon = document.createElement("span");
  icon.className = "settings-subpage-back-icon";
  icon.setAttribute("aria-hidden", "true");
  const back = document.createElement("button");
  back.type = "button";
  back.className = "flat-button section-label settings-subpage-back";
  back.setAttribute("aria-label", "Back to Formats");
  back.append(icon, "Formats");
  const title = document.createElement("h3");
  title.className = "settings-subpage-title";
  title.textContent = settings.label;
  const head = document.createElement("div");
  head.className = "settings-subpage-head";
  head.append(back, title);
  const section = document.createElement("section");
  section.className = "settings-subpage";
  section.dataset.settingsSubpage = id;
  section.dataset.settingsParent = "editor";
  section.hidden = true;
  section.append(head, settings.page());
  return section;
}
