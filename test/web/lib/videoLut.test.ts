// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Lut } from "../../../src/protocol/lutFile.ts";
import {
  builtInCube,
  createLutLayer,
  type GrayMix,
  grayLut,
  isBuiltInLook,
  LOOKS,
  type Look,
  type LutChoice,
  lookLabel,
  NO_LOOK,
  ORTHOCHROMATIC_MIX,
  PANCHROMATIC_MIX,
  readLook,
  toggleLook,
} from "../../../web/lib/videoLut.ts";
import { memorySetting } from "../support/editorLayout.ts";

const on = (lut: string): Look => ({ lut, on: true });
const off = (lut: string): Look => ({ lut, on: false });

// A choice holding Pragma's LUTs, and any LUT file `files` holds by its path.
function lookChoice(initial: Look, files: Record<string, Lut> = {}): LutChoice {
  return Object.assign(memorySetting<Look>(initial), {
    cube: (lut: string) => (isBuiltInLook(lut) ? builtInCube(lut) : files[lut]),
  });
}

describe("readLook", () => {
  it("reads each look back, on or off, and anything else as none", () => {
    expect(readLook(on("panchromatic"))).toEqual(on("panchromatic"));
    expect(readLook(off("orthochromatic"))).toEqual(off("orthochromatic"));
    expect(readLook({ lut: "panchromatic" })).toEqual(off("panchromatic"));
    for (const kept of [null, undefined, "", "panchromatic", 7, { lut: "sepia", on: true }, { lut: "toString" }]) {
      expect(readLook(kept)).toEqual(NO_LOOK);
    }
  });

  it("reads a LUT file's look by its rooted path, and nothing that names no LUT file", () => {
    expect(readLook(on("presets/luts/warm.cube"))).toEqual(on("presets/luts/warm.cube"));
    expect(readLook(off("lib:film/Print/2383.CUBE"))).toEqual(off("lib:film/Print/2383.CUBE"));
    for (const lut of ["presets/luts/warm.png", "../warm.cube", "foo:warm.cube", "lib:film"]) {
      expect(readLook(on(lut)), lut).toEqual(NO_LOOK);
    }
  });
});

describe("toggleLook", () => {
  it("turns a picked look off and back on, keeping its LUT, and does nothing before the first pick", () => {
    const choice = lookChoice(NO_LOOK);
    toggleLook(choice);
    expect(choice.get()).toEqual(NO_LOOK);

    choice.set(on("orthochromatic"));
    toggleLook(choice);
    expect(choice.get()).toEqual(off("orthochromatic"));
    toggleLook(choice);
    expect(choice.get()).toEqual(on("orthochromatic"));
  });
});

describe("LOOKS", () => {
  it("names each look, in the Looks menu's order", () => {
    expect(LOOKS.map(({ lut }) => [lut, lookLabel(lut)])).toEqual([
      ["panchromatic", "Panchromatic"],
      ["orthochromatic", "Orthochromatic"],
    ]);
  });

  it("names a LUT file's look by its file name, without the extension", () => {
    expect(lookLabel("lib:film/Print/Print_2383.cube")).toBe("Print_2383");
  });
});

describe("grayLut", () => {
  // The gray at a point of a 3-point cube, in each of its three channels.
  function grays(mix: GrayMix) {
    const { size, table } = grayLut(mix, 3);
    expect(size).toBe(3);
    expect(table).toHaveLength(3 ** 3 * 3);
    return (red: number, green: number, blue: number) => {
      const at = ((blue * size + green) * size + red) * 3;
      const [first, ...rest] = Array.from(table.subarray(at, at + 3));
      for (const channel of rest) expect(channel).toBe(first);
      return first;
    };
  }

  it("lists every point of the cube, red fastest, panchromatic's gray 21% of red, 72% of green and 7% of blue", () => {
    const gray = grays(PANCHROMATIC_MIX);
    expect(gray(0, 0, 0)).toBeCloseTo(0, 6);
    expect(gray(2, 2, 2)).toBeCloseTo(1, 6);
    expect(gray(2, 0, 0)).toBeCloseTo(0.21, 6);
    expect(gray(0, 2, 0)).toBeCloseTo(0.72, 6);
    expect(gray(0, 0, 2)).toBeCloseTo(0.07, 6);
    expect(gray(1, 1, 1)).toBeCloseTo(0.5, 6);
  });

  it("gives orthochromatic's gray none of red, 60% of green and 40% of blue", () => {
    const gray = grays(ORTHOCHROMATIC_MIX);
    expect(gray(2, 0, 0)).toBeCloseTo(0, 6);
    expect(gray(0, 2, 0)).toBeCloseTo(0.6, 6);
    expect(gray(0, 0, 2)).toBeCloseTo(0.4, 6);
    expect(gray(2, 2, 2)).toBeCloseTo(1, 6);
  });

  it("holds 33 points along each axis unless told otherwise", () => {
    expect(grayLut(PANCHROMATIC_MIX).size).toBe(33);
  });
});

// jsdom has no GPU, so the context is stood in for: each call is recorded,
// a constant reads as its own name, and shaders always compile and link.
function fakeGl() {
  const calls: { name: string; args: unknown[] }[] = [];
  const lose = { loseContext: vi.fn() };
  const state = { lost: false, unreadable: false };
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getExtension: (name) => (name === "WEBGL_lose_context" ? lose : null),
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    isContextLost: () => state.lost,
    texImage2D: () => {
      if (state.unreadable) throw new DOMException("The video element contains cross-origin data", "SecurityError");
    },
  };
  const gl = new Proxy(
    {},
    {
      get(_, key) {
        if (typeof key !== "string") return undefined;
        if (/^[A-Z0-9_]+$/.test(key)) return key;
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          return answers[key] ? answers[key](...args) : {};
        };
      },
    },
  );
  const named = (name: string) => calls.filter((call) => call.name === name);
  return { gl, calls, named, lose, state };
}

// A clip with a frame to show, or none yet, and the browser's per-frame
// callback, run when the test presents the next frame.
function clip(options: { frame?: boolean; perFrame?: boolean } = {}) {
  const video = document.createElement("video");
  let readyState = options.frame === false ? HTMLMediaElement.HAVE_METADATA : HTMLMediaElement.HAVE_CURRENT_DATA;
  Object.defineProperty(video, "readyState", { get: () => readyState, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  let next: (() => void) | undefined;
  let requests = 0;
  if (options.perFrame !== false) {
    video.requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
      next = () => callback(0, {} as VideoFrameCallbackMetadata);
      return ++requests;
    });
    video.cancelVideoFrameCallback = vi.fn(() => {
      next = undefined;
    });
  }
  return {
    video,
    present() {
      readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
      const run = next;
      next = undefined;
      run?.();
    },
  };
}

function setup(
  lut: string | null,
  options: { frame?: boolean; perFrame?: boolean; gpu?: boolean; files?: Record<string, Lut> } = {},
) {
  const fake = fakeGl();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation((() => (options.gpu === false ? null : fake.gl)) as never);
  const { video, present } = clip(options);
  const choice = lookChoice(lut === null ? NO_LOOK : on(lut), options.files);
  const layer = createLutLayer(video, choice);
  layers.push(layer);
  const drawn = () => fake.named("drawArrays").length;
  return { ...fake, getContext, video, present, choice, layer, drawn };
}

const layers: { dispose(): void }[] = [];
afterEach(() => {
  for (const layer of layers.splice(0)) layer.dispose();
  vi.restoreAllMocks();
});

describe("createLutLayer", () => {
  it("asks for no GPU context and stays hidden while no LUT is on", () => {
    const { getContext, layer, drawn, choice } = setup(null);
    expect(layer.element.className).toBe("video-lut");
    expect(layer.element.getAttribute("aria-hidden")).toBe("true");
    expect(layer.element.hidden).toBe(true);
    choice.set(off("panchromatic"));
    expect(layer.element.hidden).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
    expect(drawn()).toBe(0);
  });

  it("draws the frame on show at once through the LUT's cube, sized to the clip, then once per frame presented", () => {
    const { layer, video, present, named, drawn, getContext } = setup("panchromatic");
    expect(getContext).toHaveBeenCalledWith("webgl2", expect.objectContaining({ alpha: false }));
    expect(drawn()).toBe(1);
    expect(layer.element.hidden).toBe(false);
    expect([layer.element.width, layer.element.height]).toEqual([1920, 1080]);
    expect(named("texImage2D").at(-1)?.args.at(-1)).toBe(video);

    const [cube] = named("texImage3D");
    expect(cube.args.slice(0, 9)).toEqual(["TEXTURE_3D", 0, "RGB16F", 33, 33, 33, 0, "RGB", "FLOAT"]);
    expect(cube.args[9]).toEqual(grayLut(PANCHROMATIC_MIX).table);
    // 0 and 1 land on the outermost points' centers, half a point in from the cube's edges.
    expect(named("uniform1f").map((call) => call.args[1])).toEqual([32 / 33, 0.5 / 33]);

    present();
    present();
    expect(drawn()).toBe(3);
    expect(named("texImage3D")).toHaveLength(1);
  });

  it("stays hidden until a clip with no frame yet presents its first", () => {
    const { layer, present, drawn } = setup("panchromatic", { frame: false });
    expect(drawn()).toBe(0);
    expect(layer.element.hidden).toBe(true);

    present();
    expect(drawn()).toBe(1);
    expect(layer.element.hidden).toBe(false);
  });

  it("stops drawing and hides when the look goes off, and draws again at once when it comes back", () => {
    const { layer, video, present, choice, drawn, getContext } = setup("panchromatic");
    choice.set(off("panchromatic"));
    expect(layer.element.hidden).toBe(true);
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
    present();
    expect(drawn()).toBe(1);

    choice.set(on("panchromatic"));
    expect(drawn()).toBe(2);
    expect(layer.element.hidden).toBe(false);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it("draws a LUT file's cube with its input range, each channel its own", () => {
    const file: Lut = { size: 2, table: new Float32Array(24), domainMin: [0, 0.1, 0], domainMax: [1, 0.9, 2] };
    const { named, drawn } = setup("presets/luts/warm.cube", { files: { "presets/luts/warm.cube": file } });
    expect(drawn()).toBe(1);
    expect(named("texImage3D")[0].args.slice(3, 6)).toEqual([2, 2, 2]);
    expect(named("uniform3f").map((call) => call.args.slice(1))).toEqual([
      [0, 0.1, 0],
      [1, 0.9, 2],
    ]);
  });

  // The cube arrives later: the choice says so, and the layer draws then.
  it("shows the clip's own picture while a LUT file's cube is still on its way", () => {
    const { drawn, layer } = setup("presets/luts/late.cube");
    expect(drawn()).toBe(0);
    expect(layer.element.hidden).toBe(true);
  });

  it("loads another LUT's cube into the same context when the choice moves to it", () => {
    const { named, choice, drawn, getContext } = setup("panchromatic");
    choice.set(on("orthochromatic"));
    expect(named("texImage3D")).toHaveLength(2);
    expect(named("texImage3D")[1].args[9]).toEqual(grayLut(ORTHOCHROMATIC_MIX).table);
    expect(drawn()).toBe(2);
    expect(getContext).toHaveBeenCalledTimes(1);
  });

  it("gives its GPU context back and stops following the choice once disposed", () => {
    const { layer, choice, lose, drawn, present } = setup("panchromatic");
    layer.dispose();
    expect(lose.loseContext).toHaveBeenCalledTimes(1);
    expect(layer.element.hidden).toBe(true);

    choice.set(off("panchromatic"));
    choice.set(on("panchromatic"));
    present();
    expect(drawn()).toBe(1);
  });

  it("hides while its context is lost, keeping it restorable, and draws again once it is restored", () => {
    const { layer, state, named, drawn, present } = setup("panchromatic");
    state.lost = true;
    const lost = new Event("webglcontextlost", { cancelable: true });
    layer.element.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(layer.element.hidden).toBe(true);
    present();
    expect(drawn()).toBe(1);

    state.lost = false;
    layer.element.dispatchEvent(new Event("webglcontextrestored"));
    expect(named("linkProgram")).toHaveLength(2);
    expect(named("texImage3D")).toHaveLength(2);
    expect(drawn()).toBe(2);
    expect(layer.element.hidden).toBe(false);
  });

  it("leaves the clip's own picture showing where the page may not read its frames", () => {
    const fake = setup(null);
    fake.state.unreadable = true;
    fake.choice.set(on("panchromatic"));
    expect(fake.drawn()).toBe(0);
    expect(fake.layer.element.hidden).toBe(true);
  });

  it("leaves the clip's own picture showing where the browser has no WebGL 2", () => {
    const { layer, video, drawn } = setup("panchromatic", { gpu: false });
    expect(layer.element.hidden).toBe(true);
    expect(drawn()).toBe(0);
    expect(video.requestVideoFrameCallback).not.toHaveBeenCalled();
  });

  it("leaves the clip's own picture showing, and asks for no GPU context, where the browser has no per-frame callback", () => {
    const { layer, getContext } = setup("panchromatic", { perFrame: false });
    expect(layer.element.hidden).toBe(true);
    expect(getContext).not.toHaveBeenCalled();
  });
});

// A still decoded at 1200 × 800, one still loading, or one with no file yet,
// which an element counts as complete at no size.
function picture(loaded: boolean, file: boolean) {
  const img = document.createElement("img");
  let complete = loaded;
  let width = file ? 1200 : 0;
  Object.defineProperty(img, "complete", { get: () => complete, configurable: true });
  Object.defineProperty(img, "naturalWidth", { get: () => width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: 800, configurable: true });
  return {
    img,
    load() {
      complete = true;
      width = 1200;
      img.dispatchEvent(new Event("load"));
    },
  };
}

function setupStill(
  lut: string | null,
  options: { loaded?: boolean; file?: boolean; type?: string; files?: Record<string, Lut> } = {},
) {
  const fake = fakeGl();
  const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => fake.gl) as never);
  const { img, load } = picture(options.loaded ?? true, options.file ?? true);
  const choice = lookChoice(lut === null ? NO_LOOK : on(lut), options.files);
  const layer = createLutLayer(img, choice, options.type);
  layers.push(layer);
  const drawn = () => fake.named("drawArrays").length;
  return { ...fake, getContext, img, load, choice, layer, drawn };
}

describe("createLutLayer over a still", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("draws a decoded still at once, on a canvas that keeps its clear parts, and again as the look changes", () => {
    const { layer, getContext, drawn, named, choice, img } = setupStill("panchromatic");
    expect(getContext).toHaveBeenCalledWith("webgl2", expect.objectContaining({ alpha: true }));
    expect(drawn()).toBe(1);
    expect(named("texImage2D").at(-1)?.args.at(-1)).toBe(img);
    expect([layer.element.width, layer.element.height, layer.element.hidden]).toEqual([1200, 800, false]);

    choice.set(off("panchromatic"));
    expect(layer.element.hidden).toBe(true);
    choice.set(on("orthochromatic"));
    expect([drawn(), layer.element.hidden]).toEqual([2, false]);
  });

  it("waits for a still that is loading, and draws it as it arrives", () => {
    const { layer, drawn, load } = setupStill("panchromatic", { loaded: false });
    expect([drawn(), layer.element.hidden]).toEqual([0, true]);
    load();
    expect([drawn(), layer.element.hidden]).toEqual([1, false]);
  });

  // The preview lays the look over a picture before giving it its file, so
  // nothing can be read until the file loads.
  it("reads nothing from a still with no file yet, and shows it once its file loads", () => {
    const fetchFile = vi.fn(async () => new Response("GIF89a"));
    vi.stubGlobal("fetch", fetchFile);
    vi.stubGlobal(
      "ImageDecoder",
      class {
        completed = new Promise(() => {});
        close() {}
      },
    );
    const still = setupStill("panchromatic", { file: false });
    expect(still.drawn()).toBe(0);
    still.load();
    expect(still.drawn()).toBe(1);

    const gif = setupStill("panchromatic", { file: false, type: "image/gif" });
    expect(fetchFile).not.toHaveBeenCalled();
    gif.load();
    expect(fetchFile).toHaveBeenCalledTimes(1);
  });

  it("draws a GIF once where the browser can't decode its frames", () => {
    const { drawn } = setupStill("panchromatic", { type: "image/gif" });
    expect(drawn()).toBe(1);
  });

  // A canvas reads only an animated picture's first frame, so its frames
  // come from its file. The second frame's 0 ms shows for 100, as browsers
  // show it.
  it("plays an animated still's frames from its file, each as long as the file says, until the look goes off", async () => {
    vi.useFakeTimers();
    const durations = [50_000, 0];
    const decoded: number[] = [];
    const decoders: { closed: boolean; type: string }[] = [];
    class FakeDecoder {
      closed = false;
      type: string;
      completed = Promise.resolve();
      tracks = { selectedTrack: { animated: true, frameCount: 2, repetitionCount: Number.POSITIVE_INFINITY } };
      constructor(init: { type: string }) {
        this.type = init.type;
        decoders.push(this);
      }
      async decode({ frameIndex }: { frameIndex: number }) {
        decoded.push(frameIndex);
        const image = { displayWidth: 300, displayHeight: 200, duration: durations[frameIndex], close: vi.fn() };
        return { image };
      }
      close() {
        this.closed = true;
      }
    }
    vi.stubGlobal("ImageDecoder", FakeDecoder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("GIF89a")),
    );
    const { drawn, choice, layer } = setupStill("panchromatic", { type: "image/gif" });

    await vi.advanceTimersByTimeAsync(0);
    expect([decoders[0].type, decoded, drawn()]).toEqual(["image/gif", [0], 1]);
    expect([layer.element.width, layer.element.height]).toEqual([300, 200]);
    await vi.advanceTimersByTimeAsync(49);
    expect(decoded).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decoded).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(100);
    expect([decoded, drawn()]).toEqual([[0, 1, 0], 3]);

    choice.set(off("panchromatic"));
    expect(decoders[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(drawn()).toBe(3);
  });
});
