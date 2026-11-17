// Fountain, the format a screenplay is written in: its page in the editor,
// drawn formatted while edited and as written in Source mode, its Format
// column's actions and typing keys, the names it links to its project's world,
// a reading view that keeps the locked editor with what Fountain never prints
// hidden, its font and its page zoom. Everything a screenplay needs is here.
import { zoomMenu, zoomMenuItems } from "../../lib/zoomPicker.ts";
import type { TextFormat } from "../../services/formats.ts";
import type { ContextMenuService } from "../../services/menus.ts";
import type { Setting, ZoomSetting } from "../../services/settings.ts";
import { screenplayActions } from "./actions.ts";
import { fountain, fountainFormatting, screenplayWorldLinks, worldNamesChanged } from "./language.ts";
import {
  type ScreenplayFont,
  screenplayFont,
  screenplayFontAttribute,
  screenplaySettings,
  screenplayZoom,
  screenplayZoomProperty,
} from "./settings.ts";
import { screenplayTyping } from "./typing.ts";

export interface ScreenplayFormatDeps {
  // What a name in the screenplay at that path links to, by its project's
  // world; undefined outside a project.
  worldNames(docPath: string): ((name: string) => string | undefined) | undefined;
  // Where its Settings page's font picker opens its menu.
  contextMenu: ContextMenuService;
  // The stored font and page zoom unless a test hands in others.
  font?: Setting<ScreenplayFont>;
  zoom?: ZoomSetting;
}

export function screenplayFormat(deps: ScreenplayFormatDeps): TextFormat {
  const font = deps.font ?? screenplayFont;
  const zoom = deps.zoom ?? screenplayZoom;
  return {
    extensions: (context) => [
      fountain({
        resolver: () => {
          const path = context.path();
          return path === undefined ? undefined : deps.worldNames(path);
        },
        showMenu: (file, at) => context.showLinkMenu(file, at),
      }),
      screenplayTyping(),
      screenplayFontAttribute(font),
      screenplayZoomProperty(zoom),
    ],
    formatting: () => fountainFormatting(),
    actions: screenplayActions,
    menu: [zoomMenu(zoomMenuItems(zoom))],
    links(model, state) {
      const resolve = deps.worldNames(model.path);
      return { found: resolve ? screenplayWorldLinks(state, resolve) : [], missing: [] };
    },
    embedsImages: false,
    spaceChanged: (view) => view.dispatch({ effects: worldNamesChanged.of(null) }),
    settings: screenplaySettings(font, zoom, deps.contextMenu),
    scopeSettings: {
      title: "Screenplay",
      keys: { world: { label: "World", description: "Names in a screenplay link to the notes in this folder." } },
    },
  };
}
