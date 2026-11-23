import { describe, expect, it } from "vitest";
import { defaultModels, newestOfEachFamily } from "../../../web/core/providerPresets.ts";

// What a fresh provider starts with ticked. The Gemini lists are what Google
// served on 2026-10-09; the others follow each vendor's naming.

const GEMINI = {
  textModels: [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-transcribe",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.8-flash-tts",
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
    "gemini-omni-1.1-flash",
    "gemini-omni-flash-preview",
    "gemini-pro-latest",
    "gemini-robotics-er-2-preview",
    "gemma-4-26b-a4b-it",
    "gemma-4-31b-it",
    "lyria-3-clip-preview",
  ],
  imageModels: [
    "gemini-2.5-flash-image",
    "gemini-3-pro-image",
    "gemini-3-pro-image-preview",
    "gemini-3.1-flash-image",
    "gemini-3.1-flash-image-preview",
    "gemini-3.1-flash-lite-image",
    "gemini-nano-banana-2.1",
  ],
  videoModels: [],
};

describe("defaultModels", () => {
  it("ticks only Gemini's rolling aliases, and the newest stable image model of each line", () => {
    expect(defaultModels("aliases", GEMINI)).toEqual({
      textModels: ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-pro-latest"],
      imageModels: [
        "gemini-3-pro-image",
        "gemini-3.1-flash-image",
        "gemini-3.1-flash-lite-image",
        "gemini-nano-banana-2.1",
      ],
      videoModels: [],
    });
  });

  it("falls back to the newest of each family when a list has no aliases", () => {
    const pinnedOnly = {
      textModels: ["gemini-3.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-tts"],
      imageModels: [],
      videoModels: [],
    };
    expect(defaultModels("aliases", pinnedOnly).textModels).toEqual(["gemini-3.8-flash"]);
  });

  it("ticks Anthropic's newest of each line, a dated id where it lists only that", () => {
    const anthropic = [
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-1-20250805",
      "claude-sonnet-4-5-20250929",
      "claude-sonnet-4-20250514",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-haiku-20241022",
      "claude-3-haiku-20240307",
    ];
    expect(defaultModels("newest", { textModels: anthropic, imageModels: [], videoModels: [] }).textModels).toEqual([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-haiku-4-5-20251001",
    ]);
  });

  it("ticks OpenAI's newest of each line, and no model a text picker can't use", () => {
    const openai = {
      textModels: [
        "gpt-4.1",
        "gpt-4.1-mini",
        "gpt-4o",
        "gpt-5",
        "gpt-5-2025-08-07",
        "gpt-5-mini",
        "gpt-5.2",
        "gpt-5.2-mini",
        "o3",
        "o3-mini",
        "o4-mini",
        "sora-2",
        "text-embedding-3-large",
        "tts-1",
        "whisper-1",
      ],
      imageModels: ["gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5"],
      videoModels: [],
    };
    // gpt-4o names its line "4o", which no newer id continues.
    expect(defaultModels("newest", openai)).toEqual({
      textModels: ["gpt-4o", "gpt-5.2", "gpt-5.2-mini", "o3", "o4-mini"],
      imageModels: ["gpt-image-1-mini", "gpt-image-1.5"],
      videoModels: [],
    });
  });

  it("ticks a local server's every model, and a long list's none", () => {
    const local = { textModels: ["qwen/qwen3.5-35b-a3b", "nomic-embed-text"], imageModels: [], videoModels: [] };
    expect(defaultModels("all", local).textModels).toEqual(local.textModels);
    expect(defaultModels("pick", local).textModels).toEqual(local.textModels);
    const long = { textModels: Array.from({ length: 21 }, (_, n) => `model-${n}`), imageModels: [], videoModels: [] };
    expect(defaultModels("pick", long).textModels).toEqual([]);
  });

  it("ticks the newest image and video model of each line, and none of a gateway's long lists", () => {
    const short = { textModels: [], imageModels: [], videoModels: ["maker/clip-1.0", "maker/clip-2.0"] };
    expect(defaultModels("pick", short).videoModels).toEqual(["maker/clip-2.0"]);
    const many = Array.from({ length: 21 }, (_, n) => `maker${n}/clip-1`);
    const gateway = { textModels: [], imageModels: many, videoModels: many };
    expect(defaultModels("pick", gateway)).toEqual({ textModels: [], imageModels: [], videoModels: [] });
    expect(defaultModels("newest", gateway).videoModels).toHaveLength(21);
  });
});

describe("newestOfEachFamily", () => {
  it("prefers a stable id to a snapshot or a preview, even a newer preview", () => {
    expect(newestOfEachFamily(["gpt-4o-2024-08-06", "gpt-4o"])).toEqual(["gpt-4o"]);
    expect(newestOfEachFamily(["gemini-3.5-flash-image-preview", "gemini-3.1-flash-image"])).toEqual([
      "gemini-3.1-flash-image",
    ]);
    expect(newestOfEachFamily(["gemini-2.5-flash-preview-05-20", "gemini-2.0-flash-001"])).toEqual([
      "gemini-2.0-flash-001",
    ]);
  });

  it("keeps a family that has only a preview", () => {
    expect(newestOfEachFamily(["gemini-3-pro-image-preview"])).toEqual(["gemini-3-pro-image-preview"]);
  });

  it("lets a rolling alias stand for its family, but not one pinned to a version", () => {
    expect(newestOfEachFamily(["gemini-3.8-flash", "gemini-flash-latest"])).toEqual(["gemini-flash-latest"]);
    expect(newestOfEachFamily(["claude-3-5-sonnet-latest", "claude-sonnet-5-5"])).toEqual(["claude-sonnet-5-5"]);
  });

  it("keeps sizes apart as families of their own", () => {
    expect(newestOfEachFamily(["gemma-4-26b-a4b-it", "gemma-4-31b-it", "gemma-3-27b-it"])).toEqual([
      "gemma-4-26b-a4b-it",
      "gemma-4-31b-it",
      "gemma-3-27b-it",
    ]);
  });
});
