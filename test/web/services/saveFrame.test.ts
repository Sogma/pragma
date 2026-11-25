// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpaceTreeNode } from "../../../src/protocol/api.ts";
import type { FrameGrab } from "../../../web/lib/videoPlayer.ts";
import type { CommandContext } from "../../../web/services/commands.ts";
import type { DialogService, FormOptions } from "../../../web/services/dialog.ts";
import { frameFileName, frameName, frameNameRefusal, saveFrameMenuItem } from "../../../web/services/saveFrame.ts";

const api = vi.hoisted(() => ({
  folder: Promise.resolve("a/stills") as Promise<string>,
  frameRate: 25 as number | null,
  uploads: [] as { dir: string; name: string; type: string }[],
  remembered: [] as [string, string][],
  asked: [] as [string, string][],
}));

vi.mock("../../../web/core/apiClient.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/core/apiClient.ts")>()),
  fetchFrameFolder: (clip: string, context: string) => {
    api.asked.push([clip, context]);
    return api.folder;
  },
  getVideoFormat: async () => ({ frameRate: api.frameRate }),
  postUploadFile: async (dir: string, name: string, file: Blob) => {
    api.uploads.push({ dir, name, type: file.type });
    return { path: dir ? `${dir}/${name}` : name, name };
  },
  postFrameFolder: async (context: string, folder: string) => {
    api.remembered.push([context, folder]);
  },
}));

const tree = vi.hoisted(() => ({ space: [] as SpaceTreeNode[] }));

vi.mock("../../../web/core/spaceTree.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../web/core/spaceTree.ts")>()),
  getTree: () => tree.space,
}));

const context: CommandContext = { tab: { kind: "empty" }, pane: undefined };

afterEach(() => {
  api.folder = Promise.resolve("a/stills");
  api.frameRate = 25;
  api.uploads = [];
  api.remembered = [];
  api.asked = [];
  document.body.replaceChildren();
});

describe("a frame's name", () => {
  it("is its clip's and the timecode it stands at, dashed, joined by an underscore", () => {
    expect(frameName("lib:takes/shot_010.mp4", 64.5, 24)).toBe("shot_010_00-01-04-12");
    expect(frameName("one.mov", 0, 25)).toBe("one_00-00-00-00");
  });

  it("saves as a PNG, an extension typed as well not doubled", () => {
    expect(frameFileName(" hero ")).toBe("hero.png");
    expect(frameFileName("hero.PNG")).toBe("hero.png");
    expect(frameFileName("hero.jpg")).toBe("hero.jpg.png");
    expect(frameFileName("  ")).toBe("");
    expect(frameFileName(".png")).toBe("");
  });

  it("is refused empty, with a slash or a character no name may hold, or taken in any case", () => {
    expect(frameNameRefusal("", [])).toBe("Enter a name.");
    expect(frameNameRefusal("a/b.png", [])).toBe("A name can't contain a slash.");
    expect(frameNameRefusal("a\\b.png", [])).toBe("A name can't contain a slash.");
    expect(frameNameRefusal("12:30.png", [])).toBe("A name can't contain < > : \" | ? * or control characters.");
    expect(frameNameRefusal(".hero.png", [])).toBe("A name can't start with a dot.");
    expect(frameNameRefusal("Hero.png", ["hero.PNG"])).toBe('"Hero.png" is already in that folder.');
    expect(frameNameRefusal("hero.png", ["hero.jpg"])).toBeUndefined();
  });
});

describe("Save frame…", () => {
  function frame(): { take: () => FrameGrab; blobs: string[] } {
    const canvas = document.createElement("canvas");
    const blobs: string[] = [];
    canvas.toBlob = (callback: BlobCallback, type?: string) => {
      blobs.push(type ?? "");
      callback(new Blob(["png"], { type }));
    };
    return { take: vi.fn(() => ({ canvas, seconds: 2 })), blobs };
  }

  // The form the item opens, and the answer each submit gave.
  function open(arg: unknown) {
    let options: FormOptions | undefined;
    const dialog = {
      form: vi.fn(async (opened: FormOptions) => {
        options = opened;
        return null;
      }),
    } as unknown as DialogService;
    const item = saveFrameMenuItem({ dialog: () => dialog });
    const ran = item.run?.(context, arg);
    const form = async () => {
      await ran;
      if (!options) throw new Error("no form opened");
      return options;
    };
    return { item, form };
  }

  it("is offered only where a player offers its frame", () => {
    const { item } = open(undefined);
    expect(item.label).toBe("Save frame…");
    expect(item.when?.(context, { file: "a/shots/one.mp4", bookmark: "a/shots/one.mp4" })).toBe(false);
    expect(item.when?.(context, { file: "a/shots/one.mp4", frame: frame().take })).toBe(true);
    expect(item.when?.(context, undefined)).toBe(false);
  });

  it("takes the frame as it is picked, and names it by the clip's header rate in the folder offered", async () => {
    const { take } = frame();
    const { form } = open({ file: "a/shots/one.mp4", bookmark: "a/shots/one.mp4", frame: take });
    expect(take).toHaveBeenCalledTimes(1);
    const options = await form();
    expect(options.title).toBe("Save frame");
    expect(options.figure?.tagName).toBe("CANVAS");
    const [name, folder] = options.fields;
    expect([name.value, name.suffix]).toEqual(["one_00-00-02-00", ".png"]);
    expect(folder.control?.value()).toBe("a/stills");
  });

  it("counts the player's fallback rate where the header names none, and offers the space's top on a failed read", async () => {
    api.frameRate = null;
    api.folder = Promise.reject(new Error("offline"));
    const options = await open({ file: "one.mp4", frame: frame().take }).form();
    expect(options.fields[0].value).toBe("one_00-00-02-00");
    expect(options.fields[1].control?.value()).toBe("");
  });

  it("refuses a name already in the folder, and saves a PNG under a free one, remembering the folder", async () => {
    tree.space = [
      {
        name: "a",
        path: "a",
        type: "directory",
        children: [{ name: "stills", path: "a/stills", type: "directory", children: [] }],
      },
    ];
    tree.space[0].children?.[0].children?.push({ name: "Hero.PNG", path: "a/stills/Hero.PNG", type: "file" });
    const { take, blobs } = frame();
    // Seen in the context of project b, whose folder it asks for and remembers.
    const options = await open({ file: "a/shots/one.mp4", frame: take, context: "b" }).form();
    expect(api.asked).toEqual([["a/shots/one.mp4", "b"]]);

    expect(await options.submit?.({ name: "hero", folder: "a/stills" })).toBe('"hero.png" is already in that folder.');
    expect(api.uploads).toEqual([]);

    expect(await options.submit?.({ name: "hero 2", folder: "a/stills" })).toBeUndefined();
    expect(blobs).toEqual(["image/png"]);
    expect(api.uploads).toEqual([{ dir: "a/stills", name: "hero 2.png", type: "image/png" }]);
    expect(api.remembered).toEqual([["b", "a/stills"]]);
  });
});
