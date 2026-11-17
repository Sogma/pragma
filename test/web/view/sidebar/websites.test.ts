// @vitest-environment jsdom
import { describe, expect, it, type Mock, vi } from "vitest";
import type { SpaceSiteEntry } from "../../../../web/core/apiClient.ts";
import type { TreeRenderContext } from "../../../../web/view/fileTreeView.ts";
import { createWebsitesView, type WebsitesViewDeps } from "../../../../web/view/sidebar/websites.ts";

function site(overrides: Partial<SpaceSiteEntry> & { path: string }): SpaceSiteEntry {
  return {
    id: `site_${overrides.path}`,
    slug: overrides.path,
    name: overrides.path,
    primaryDomain: null,
    ...overrides,
  };
}

type DrawSite = (sitePath: string, body: HTMLElement | null) => void;
type TestDeps = WebsitesViewDeps & { renderSiteTree: Mock<DrawSite> };

function deps(overrides: Partial<WebsitesViewDeps> = {}): TestDeps {
  // Every tree the view creates draws through this one spy, naming the site
  // and the body it was drawn into.
  const renderSiteTree = vi.fn<DrawSite>();
  return {
    fetchSites: vi.fn(async () => [
      site({ path: "blog", name: "Blog", domain: "blog.example" }),
      site({ path: "docs" }),
    ]),
    createTree: vi.fn((listPath: string) => {
      const element = document.createElement("ul");
      return {
        element,
        render: () => renderSiteTree(listPath, element.parentElement),
        hasRow: () => false,
        reveal: () => false,
        dispose: vi.fn(),
      };
    }),
    siteNodes: () => [],
    renderContext: () => ({}) as TreeRenderContext,
    renderSiteTree,
    createMenuButton: vi.fn(() => document.createElement("button")),
    ...overrides,
  };
}

async function shown(d: TestDeps) {
  const websites = createWebsitesView(d);
  websites.view.onShow?.();
  await vi.waitFor(() => expect(d.fetchSites).toHaveBeenCalled());
  await Promise.resolve();
  return websites;
}

function headers(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(".list-item"));
}

describe("createWebsitesView", () => {
  it("describes itself as the websites sidebar view", () => {
    const { view } = createWebsitesView(deps());
    expect(view.id).toBe("websites");
    expect(view.label).toBe("Websites");
    expect(view.panel.querySelector(".sidebar-title")?.textContent).toBe("Websites");
  });

  it("renders one row per site, title over domain or path", async () => {
    const d = deps();
    const { view } = await shown(d);

    const rows = headers(view.panel);
    expect(rows.map((row) => row.querySelector(".list-item-title")?.textContent)).toEqual(["Blog", "docs"]);
    expect(rows.map((row) => row.querySelector(".list-item-subtitle")?.textContent)).toEqual(["blog.example", "docs"]);
    expect(view.panel.querySelector<HTMLElement>(".sidebar-list")?.hidden).toBe(false);
    expect(view.panel.querySelector<HTMLElement>(".sidebar-panel-empty")?.hidden).toBe(true);
  });

  it("names the row's own site on its ⋮ trigger, so the menu knows what it acts on", async () => {
    const d = deps();
    await shown(d);

    expect(vi.mocked(d.createMenuButton).mock.calls).toEqual([
      ["Site options", "blog"],
      ["Site options", "docs"],
    ]);
  });

  it("shows the empty state and the failure state", async () => {
    const emptyView = await shown(deps({ fetchSites: vi.fn(async () => []) }));
    expect(emptyView.view.panel.querySelector(".sidebar-panel-empty")?.textContent).toBe("No sites in this space yet.");

    const failedView = await shown(deps({ fetchSites: vi.fn(async () => Promise.reject(new Error("boom"))) }));
    expect(failedView.view.panel.querySelector(".sidebar-panel-empty")?.textContent).toBe("Failed to load sites.");
    expect(failedView.view.panel.querySelector<HTMLElement>(".sidebar-list")?.hidden).toBe(true);
  });

  it("expands one site at a time and renders its tree through the injected renderer", async () => {
    const d = deps();
    const { view } = await shown(d);
    const [blog, docs] = headers(view.panel);

    blog.click();
    expect(blog.getAttribute("aria-expanded")).toBe("true");
    expect(d.renderSiteTree).toHaveBeenLastCalledWith("blog", blog.nextElementSibling);
    expect((blog.nextElementSibling as HTMLElement).hidden).toBe(false);

    docs.click();
    expect(blog.getAttribute("aria-expanded")).toBe("false");
    expect((blog.nextElementSibling as HTMLElement).hidden).toBe(true);
    expect(docs.getAttribute("aria-expanded")).toBe("true");
    expect(d.renderSiteTree).toHaveBeenLastCalledWith("docs", docs.nextElementSibling);

    docs.click();
    expect(docs.getAttribute("aria-expanded")).toBe("false");
    expect(d.renderSiteTree).toHaveBeenCalledTimes(2);
  });

  it("toggles from the keyboard with Enter", async () => {
    const d = deps();
    const { view } = await shown(d);
    const [blog] = headers(view.panel);

    blog.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(blog.getAttribute("aria-expanded")).toBe("true");
  });

  it("refreshExpanded() re-renders only the expanded site", async () => {
    const d = deps();
    const websites = await shown(d);
    websites.refreshExpanded();
    expect(d.renderSiteTree).not.toHaveBeenCalled();

    headers(websites.view.panel)[0].click();
    websites.refreshExpanded();

    expect(d.renderSiteTree).toHaveBeenCalledTimes(2);
    expect(d.renderSiteTree).toHaveBeenLastCalledWith("blog", expect.any(HTMLElement));
  });

  it("keeps a site expanded across a refresh when it still exists, and drops it otherwise", async () => {
    const d = deps();
    const websites = await shown(d);
    headers(websites.view.panel)[0].click();

    websites.view.onShow?.();
    await vi.waitFor(() => expect(d.fetchSites).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(headers(websites.view.panel)[0].getAttribute("aria-expanded")).toBe("true");

    (d.fetchSites as ReturnType<typeof vi.fn>).mockResolvedValueOnce([site({ path: "docs" })]);
    websites.view.onShow?.();
    await vi.waitFor(() => expect(d.fetchSites).toHaveBeenCalledTimes(3));
    await Promise.resolve();
    expect(headers(websites.view.panel).map((h) => h.getAttribute("aria-expanded"))).toEqual(["false"]);
  });
});
