// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { Tab } from "../../../../web/core/apiClient.ts";
import { screenplayFormat } from "../../../../web/formats/screenplay/format.ts";
import { SCREENPLAY_ZOOM_LEVELS } from "../../../../web/formats/screenplay/settings.ts";
import { Emitter } from "../../../../web/lib/emitter.ts";
import { type CommandContext, createCommands } from "../../../../web/services/commands.ts";
import { createMenus } from "../../../../web/services/menus.ts";
import type { ZoomSetting } from "../../../../web/services/settings.ts";
import { fakeContextMenu } from "../../support/fakeContextMenu.ts";

describe("a screenplay's ⋮ menu", () => {
  it("offers Zoom, its steps checked by the zoom every screenplay shares, a pick setting it", () => {
    const stored = new Emitter<number>(120);
    const zoom: ZoomSetting = {
      levels: SCREENPLAY_ZOOM_LEVELS,
      get: () => stored.get(),
      set: (value) => stored.set(value),
      subscribe: (listener) => stored.subscribe(listener),
    };
    const format = screenplayFormat({ worldNames: () => undefined, contextMenu: fakeContextMenu(), zoom });
    const menus = createMenus(createCommands());
    const tab: Tab = { kind: "document", path: "script.fountain", documentType: "screenplay" };
    const context: CommandContext = { tab, pane: undefined };
    const [zoomItem] = menus.resolveItems([...(format.menu ?? [])], context);
    expect(zoomItem?.label).toBe("Zoom");
    const steps = zoomItem?.submenu ?? [];
    expect(steps.map((step) => step.label)).toEqual(["80%", "90%", "100%", "110%", "120%", "130%", "140%", "150%"]);
    expect(steps.filter((step) => step.checked).map((step) => step.label)).toEqual(["120%"]);

    void steps.find((step) => step.label === "150%")?.run?.(context, undefined);
    expect(zoom.get()).toBe(150);
  });
});
