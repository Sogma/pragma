// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLutLayer,
  type GrayMix,
  grayLut,
  LOOKS,
  type Look,
  type LutName,
  lookLabel,
  NO_LOOK,
  ORTHOCHROMATIC_MIX,
  PANCHROMATIC_MIX,
  readLook,
  toggleLook,
} from "../../../web/lib/videoLut.ts";
import { memorySetting } from "../support/editorLayout.ts";

const on = (lut: LutName): Look => ({ lut, on: true });
const off = (lut: LutName): Look => ({ lut, on: false });

describe("readLook", () => {
  it("reads each look back, on or off, and anything else as none", () => {
    expect(readLook(JSON.stringify(on("panchromatic")))).toEqual(on("panchromatic"));
    expect(readLook(JSON.stringify(off("orthochromatic")))).toEqual(off("orthochromatic"));
    expect(readLook('{"lut":"panchromatic"}')).toEqual(off("panchromatic"));
    for (const stored of [null, "", "panchromatic", "{", "null", '{"lut":"sepia","on":true}', '{"lut":"toString"}']) {
      expect(readLook(stored)).toEqual(NO_LOOK);
    }
  });
});

describe("toggleLook", () => {
  it("turns a picked look off and back on, keeping its LUT, and does nothing before the first pick", () => {
    const choice = memorySetting<Look>(NO_LOOK);
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

function setup(lut: LutName | null, options: { frame?: boolean; perFrame?: boolean; gpu?: boolean } = {}) {
  const fake = fakeGl();
  const getContext = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation((() => (options.gpu === false ? null : fake.gl)) as never);
  const { video, present } = clip(options);
  const choice = memorySetting<Look>(lut === null ? NO_LOOK : on(lut));
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
