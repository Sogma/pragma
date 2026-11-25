// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FlowGraph, FlowNodeInstance } from "../../../src/protocol/types.ts";
import {
  attachPlaceholderSuggestions,
  dateChoices,
  matchingChoices,
  openPlaceholder,
  promptChoices,
  promptPins,
  promptSuggestions,
} from "../../../web/flow/placeholderSuggestions.ts";

// Thursday 2026-11-12, 16:40, in the machine's own zone.
const NOW = new Date(2026, 10, 12, 16, 40);
const at = { x: 0, y: 0 };
const nodeOf = (id: string, type: string, config: Record<string, unknown> = {}): FlowNodeInstance => ({
  id,
  type,
  position: at,
  config,
});
const wire = (source: string, sourcePort: string, target: string, targetPort: string) => ({
  id: `${source}-${target}-${targetPort}`,
  source,
  sourcePort,
  target,
  targetPort,
});

const rows = () => [...document.querySelectorAll<HTMLElement>(".placeholder-suggestions [role=option]")];
const texts = () => rows().map((row) => row.querySelector(".placeholder-suggestion-text")?.textContent);

afterEach(() => {
  document.body.replaceChildren();
});

describe("what a box offers", () => {
  it("finds the placeholder the caret is in, and nothing once it is closed", () => {
    expect(openPlaceholder("Shots {{da")).toEqual({ start: 6, typed: "da" });
    expect(openPlaceholder("{{")).toEqual({ start: 0, typed: "" });
    expect(openPlaceholder("Shots {{$date}}")).toBeUndefined();
    expect(openPlaceholder("Shots {")).toBeUndefined();
  });

  it("offers each date form beside what it gives now", () => {
    expect(dateChoices(NOW).map((choice) => [choice.text, choice.detail])).toEqual([
      ["{{$date}}", "2026-11-12"],
      ["{{$date:%B %-d, %Y}}", "November 12, 2026"],
      ["{{$date:%F %H:%M}}", "2026-11-12 16:40"],
      ["{{$date:%H:%M}}", "16:40"],
      ["{{$date:%A}}", "Thursday"],
      ["{{$date:%Y}}", "2026"],
    ]);
  });

  it("narrows to what holds the typed text, case aside, those it begins first", () => {
    const choices = [
      { text: "{{$date:%Y}}", detail: "" },
      { text: "{{update}}", detail: "" },
      { text: "{{$Date}}", detail: "" },
    ];
    expect(matchingChoices(choices, "da").map((choice) => choice.text)).toEqual([
      "{{$date:%Y}}",
      "{{$Date}}",
      "{{update}}",
    ]);
    expect(matchingChoices(choices, "zz")).toEqual([]);
    expect(matchingChoices(choices, "$").map((choice) => choice.text)).toEqual(["{{$date:%Y}}", "{{$Date}}"]);
    expect(matchingChoices(choices, "$up")).toEqual([]);
  });

  it("offers a Prompt the named, wired slots of the Template Variables it feeds, before the dates", () => {
    const graph: FlowGraph = {
      nodes: [
        nodeOf("prompt-1", "prompt"),
        nodeOf("vars", "templateVariables", { var1Name: "document", var2Name: "selection", var3Name: "unwired" }),
        nodeOf("button", "button"),
      ],
      edges: [
        wire("prompt-1", "text", "vars", "source"),
        wire("button", "raw", "vars", "var_1"),
        wire("button", "selection", "vars", "var_2"),
      ],
    };
    const offered = promptChoices(graph, "prompt-1", NOW).map((choice) => choice.text);
    expect(offered.slice(0, 3)).toEqual(["{{document}}", "{{selection}}", "{{$date}}"]);
    expect(offered).not.toContain("{{unwired}}");
    expect(promptChoices(graph, "button", NOW).map((choice) => choice.text)[0]).toBe("{{$date}}");
  });

  it("offers a slot named date beside the host's date, which a run keeps apart", () => {
    const graph: FlowGraph = {
      nodes: [
        nodeOf("prompt-1", "prompt"),
        nodeOf("vars", "templateVariables", { var1Name: "date" }),
        nodeOf("b", "button"),
      ],
      edges: [wire("prompt-1", "text", "vars", "source"), wire("b", "raw", "vars", "var_1")],
    };
    const offered = promptChoices(graph, "prompt-1", NOW).map((choice) => choice.text);
    expect(offered.slice(0, 2)).toEqual(["{{date}}", "{{$date}}"]);
  });

  it("offers a Prompt the image pins wired into each Generate node it reaches, through Template Variables too", () => {
    const graph: FlowGraph = {
      nodes: [
        nodeOf("prompt-1", "prompt"),
        nodeOf("vars", "templateVariables"),
        nodeOf("gen", "generateImage"),
        nodeOf("pic", "loadImage"),
      ],
      edges: [
        wire("prompt-1", "text", "vars", "source"),
        wire("vars", "text", "gen", "prompt"),
        wire("pic", "image", "gen", "image_2"),
      ],
    };
    expect(promptPins(graph, "prompt-1")).toEqual([{ text: "@image_2", detail: "Wired into Generate Image (AI)" }]);
    expect(promptPins({ ...graph, edges: graph.edges.slice(2) }, "prompt-1")).toEqual([]);
  });
});

describe("a text box", () => {
  function box(): { input: HTMLInputElement; saved: string[] } {
    const input = document.createElement("input");
    const saved: string[] = [];
    input.addEventListener("input", () => saved.push(input.value));
    document.body.appendChild(input);
    attachPlaceholderSuggestions(input, () => dateChoices(NOW));
    input.focus();
    return { input, saved };
  }
  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.setSelectionRange(value.length, value.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const press = (input: HTMLInputElement, key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it("lists the dates once {{ is typed, and nothing before", () => {
    const { input } = box();
    type(input, "Shots {");
    expect(rows()).toHaveLength(0);
    type(input, "Shots {{");
    expect(texts()).toEqual(dateChoices(NOW).map((choice) => choice.text));
    expect(rows()[0].querySelector(".context-menu-detail")?.textContent).toBe("2026-11-12");
    expect(rows()[0].classList.contains("highlighted")).toBe(true);
  });

  it("puts the highlighted one in place of what was begun, as typing would, and closes", () => {
    const { input, saved } = box();
    type(input, "Shots {{y");
    expect(texts()).toEqual(["{{$date:%B %-d, %Y}}", "{{$date:%Y}}"]);
    expect(press(input, "ArrowDown")).toBe(true);
    expect(press(input, "Enter")).toBe(true);
    expect(input.value).toBe("Shots {{$date:%Y}}");
    expect(saved.at(-1)).toBe("Shots {{$date:%Y}}");
    expect(rows()).toHaveLength(0);
    expect(press(input, "Enter")).toBe(false);
  });

  it("takes a click without the box losing focus, and keeps what follows the caret", () => {
    const { input } = box();
    input.value = "A {{ B";
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    rows()[3].click();
    expect(input.value).toBe("A {{$date:%H:%M}} B");
    expect(input.selectionStart).toBe("A {{$date:%H:%M}}".length);
  });

  it("closes on Escape, and on blur", () => {
    const { input } = box();
    type(input, "{{");
    expect(press(input, "Escape")).toBe(true);
    expect(rows()).toHaveLength(0);
    type(input, "{{");
    input.blur();
    input.dispatchEvent(new Event("blur"));
    expect(rows()).toHaveLength(0);
  });
});

describe("a Prompt's editor", () => {
  function editor(pins = vi.fn(() => [{ text: "@image_1", detail: "Wired into Generate Text (AI)" }])): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({ extensions: [promptSuggestions(() => dateChoices(NOW), pins)] }),
    });
    view.focus();
    return view;
  }
  const typeIn = (view: EditorView, text: string) =>
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: text },
      selection: { anchor: view.state.selection.main.head + text.length },
      userEvent: "input.type",
    });

  it("lists the dates once {{ is typed and the wired pins once @ is, and writes a pick in place", async () => {
    const view = editor();
    expect(view.hasFocus).toBe(true);
    typeIn(view, "Shot on {{");
    await Promise.resolve();
    expect(texts()).toEqual(dateChoices(NOW).map((choice) => choice.text));
    rows()[4].click();
    expect(view.state.doc.toString()).toBe("Shot on {{$date:%A}}");
    typeIn(view, ", like @im");
    await Promise.resolve();
    expect(texts()).toEqual(["@image_1"]);
    rows()[0].click();
    expect(view.state.doc.toString()).toBe("Shot on {{$date:%A}}, like @image_1");
    view.destroy();
  });
});
