// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelConsole, type ModelConsole } from "../../../web/services/modelConsole.ts";

// jsdom doesn't implement scrollIntoView (used when writing a fresh console
// entry to keep it visible) — a real browser always has it, so this is a
// test environment gap, not app behavior to work around in the service
// itself.
Element.prototype.scrollIntoView ??= () => {};

const DEFAULT_TITLE = "Working on a model request…";

function setup(): { modelConsole: ModelConsole; consoleEntries: HTMLElement; activityIndicator: HTMLElement } {
  const consoleEntries = document.createElement("div");
  const activityIndicator = document.createElement("div");
  activityIndicator.hidden = true;
  activityIndicator.dataset.tooltip = DEFAULT_TITLE;
  return { modelConsole: createModelConsole({ consoleEntries, activityIndicator }), consoleEntries, activityIndicator };
}

describe("logLlmCall", () => {
  it("writes a complete entry tagged as an LLM call, level info, on success", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Find Context", {
      failed: false,
      model: "anthropic/claude-sonnet-5",
      prompt: "the sent prompt",
      options: ["a", "b"],
    });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.classList.contains("console-entry-level-info")).toBe(true);
    expect(entry.querySelector(".console-entry-kind")?.textContent).toBe("LLM");
    expect(entry.querySelector(".console-entry-label-text")?.textContent).toBe(
      "Find Context (anthropic/claude-sonnet-5)",
    );
    expect(entry.querySelector(".console-entry-content")?.textContent).toBe("the sent prompt\n\na\n---\nb");
  });

  it("writes what a generation sent as context ahead of its result, and no prompt", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Generate", {
      failed: false,
      model: "m",
      context: ["Sent as context:", "/AGENTS.md", 'Searched for "Lina".'],
      options: ["Shot 1"],
    });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.querySelector(".console-entry-content")?.textContent).toBe(
      'Sent as context:\n/AGENTS.md\nSearched for "Lina".\n\nShot 1',
    );
  });

  // A run whose model didn't get all it should have stands out from one that did.
  it("writes a warning entry when what went as context fell short", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Generate", {
      failed: false,
      model: "m",
      context: ["Sent as context:", "/AGENTS.md", "Left out /secret.md: it's private."],
      warn: true,
      options: ["ok"],
    });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.classList.contains("console-entry-level-warn")).toBe(true);
    expect(modelConsole.entryAt(entry)?.text.startsWith("[warn] LLM  Generate (m)")).toBe(true);
  });

  it("names the effort a model ran at beside it", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Generate", { failed: false, model: "m", effort: "xhigh", options: ["ok"] });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.querySelector(".console-entry-label-text")?.textContent).toBe("Generate (m · Extra high)");
  });

  it("shows a placeholder instead of an empty result when there are no options", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Generate", { failed: false, model: "m", options: [] });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.querySelector(".console-entry-content")?.textContent).toBe("(no options returned)");
  });

  it("writes a level-error entry with why the call failed", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logLlmCall("Generate", { failed: true, message: "bad path" });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.classList.contains("console-entry-level-error")).toBe(true);
    expect(entry.querySelector(".console-entry-content")?.textContent).toBe("bad path");
  });

  it("links a refused call's entry to the setting that fixes it, the link left out of its copied text", () => {
    const { modelConsole, consoleEntries } = setup();
    const need = { kind: "providerKey", provider: "anthropic" } as const;
    modelConsole.logLlmCall("Generate", { failed: true, message: "No API key", need });
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
    expect(modelConsole.entryAt(entry)?.text).not.toContain("Go to");
  });
});

describe("logEntry", () => {
  it("writes an entry through with the given level/kind/label/content unchanged", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logEntry("error", "GIT", "Sync Changes", "Sync failed.");
    const entry = consoleEntries.querySelector(".console-entry") as HTMLElement;
    expect(entry.classList.contains("console-entry-level-error")).toBe(true);
    expect(entry.querySelector(".console-entry-kind")?.textContent).toBe("GIT");
    expect(entry.querySelector(".console-entry-label-text")?.textContent).toBe("Sync Changes");
    expect(entry.querySelector(".console-entry-content")?.textContent).toBe("Sync failed.");
  });

  it("hands back the entry, to reveal until Clear removes it", () => {
    const { modelConsole, consoleEntries } = setup();
    document.body.append(consoleEntries);
    const logged = modelConsole.logEntry("warn", "Problems", "a.flow.html", "one");
    expect(logged.kept()).toBe(true);
    expect(logged.reveal()).toBe(true);
    expect(consoleEntries.querySelector(".console-entry")?.classList).toContain("flash");
    consoleEntries.replaceChildren();
    expect(logged.kept()).toBe(false);
    expect(logged.reveal()).toBe(false);
    consoleEntries.remove();
  });
});

describe("activity indicator timing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not show the indicator for a call that settles before 150ms", async () => {
    const { modelConsole, activityIndicator } = setup();
    modelConsole.beginLlmActivity("m");
    modelConsole.endLlmActivity("m");
    expect(activityIndicator.hidden).toBe(true);
    // Ending the activity cleared the pending show-timer before it could fire.
    await vi.advanceTimersByTimeAsync(200);
    expect(activityIndicator.hidden).toBe(true);
  });

  it("shows the indicator once a call has been going for 150ms", async () => {
    const { modelConsole, activityIndicator } = setup();
    modelConsole.beginLlmActivity("m");
    await vi.advanceTimersByTimeAsync(150);
    expect(activityIndicator.hidden).toBe(false);
    expect(activityIndicator.dataset.tooltip).toBe("Working: m");

    modelConsole.endLlmActivity("m");
    expect(activityIndicator.hidden).toBe(true);
    expect(activityIndicator.dataset.tooltip).toBe(DEFAULT_TITLE);
  });

  it("keeps the indicator's tooltip naming the remaining call when one of two overlapping calls finishes", async () => {
    const { modelConsole, activityIndicator } = setup();
    modelConsole.beginLlmActivity("model-a");
    modelConsole.beginLlmActivity("model-b");
    await vi.advanceTimersByTimeAsync(150);
    expect(activityIndicator.hidden).toBe(false);
    expect(activityIndicator.dataset.tooltip).toBe("Working: model-a, model-b");

    modelConsole.endLlmActivity("model-a");
    expect(activityIndicator.hidden).toBe(false);
    expect(activityIndicator.dataset.tooltip).toBe("Working: model-b");

    modelConsole.endLlmActivity("model-b");
    expect(activityIndicator.hidden).toBe(true);
    expect(activityIndicator.dataset.tooltip).toBe(DEFAULT_TITLE);
  });
});

describe("entry text for copying", () => {
  it("reads the entry under a node as a header line and its content, naming the level only when it isn't info", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logEntry("info", "LLM", "Generate (m)", "the prompt\n\nthe reply");
    modelConsole.logEntry("error", "HTTP", "Fetch", "network down");
    const [info, error] = [...consoleEntries.querySelectorAll(".console-entry")];
    const content = info.querySelector(".console-entry-content")?.firstChild as Node;
    expect(modelConsole.entryAt(content)).toEqual({
      element: info,
      text: "LLM  Generate (m)\nthe prompt\n\nthe reply",
    });
    expect(modelConsole.entryAt(error)?.text).toBe("[error] HTTP  Fetch\nnetwork down");
  });

  it("finds no entry off one, such as on the welcome line", () => {
    const { modelConsole, consoleEntries } = setup();
    const welcome = document.createElement("div");
    consoleEntries.appendChild(welcome);
    expect(modelConsole.entryAt(welcome)).toBeUndefined();
    expect(modelConsole.entryAt(consoleEntries)).toBeUndefined();
  });

  it("joins every entry still shown, in order, skipping the welcome line and what Clear removed", () => {
    const { modelConsole, consoleEntries } = setup();
    modelConsole.logEntry("info", "GIT", "Pull", "ok");
    consoleEntries.replaceChildren();
    const welcome = document.createElement("div");
    welcome.textContent = "Welcome";
    consoleEntries.appendChild(welcome);
    expect(modelConsole.allText()).toBe("");
    modelConsole.logEntry("info", "GIT", "Push", "ok");
    modelConsole.logEntry("warn", "Problems", "a.md", "one\ntwo");
    expect(modelConsole.allText()).toBe("GIT  Push\nok\n\n[warn] Problems  a.md\none\ntwo");
  });
});
