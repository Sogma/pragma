// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PublishDocumentResponse } from "../../../src/protocol/api.ts";
import { withSetupNeed } from "../../../src/protocol/setupNeed.ts";
import { PublishDocumentError } from "../../../web/core/apiClient.ts";
import { type ContextPanelDeps, createContextPanel } from "../../../web/view/contextPanel.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const RESPONSE: PublishDocumentResponse = {
  id: "doc_1",
  url: "https://site.example/post",
  pushed: "2026-09-23T10:00:00Z",
  notes: [],
  writeBacks: [],
};

function setup(publish: ContextPanelDeps["publish"], properties: Record<string, unknown> = {}) {
  const element = document.createElement("div");
  // On the page: an outcome lands only on a line that is.
  document.body.replaceChildren(element);
  const onPublished = vi.fn();
  const notices = { begin: vi.fn(), add: vi.fn() };
  const reveal = vi.fn();
  const panel = createContextPanel({
    element,
    findSiteRoot: () => ({ siteDir: "blog", siteName: "Blog" }),
    publish,
    livePropertiesFor: () => properties,
    notices,
    onPublished,
    reveal,
  });
  panel.render("blog/post.md", properties);
  return { element, onPublished, notices, reveal };
}

describe("context panel publish", () => {
  // The publish folds the write-back into the open copy; the panel only
  // re-renders from it, which is what flips the label.
  it("re-renders from the open document's properties once the publish has folded its id in", async () => {
    const properties: Record<string, unknown> = {};
    const { element, onPublished } = setup(async () => {
      properties.id = "doc_1";
      return RESPONSE;
    }, properties);

    element.querySelector("button")?.click();
    await tick();

    expect(onPublished).toHaveBeenCalledOnce();
    expect(element.querySelector("button")?.textContent).toBe("Update");
    expect(element.textContent).toContain("https://site.example/post");
  });

  it("counts a publish's notes on the file's status bar, in place of the last publish's", async () => {
    const notes = [
      { level: "warn" as const, text: "cover.png is too big, so it was left out" },
      { level: "info" as const, text: "Published as a draft" },
    ];
    const { element, notices } = setup(async () => ({ ...RESPONSE, notes }));
    element.querySelector("button")?.click();
    await tick();

    expect(notices.begin).toHaveBeenCalledWith("blog/post.md", "publish");
    expect(notices.add.mock.calls).toEqual(
      notes.map(({ level, text }) => [
        "blog/post.md",
        "publish",
        { level, kind: "publish", label: "blog/post.md", content: text, count: 1 },
      ]),
    );
  });

  // A publish takes a while, and the person may have moved to another tab.
  it("shows why a publish was refused, revealing itself, and clears it when tried again", async () => {
    let attempt = 0;
    const { element, onPublished, reveal } = setup(async () => {
      if (attempt++ === 0) throw new PublishDocumentError("blog/post.md has a save conflict.");
      return new Promise<never>(() => {});
    });

    element.querySelector("button")?.click();
    await tick();

    expect(onPublished).not.toHaveBeenCalled();
    expect(element.textContent).toContain("blog/post.md has a save conflict.");
    expect(element.querySelector(".context-panel-status .inline-error")).not.toBeNull();
    expect(element.querySelector("button")?.disabled).toBe(false);
    expect(element.querySelector(".setting-link")).toBeNull();
    expect(reveal).toHaveBeenCalledTimes(1);

    element.querySelector("button")?.click();
    expect(element.textContent).not.toContain("save conflict");
  });

  it("says only that a publish failed when the error carries no message written to be shown", async () => {
    const { element } = setup(async () => {
      throw new TypeError("Cannot read properties of undefined");
    });

    element.querySelector("button")?.click();
    await tick();

    expect(element.querySelector(".context-panel-status")?.textContent).toBe("Failed to publish.");
  });

  it("links a publish refused for want of a publisher key to that publisher's settings", async () => {
    const { element } = setup(async () => {
      const refused = new PublishDocumentError('"Sogma" has no API key. Set one in Settings > Publishing.');
      throw withSetupNeed(refused, { kind: "publisherKey", publisher: "sogma" });
    });

    element.querySelector("button")?.click();
    await tick();

    expect(element.textContent).toContain('"Sogma" has no API key.');
    expect(element.querySelector(".setting-link")?.textContent).toBe("Go to Publishing settings");
  });
});
