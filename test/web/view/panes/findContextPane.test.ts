// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { FindContextResponse, Tab } from "../../../../web/core/apiClient.ts";
import { createFindContextPane, findContextPane } from "../../../../web/view/panes/findContextPane.ts";
import { fakePaneGroup } from "../../support/paneGroup.ts";

function result(overrides: Partial<FindContextResponse> = {}): FindContextResponse {
  return {
    model: "m",
    prompt: "p",
    candidates: [
      { path: "notes/a.md", score: 0.91, reasoning: ["mentions the chair", "same scene"] },
      { path: "notes/b.md", score: 0.4, reasoning: [] },
    ],
    ...overrides,
  };
}

function setup() {
  const deps = { openPath: vi.fn() };
  const pane = createFindContextPane(deps);
  document.body.append(pane.element);
  return { pane, deps };
}

const current = { isCurrent: () => true };
const tab = (found: FindContextResponse = result()): Tab => ({ kind: "find-context", path: "notes", result: found });

describe("findContextPane", () => {
  it("describes a find-context pane with no title bar", () => {
    const descriptor = findContextPane({ openPath: vi.fn() });
    expect(descriptor.kind).toBe("find-context");
    const pane = descriptor.create(fakePaneGroup());
    expect(pane.title()).toBeUndefined();
    expect(pane.titleHost).toBeUndefined();
  });

  it("renders the ranked candidates, best first, with score, bar, and reasoning", async () => {
    const { pane } = setup();
    await pane.setInput(tab(), current);

    expect(pane.element.classList.contains("editor-find-context")).toBe(true);
    expect(pane.element.querySelector(".find-context-header")?.textContent).toBe("Top matches");
    const cards = [...pane.element.querySelectorAll<HTMLElement>(".find-context-card")];
    expect(cards).toHaveLength(2);
    expect(cards[0].classList.contains("best")).toBe(true);
    expect(cards[0].querySelector(".find-context-best-tag")?.textContent).toBe("Best match");
    expect(cards[0].querySelector(".find-context-card-name")?.textContent).toBe("a.md");
    expect(cards[0].querySelector(".find-context-card-path")?.textContent).toBe("notes/a.md");
    expect(cards[0].querySelector(".find-context-score")?.textContent).toBe("91%");
    expect(cards[0].querySelector<HTMLElement>(".find-context-bar-fill")?.style.width).toBe("91%");
    expect([...cards[0].querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "mentions the chair",
      "same scene",
    ]);
    expect(cards[1].classList.contains("best")).toBe(false);
    expect(cards[1].querySelector(".find-context-best-tag")).toBeNull();
    expect(cards[1].querySelector(".find-context-reasoning")).toBeNull();
  });

  it("Open hands the candidate's path back", async () => {
    const { pane, deps } = setup();
    await pane.setInput(tab(), current);
    const buttons = pane.element.querySelectorAll<HTMLButtonElement>(".find-context-open-button");
    buttons[1].click();
    expect(deps.openPath).toHaveBeenCalledWith("notes/b.md");
  });

  it("says so when the directory has no markdown files", async () => {
    const { pane } = setup();
    await pane.setInput(tab(result({ candidates: [] })), current);
    expect(pane.element.querySelector(".find-context-empty")?.textContent).toBe(
      "No markdown files found in this directory yet.",
    );
    expect(pane.element.querySelector(".find-context-card")).toBeNull();
  });

  it("clearInput() empties the pane", async () => {
    const { pane } = setup();
    await pane.setInput(tab(), current);
    pane.clearInput();
    expect(pane.element.childElementCount).toBe(0);
  });
});
