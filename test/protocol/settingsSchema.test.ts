import { describe, expect, it } from "vitest";
import {
  flattenSettingsSchema,
  readSettingsToggle,
  readSettingsValue,
  toSettingsPatch,
} from "../../src/protocol/settingsSchema.ts";

// The shape Sogma actually serves as components.schemas.SiteSettings.
const sogmaSchema = {
  type: "object",
  properties: {
    analytics: {
      type: "object",
      properties: {
        ga_id: {
          type: ["string", "null"],
          title: "Google Analytics ID",
          description: "GA4 measurement id, rendered into every page's <head> regardless of theme.",
          pattern: "^G-[A-Z0-9]{6,10}$",
          "x-sogma-group": "Analytics",
          "x-sogma-placeholder": "G-ABC1234DEF",
        },
        gtm_id: {
          type: ["string", "null"],
          title: "Google Tag Manager ID",
          "x-sogma-group": "Analytics",
        },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};

describe("flattenSettingsSchema", () => {
  it("flattens nested properties into JSON Pointers, carrying presentation through", () => {
    const { fields, skipped } = flattenSettingsSchema(sogmaSchema);

    expect(skipped).toBe(0);
    expect(fields).toEqual([
      {
        pointer: "/analytics/ga_id",
        label: "Google Analytics ID",
        description: "GA4 measurement id, rendered into every page's <head> regardless of theme.",
        placeholder: "G-ABC1234DEF",
        group: "Analytics",
      },
      { pointer: "/analytics/gtm_id", label: "Google Tag Manager ID", group: "Analytics" },
    ]);
  });

  it("counts fields it can't draw instead of failing or inventing a control", () => {
    const { fields, skipped } = flattenSettingsSchema({
      type: "object",
      properties: {
        theme: { type: "string", enum: ["light", "dark"], title: "Theme" },
        posts_per_page: { type: "integer", title: "Posts per page" },
        published: { type: "boolean", title: "Published" },
        logo: { type: "string", format: "uri", title: "Logo" },
        tagline: { type: ["string", "null"], title: "Tagline" },
      },
    });

    // Only the boolean and the plain string survive — the rule that lets a
    // publisher ship a new kind of control without breaking clients that
    // predate it.
    expect(fields.map((field) => field.pointer)).toEqual(["/published", "/tagline"]);
    expect(skipped).toBe(3);
  });

  it("draws a boolean as a toggle", () => {
    // Sogma's resource schema: a plain boolean, never null, off by default.
    const { fields, skipped } = flattenSettingsSchema({
      type: "object",
      properties: {
        indexing: {
          type: "object",
          properties: {
            block_ai_training: {
              type: "boolean",
              default: false,
              title: "Block AI training",
              description: "Asks AI companies not to train models on the site.",
              "x-sogma-group": "Search & AI",
            },
            nullable: { type: ["boolean", "null"], title: "Nullable" },
            choice: { type: "boolean", enum: [true], title: "Choice" },
          },
        },
      },
    });

    expect(fields).toEqual([
      {
        pointer: "/indexing/block_ai_training",
        label: "Block AI training",
        description: "Asks AI companies not to train models on the site.",
        group: "Search & AI",
        kind: "toggle",
      },
      { pointer: "/indexing/nullable", label: "Nullable", kind: "toggle" },
    ]);
    expect(skipped).toBe(1);
  });

  it("draws a file reference as an image field", () => {
    const { fields, skipped } = flattenSettingsSchema({
      type: "object",
      properties: {
        identity: {
          type: "object",
          properties: {
            logo: {
              type: ["string", "null"],
              pattern: "^[0-9A-Za-z]{1,64}$",
              title: "Logo",
              "x-sogma-ref": "file",
              "x-sogma-group": "Identity",
            },
            owner: { type: ["string", "null"], title: "Owner", "x-sogma-ref": "user" },
          },
        },
      },
    });

    expect(fields).toEqual([{ pointer: "/identity/logo", label: "Logo", group: "Identity", kind: "image" }]);
    expect(skipped).toBe(1);
  });

  it("falls back to the key when a field declares no title", () => {
    const { fields } = flattenSettingsSchema({ type: "object", properties: { ga_id: { type: "string" } } });
    expect(fields[0]).toEqual({ pointer: "/ga_id", label: "ga_id" });
  });

  it("escapes pointer segments per RFC 6901", () => {
    const { fields } = flattenSettingsSchema({
      type: "object",
      properties: { "a/b": { type: "string" }, "c~d": { type: "string" } },
    });
    expect(fields.map((field) => field.pointer)).toEqual(["/a~1b", "/c~0d"]);
  });

  it("reads nothing out of a schema that isn't one", () => {
    expect(flattenSettingsSchema(undefined)).toEqual({ fields: [], skipped: 0 });
  });
});

describe("readSettingsValue", () => {
  const stored = { analytics: { ga_id: "G-ABC1234DEF", gtm_id: null } };

  it("reads a nested value by pointer", () => {
    expect(readSettingsValue(stored, "/analytics/ga_id")).toBe("G-ABC1234DEF");
  });

  it("reads an unset field, an absent one, and an absent branch as empty", () => {
    expect(readSettingsValue(stored, "/analytics/gtm_id")).toBe("");
    expect(readSettingsValue(stored, "/analytics/nothing")).toBe("");
    expect(readSettingsValue(stored, "/seo/title")).toBe("");
  });

  it("round-trips an escaped segment", () => {
    expect(readSettingsValue({ "a/b": "x" }, "/a~1b")).toBe("x");
  });
});

describe("readSettingsToggle", () => {
  it("reads only true as on", () => {
    const stored = { indexing: { on: true, off: false, unset: null, text: "true" } };
    expect(readSettingsToggle(stored, "/indexing/on")).toBe(true);
    expect(readSettingsToggle(stored, "/indexing/off")).toBe(false);
    expect(readSettingsToggle(stored, "/indexing/unset")).toBe(false);
    expect(readSettingsToggle(stored, "/indexing/text")).toBe(false);
    expect(readSettingsToggle(stored, "/indexing/absent")).toBe(false);
    expect(readSettingsToggle(stored, "/missing/branch")).toBe(false);
  });
});

describe("toSettingsPatch", () => {
  it("rebuilds the service's nesting from pointer-keyed edits", () => {
    expect(toSettingsPatch({ "/analytics/ga_id": "G-ABC1234DEF" })).toEqual({
      analytics: { ga_id: "G-ABC1234DEF" },
    });
  });

  it("keeps sibling edits in one branch", () => {
    expect(toSettingsPatch({ "/analytics/ga_id": "G-ABC1234DEF", "/analytics/gtm_id": null })).toEqual({
      analytics: { ga_id: "G-ABC1234DEF", gtm_id: null },
    });
  });

  it("carries a toggle through as a boolean, false included", () => {
    expect(toSettingsPatch({ "/indexing/block_ai_training": true, "/indexing/block_ai_search": false })).toEqual({
      indexing: { block_ai_training: true, block_ai_search: false },
    });
  });

  it("carries null through as the merge patch's own clear", () => {
    expect(toSettingsPatch({ "/analytics/ga_id": null })).toEqual({ analytics: { ga_id: null } });
  });

  it("is empty when nothing changed, so a write touches nothing", () => {
    expect(toSettingsPatch({})).toEqual({});
  });
});
