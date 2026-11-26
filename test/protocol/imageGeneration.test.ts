import { APICallError } from "ai";
import { MockImageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { callImageModel, type ImageCallOptions, type ImageCallResult } from "../../src/protocol/imageGeneration.ts";

// The one function image calls go through, against the SDK's mock model.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function answer(warnings: ImageCallResult["warnings"] = []): ImageCallResult {
  return { images: [PNG], warnings, response: { timestamp: new Date(), modelId: "m", headers: undefined } };
}

describe("callImageModel", () => {
  it("hands the model the prompt, references, ratio and seed, and returns the image", async () => {
    const calls: ImageCallOptions[] = [];
    const model = new MockImageModelV4({
      doGenerate: async (options) => {
        calls.push(options);
        return answer();
      },
    });

    const result = await callImageModel(model, {
      prompt: "a red cup",
      references: [{ mediaType: "image/png", data: PNG }],
      aspectRatio: "16:9",
      seed: 7,
    });

    expect(result.data).toEqual(PNG);
    expect(result.mediaType).toBe("image/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ prompt: "a red cup", aspectRatio: "16:9", seed: 7, n: 1 });
    expect(calls[0].files).toEqual([expect.objectContaining({ type: "file", mediaType: "image/png" })]);
  });

  it("never retries, since every attempt may be charged", async () => {
    let attempts = 0;
    const model = new MockImageModelV4({
      doGenerate: async () => {
        attempts += 1;
        throw new APICallError({
          message: "busy",
          url: "x",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      },
    });

    await expect(callImageModel(model, { prompt: "a red cup", references: [] })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("words every warning for a person", async () => {
    const model = new MockImageModelV4({
      doGenerate: async () =>
        answer([
          { type: "unsupported", feature: "size", details: "takes an aspect ratio" },
          { type: "compatibility", feature: "seed" },
          { type: "other", message: "aspect_ratio: asked for 16:10, used 3:2" },
        ]),
    });

    const { warnings } = await callImageModel(model, { prompt: "a red cup", references: [] });
    expect(warnings).toEqual([
      "size isn't supported: takes an aspect ratio",
      "seed",
      "aspect_ratio: asked for 16:10, used 3:2",
    ]);
  });

  // The SDK deletes the gateway's own metadata entry's empty `images`, so an
  // image from the gateway provider comes with an entry that has none.
  it("returns the image when the gateway's own metadata entry has no images", async () => {
    const gateway = { images: [], cost: "0.03" };
    const model = new MockImageModelV4({
      doGenerate: async () => ({
        ...answer(),
        providerMetadata: {
          gateway,
          test: { images: [{ notes: ["quality: used 2k"], cost: { amount: 0.12, unit: "credits" } }] },
        },
      }),
    });
    const result = await callImageModel(model, { prompt: "a red cup", references: [] });
    expect(result.data).toEqual(PNG);
    expect(result.notes).toEqual(["quality: used 2k"]);
    expect(result.cost).toEqual({ amount: 0.12, unit: "credits" });

    const alone = new MockImageModelV4({
      doGenerate: async () => ({ ...answer(), providerMetadata: { gateway } }),
    });
    const only = await callImageModel(alone, { prompt: "a red cup", references: [] });
    expect(only.data).toEqual(PNG);
    expect(only.notes).toEqual([]);
    expect(only.cost).toBeUndefined();
  });
});
