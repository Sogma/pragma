// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { SetupError } from "../../../src/protocol/setupNeed.ts";
import { createOutcomeLine, type OutcomeLineOptions } from "../../../web/lib/outcomeLine.ts";

// A line on the page, as a surface's is while it shows.
function setup(options: Partial<OutcomeLineOptions> = {}) {
  const el = document.createElement("div");
  document.body.replaceChildren(el);
  const reveal = vi.fn();
  const line = createOutcomeLine(el, { fallback: "It failed.", reveal, ...options });
  return { el, line, reveal };
}

const refused = () => Promise.reject(new SetupError("No model selected.", { kind: "defaultModel", output: "text" }));

describe("createOutcomeLine", () => {
  it("starts empty and hidden", () => {
    const { el } = setup();
    expect(el.hidden).toBe(true);
  });

  it("shows a failure's message with the link to the setting that fixes it, and brings it into view", async () => {
    const { el, line, reveal } = setup();
    await expect(line.run(refused)).resolves.toBeUndefined();
    expect(el.querySelector(".inline-error-message")?.textContent).toBe("No model selected.");
    expect(el.querySelector(".setting-link")?.textContent).toBe("Go to AI Models settings");
    expect(el.querySelector(".inline-error")?.getAttribute("role")).toBe("alert");
    expect(el.hidden).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  // The next attempt may succeed with nothing to show here, such as a
  // proposal drawn in the editor, so nothing would draw over the failure.
  it("clears the last attempt's failure as the next attempt starts", async () => {
    const { el, line } = setup();
    await line.run(refused);
    let finish: (value: string) => void = () => {};
    const next = line.run(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    expect(el.textContent).toBe("");
    expect(el.hidden).toBe(true);
    expect(el.querySelector(".inline-error")).toBeNull();
    finish("done");
    await expect(next).resolves.toBe("done");
    expect(el.textContent).toBe("");
  });

  it("titles a failure with what failed, when the attempt names it", async () => {
    const { el, line } = setup();
    await line.run(refused, { title: "Tighten failed" });
    expect(el.querySelector(".inline-error-title")?.textContent).toBe("Tighten failed");
    await line.run(refused);
    expect(el.querySelector(".inline-error-title")).toBeNull();
  });

  it("shows what a success draws, bringing it into view only when there is something", async () => {
    const { el, line, reveal } = setup();
    await line.run(async () => 0, { result: () => [] });
    expect(reveal).not.toHaveBeenCalled();
    await line.run(async () => 2, { result: (count) => [`${count} rows`] });
    expect(el.textContent).toBe("2 rows");
    expect(el.hidden).toBe(false);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("says the fallback for a thrown non-Error, and for a message its surface won't show", async () => {
    const { el, line } = setup({ showsMessage: (error) => error.name === "Shown" });
    await line.run(() => Promise.reject("boom"));
    expect(el.textContent).toBe("It failed.");
    await line.run(refused);
    expect(el.querySelector(".inline-error-message")?.textContent).toBe("It failed.");
    // The setting still fixes it.
    expect(el.querySelector(".setting-link")).not.toBeNull();
  });

  it("drops an outcome no longer wanted, or one whose line left the page, bringing nothing into view", async () => {
    const { el, line, reveal } = setup();
    await line.run(refused, { current: () => false });
    expect(el.textContent).toBe("");
    el.remove();
    await line.run(refused);
    await line.run(async () => 1, { result: () => ["one"] });
    expect(el.textContent).toBe("");
    expect(reveal).not.toHaveBeenCalled();
  });

  it("shows what no attempt produced, as no failure, until the next attempt starts", () => {
    const { el, line, reveal } = setup();
    line.show("Published: ", "https://site.example/post");
    expect(el.textContent).toBe("Published: https://site.example/post");
    expect(el.hidden).toBe(false);
    expect(el.querySelector(".inline-error")).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    void line.run(() => new Promise(() => {}));
    expect(el.hidden).toBe(true);
  });
});
