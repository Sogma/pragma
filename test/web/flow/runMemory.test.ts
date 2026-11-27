// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PortValue } from "../../../src/protocol/flowExecutors.ts";
import type { RunResult } from "../../../src/protocol/flowRuntime.ts";
import { createRunMemory } from "../../../web/flow/runMemory.ts";

const text = (value: string): Record<string, PortValue> => ({ text: { type: "text", value } });

// A run's result: each entry is a node id, its text output and, for a node
// that reuses on request, its fingerprint.
function ran(entries: Array<[string, string, string?]>): RunResult {
  return {
    outputs: new Map(entries.map(([id, value]) => [id, text(value)])),
    errors: new Map(),
    needs: new Map(),
    fingerprints: new Map(entries.flatMap(([id, , fingerprint]) => (fingerprint ? [[id, fingerprint]] : []))),
    skipped: new Map(),
  };
}

describe("runMemory", () => {
  // A zone's node gives one result per item; a repeat of any item finds its own.
  it("recalls each item of a For Each zone by its own fingerprint", () => {
    const memoryOf = createRunMemory(() => "");
    const item = (value: string, fingerprint: string) => ({
      outputs: new Map([["gen-1", text(value)]]),
      errors: new Map(),
      fingerprints: new Map([["gen-1", fingerprint]]),
      done: true,
    });
    memoryOf("a.flow.html").record({
      ...ran([["gen-1", "second", "fp2"]]),
      zones: new Map([["each", { items: [item("first", "fp1"), item("second", "fp2")], stopped: false }]]),
    });
    const memory = memoryOf("a.flow.html");
    expect(memory.recall("gen-1", "fp1")).toEqual(text("first"));
    expect(memory.recall("gen-1", "fp2")).toEqual(text("second"));
    expect(memory.recall("gen-1", "fp3")).toBeUndefined();
  });

  it("recalls a node's outputs only under the fingerprint they answer", () => {
    const memoryOf = createRunMemory(() => "");
    memoryOf("a.flow.html").record(ran([["gen-1", "kept", "fp1"]]));
    const memory = memoryOf("a.flow.html");
    expect(memory.recall("gen-1", "fp1")).toEqual(text("kept"));
    expect(memory.recall("gen-1", "fp2")).toBeUndefined();
  });

  // Node ids repeat across Flows, and one view shows every Flow its group opens.
  it("keeps each Flow's memory apart", () => {
    const memoryOf = createRunMemory(() => "");
    memoryOf("a.flow.html").record(ran([["gen-1", "from a", "fp"]]));
    expect(memoryOf("b.flow.html").recall("gen-1", "fp")).toBeUndefined();
    expect(memoryOf("b.flow.html").known().size).toBe(0);
  });

  // A blank model falls back to the default, so a new default is a new input.
  it("recalls nothing recorded under another default model", () => {
    let defaultModel = "anthropic/one";
    const memoryOf = createRunMemory(() => defaultModel);
    memoryOf("a.flow.html").record(ran([["gen-1", "kept", "fp"]]));
    defaultModel = "anthropic/two";
    expect(memoryOf("a.flow.html").recall("gen-1", "fp")).toBeUndefined();
  });

  it("gives Regenerate every node's last outputs but its own", () => {
    const memoryOf = createRunMemory(() => "");
    memoryOf("a.flow.html").record(
      ran([
        ["prompt-1", "p"],
        ["gen-1", "g", "fp"],
      ]),
    );
    expect([...memoryOf("a.flow.html", "gen-1").known().keys()]).toEqual(["prompt-1"]);
  });

  // Regenerate asks for a new result, so the node it runs is never answered
  // from memory, though the next Run is.
  it("never recalls the node Regenerate runs anew", () => {
    const memoryOf = createRunMemory(() => "");
    memoryOf("a.flow.html").record(ran([["gen-1", "kept", "fp"]]));
    expect(memoryOf("a.flow.html", "gen-1").recall("gen-1", "fp")).toBeUndefined();
    expect(memoryOf("a.flow.html").recall("gen-1", "fp")).toEqual(text("kept"));
  });

  // A Regenerate run hands back what it was given, with no fingerprint; the
  // stored one has to survive, or the held result would never match again.
  it("keeps a given node's entry when the run hands its outputs back", () => {
    const memoryOf = createRunMemory(() => "");
    memoryOf("a.flow.html").record(ran([["gen-1", "kept", "fp"]]));
    const memory = memoryOf("a.flow.html", "image-1");
    const given = memory.known();
    memory.record(
      ran([
        ["gen-1", "kept"],
        ["image-1", "new"],
      ]),
      given,
    );
    expect(memoryOf("a.flow.html").recall("gen-1", "fp")).toEqual(text("kept"));
  });
});
