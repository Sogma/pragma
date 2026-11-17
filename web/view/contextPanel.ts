// The context panel, first in the assistant's Tools tab: document-scoped native
// controls that are deliberately not a toolkit. Publish/Update is its only
// tenant. It sits above the toolkit accordion rather than below it, so a
// running toolkit's result stays against its buttons and never pushes Publish
// down.
//
// The panel renders from what it is handed, never from a remembered path, so
// a tab switch cannot leave the previous document's button behind.

import type { PublishDocumentResponse } from "../../src/protocol/api.ts";
import { isPrivate } from "../../src/protocol/frontmatter.ts";
import { PublishDocumentError } from "../core/apiClient.ts";
import type { SiteRoot } from "../core/spaceTree.ts";
import { createOutcomeLine, type OutcomeLine } from "../lib/outcomeLine.ts";
import type { FileNotices } from "../services/fileNotices.ts";

export interface ContextPanelDeps {
  element: HTMLDivElement;
  findSiteRoot(filePath: string): SiteRoot | undefined;
  /** Publishes `filePath` and folds what the server wrote back into any open
   * copy of it (services/documentPublish.ts). Rejects with a
   * PublishDocumentError carrying the message to show. */
  publish(filePath: string): Promise<PublishDocumentResponse>;
  /** The live properties of `filePath`, or undefined once it is no longer the
   * open document. Publishing is slow enough that the tab can change under
   * it, and the panel must not render a result over whatever is open now. */
  livePropertiesFor(filePath: string): Record<string, unknown> | undefined;
  // A publish's notes, counted on the file's status bar until it publishes
  // again (services/fileNotices.ts).
  notices: Pick<FileNotices, "begin" | "add">;
  /** A first publish can create its section's `index.md` on disk, and add a
   * `date` the open document's properties panel has yet to show. Called
   * after the live properties are updated. */
  onPublished(): void;
  /** Brings the Tools tab back into view: a publish can fail after the
   * person moved to another tab. */
  reveal(): void;
}

export interface ContextPanel {
  render(filePath: string | undefined, properties: Record<string, unknown> | undefined): void;
}

export function createContextPanel(deps: ContextPanelDeps): ContextPanel {
  const { element, findSiteRoot, livePropertiesFor, notices, onPublished } = deps;

  // The published URL comes only from this session's publish responses, never
  // from frontmatter: a stored `url` (older spaces still carry one) goes stale
  // when the domain changes or an ancestor moves.
  const publishedUrls = new Map<string, string>();

  // Reuses the button and status line in place on both outcomes. Only a
  // successful publish re-renders the panel, which is what flips the label to
  // Update and shows the new link.
  async function publish(filePath: string, button: HTMLButtonElement, status: OutcomeLine): Promise<void> {
    button.disabled = true;
    const result = await status.run(() => deps.publish(filePath));
    if (!result) {
      button.disabled = false;
      return;
    }
    notices.begin(filePath, "publish");
    for (const { level, text } of result.notes) {
      notices.add(filePath, "publish", { level, kind: "publish", label: filePath, content: text, count: 1 });
    }

    publishedUrls.set(filePath, result.url);

    // The open copy's properties already carry the new `id`, which is
    // what flips the label to Update.
    const properties = livePropertiesFor(filePath);
    if (properties) render(filePath, properties);
    onPublished();
  }

  function render(filePath: string | undefined, properties: Record<string, unknown> | undefined): void {
    element.innerHTML = "";
    element.hidden = true;
    if (!filePath) return;

    const data = properties ?? {};
    if (isPrivate(data)) return;

    const site = findSiteRoot(filePath);
    if (!site) return;

    element.hidden = false;

    const title = document.createElement("div");
    title.className = "section-label inspector-section-title";
    title.textContent = site.siteName;
    element.appendChild(title);

    const existingId = typeof data.id === "string" ? data.id : undefined;
    const existingUrl = publishedUrls.get(filePath);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "action-button context-panel-button";
    button.textContent = existingId ? "Update" : "Publish";

    const statusEl = document.createElement("div");
    statusEl.className = "context-panel-status";
    const status = createOutcomeLine(statusEl, {
      fallback: "Failed to publish.",
      showsMessage: (error) => error instanceof PublishDocumentError,
      reveal: deps.reveal,
    });
    if (existingUrl) {
      const link = document.createElement("a");
      link.href = existingUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = existingUrl;
      status.show("Published: ", link);
    }

    button.addEventListener("click", () => void publish(filePath, button, status));

    element.appendChild(button);
    element.appendChild(statusEl);
  }

  return { render };
}
