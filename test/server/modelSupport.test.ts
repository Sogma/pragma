import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { IMAGE_REFERENCES_MAX } from "../../src/protocol/flowNodes.ts";
import { modelSupport, modelSupportEntries, parseModelSupport, supportIn } from "../../src/server/modelSupport.ts";

// The model support file is edited by hand as models change, so the shipped
// copy is read here: a typo fails this suite rather than a user's run.

const shipped = readFileSync(new URL("../../src/server/modelSupport.json", import.meta.url), "utf8");

const entry = (fields: Record<string, unknown> = {}) => ({
  ids: ["model_a"],
  source: "https://example.com/docs",
  checked: "2026-11-11",
  ...fields,
});
const file = (models: Record<string, unknown>) => JSON.stringify({ models });

describe("the shipped model support file", () => {
  it("reads without a fault", () => {
    expect(modelSupportEntries().length).toBeGreaterThan(0);
    expect(() => parseModelSupport(shipped)).not.toThrow();
  });

  // The Generate nodes declare their reference pins up to a fixed ceiling, so
  // a model taking more than it would never get its last ones.
  it("lists no model taking more reference images than the nodes have pins", () => {
    const most = Math.max(...modelSupportEntries().map((each) => each.references?.image ?? 0));
    expect(most).toBeLessThanOrEqual(IMAGE_REFERENCES_MAX);
  });

  it("gives Seedance 2.5 BytePlus's counts and its recommended words for a reference", () => {
    expect(modelSupport("seedance_2_5", "mcp.higgsfield.ai")).toEqual({
      references: { image: 30, video: 10, audio: 10 },
      mention: { image: "@Image{n}", video: "@Video{n}", audio: "@Audio{n}" },
      frames: ["start", "end"],
    });
  });

  // Higgsfield lists Kling 3.0 Omni with references only; its frames model
  // goes under another id.
  it("takes Kling 3.0 Omni's frames away on Higgsfield, and its brackets", () => {
    expect(modelSupport("kling_o3_image_reference").frames).toEqual(["start", "end"]);
    expect(modelSupport("kling_o3_image_reference", "mcp.higgsfield.ai")).toMatchObject({ frames: [], mention: {} });
  });
});

describe("a model's support", () => {
  const list = parseModelSupport(
    file({
      Exact: entry({ ids: ["gpt-image-2"], references: { image: 4 } }),
      Family: entry({ ids: ["gpt-image-*"], references: { image: 16 }, mention: { image: "image {n}" } }),
      Kling: entry({
        ids: ["kling"],
        mention: { image: "<<<image_{n}>>>" },
        hosts: { "mcp.example.ai": { mention: { image: null }, source: "its docs", checked: "2026-11-11" } },
      }),
    }),
  );

  it("takes an exact id over a family's, and a family's for the rest of its ids", () => {
    expect(supportIn(list, "gpt-image-2").references).toEqual({ image: 4 });
    expect(supportIn(list, "GPT-Image-2.5-Flare")).toEqual({
      references: { image: 16 },
      mention: { image: "image {n}" },
    });
  });

  it("lays a host's exception over the model's facts, a null back to the default words", () => {
    expect(supportIn(list, "kling").mention).toEqual({ image: "<<<image_{n}>>>" });
    expect(supportIn(list, "kling", "mcp.example.ai").mention).toEqual({});
  });

  it("knows nothing of a model it doesn't list", () => {
    expect(supportIn(list, "soul_2")).toEqual({ references: {}, mention: {} });
  });
});

describe("reading the file", () => {
  const fault = (models: Record<string, unknown>) => () => parseModelSupport(file(models));

  it("refuses a fact with no source or date, so a stale one can always be traced", () => {
    expect(fault({ A: entry({ source: undefined }) })).toThrow("A: names no source");
    expect(fault({ A: entry({ checked: "last week" }) })).toThrow("A: has no checked date");
  });

  it("refuses a misspelt key, a count that isn't whole and words with no place in them", () => {
    expect(fault({ A: entry({ refrences: { image: 3 } }) })).toThrow('A: has an unknown key "refrences"');
    expect(fault({ A: entry({ references: { image: 2.5 } }) })).toThrow("references.image isn't a whole number");
    expect(fault({ A: entry({ mention: { image: "Image" } }) })).toThrow("mention.image has no {n}");
    expect(fault({ A: entry({ frames: ["start", "middle"] }) })).toThrow('frames names "middle", not start or end');
  });

  it("refuses an id two models share, and a star anywhere but the end", () => {
    expect(fault({ A: entry(), B: entry() })).toThrow('B: shares the id "model_a" with A');
    expect(fault({ A: entry({ ids: ["gpt-*-image"] }) })).toThrow("neither a model id nor the start of one");
  });

  it("names the file and the doc that explains it", () => {
    expect(() => parseModelSupport("{")).toThrow(/src\/server\/modelSupport\.json: .*docs\/model-support\.md/);
  });
});
