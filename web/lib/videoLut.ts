// The LUT a player or a still's viewer shows its picture through, as a
// monitor LUT does: the GPU looks each pixel of each frame up in a color
// cube, and a canvas over the picture shows the result. The file is never
// touched; its own element still decodes it, and a clip's plays its sound
// underneath.
import { type Lut, UNIT_DOMAIN } from "../../src/protocol/lutFile.ts";
import { basenameOf, parseRootedPath } from "../../src/protocol/rootedPath.ts";
import { isLutFile } from "../../src/protocol/types.ts";

/** The LUTs Pragma ships, by the name a stored choice keeps. */
export type LutName = "panchromatic" | "orthochromatic";

/** The look a player shows its picture through: one of Pragma's LUTs by
 * name or a LUT file in a preset folder by its rooted path, none before the
 * first pick, kept while the look is off so it can come back. */
export interface Look {
  lut: string | null;
  on: boolean;
}

export const NO_LOOK: Look = { lut: null, on: false };

/** The look every viewer with a LOOK badge shows its picture through: changed
 * in one, it changes in all. `cube` answers a look's table, a LUT file's once
 * read; `kept`, `trying` and `missing` tell a badge what it stands for. */
export interface LutChoice {
  get(): Look;
  set(look: Look): void;
  subscribe(listener: (look: Look) => void): () => void;
  cube(lut: string): Lut | undefined;
  kept?(): Look;
  trying?(): boolean;
  missing?(): boolean;
}

/** Whether `lut` names one of Pragma's own LUTs. */
export function isBuiltInLook(lut: string): lut is LutName {
  return Object.hasOwn(LUTS, lut);
}

/** Whether `lut` names a LUT file, by a rooted path. */
function isFileLook(lut: string): boolean {
  if (!isLutFile(lut)) return false;
  try {
    return parseRootedPath(lut).path !== "";
  } catch {
    return false;
  }
}

/** A look read back from where it was kept, where anything unknown reads as
 * none. */
export function readLook(value: unknown): Look {
  if (typeof value !== "object" || value === null) return NO_LOOK;
  const { lut, on } = value as Record<string, unknown>;
  if (typeof lut !== "string" || !(isBuiltInLook(lut) || isFileLook(lut))) return NO_LOOK;
  return { lut, on: on === true };
}

/** Turns the look off, or back on, keeping its LUT. Before the first pick
 * there is nothing to turn on. */
export function toggleLook(choice: LutChoice): void {
  const look = choice.kept?.() ?? choice.get();
  if (look.lut !== null) choice.set({ ...look, on: !look.on });
}

/** The looks the Looks menu lists, in its order, each by the name it shows. */
export const LOOKS: readonly { lut: LutName; label: string }[] = [
  { lut: "panchromatic", label: "Panchromatic" },
  { lut: "orthochromatic", label: "Orthochromatic" },
];

/** A look's name, as the Looks menu lists it: a LUT file's, its file name
 * without the extension. */
export function lookLabel(lut: string): string {
  const own = LOOKS.find((look) => look.lut === lut)?.label;
  if (own !== undefined) return own;
  return basenameOf(lut).replace(/\.cube$/i, "");
}

/** The share of a color's red, green and blue its gray takes. */
export type GrayMix = readonly [red: number, green: number, blue: number];

// Panchromatic film sees every color. Orthochromatic film is blind to red,
// so reds print dark.
export const PANCHROMATIC_MIX: GrayMix = [0.21, 0.72, 0.07];
export const ORTHOCHROMATIC_MIX: GrayMix = [0, 0.6, 0.4];

/** A black and white: each color to its `mix` of red, green and blue, in
 * all three channels. */
export function grayLut(mix: GrayMix, size = 33): Lut {
  const table = new Float32Array(size ** 3 * 3);
  const step = 1 / (size - 1);
  let at = 0;
  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) {
        const gray = (mix[0] * red + mix[1] * green + mix[2] * blue) * step;
        table.fill(gray, at, at + 3);
        at += 3;
      }
    }
  }
  return { size, table, domainMin: UNIT_DOMAIN.min, domainMax: UNIT_DOMAIN.max };
}

const LUTS: Record<LutName, () => Lut> = {
  panchromatic: () => grayLut(PANCHROMATIC_MIX),
  orthochromatic: () => grayLut(ORTHOCHROMATIC_MIX),
};

const builtIn = new Map<LutName, Lut>();

/** One of Pragma's LUTs, made once. */
export function builtInCube(name: LutName): Lut {
  let made = builtIn.get(name);
  if (!made) {
    made = LUTS[name]();
    builtIn.set(name, made);
  }
  return made;
}

// One triangle over the whole canvas. A frame's top row is its texture's
// first, so the texture's rows run down the canvas.
const VERTEX_SHADER = `#version 300 es
out vec2 at;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  at = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

// The GPU's filtering reads between the cube's points. Its outermost points
// are texel centers, half a texel in from the edges, so `scale` and `offset`
// land 0 and 1 on them rather than on the edges. A color is first placed in
// the file's input range, each channel its own, one outside it taking the
// nearest edge's.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
uniform sampler2D frame;
uniform sampler3D cube;
uniform float scale;
uniform float offset;
uniform vec3 domainMin;
uniform vec3 domainMax;
in vec2 at;
out vec4 color;
void main() {
  vec4 source = texture(frame, at);
  vec3 placed = clamp((source.rgb - domainMin) / (domainMax - domainMin), 0.0, 1.0);
  color = vec4(texture(cube, placed * scale + offset).rgb * source.a, source.a);
}`;

interface Pipeline {
  frameTexture: WebGLTexture;
  cubeTexture: WebGLTexture;
  scale: WebGLUniformLocation | null;
  offset: WebGLUniformLocation | null;
  domainMin: WebGLUniformLocation | null;
  domainMax: WebGLUniformLocation | null;
  // The LUT the cube texture holds.
  loaded: Lut | null;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

// A texture's default filter reads mipmaps, which neither texture has, and
// samples black without them: both read linearly, clamped at the edges.
function texture(gl: WebGL2RenderingContext, target: number, unit: number): WebGLTexture {
  const made = gl.createTexture();
  gl.activeTexture(unit);
  gl.bindTexture(target, made);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const wraps: number[] = [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T];
  if (target === gl.TEXTURE_3D) wraps.push(gl.TEXTURE_WRAP_R);
  for (const wrap of wraps) gl.texParameteri(target, wrap, gl.CLAMP_TO_EDGE);
  return made;
}

function buildPipeline(gl: WebGL2RenderingContext): Pipeline | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!vertex || !fragment || !program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, "frame"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "cube"), 1);
  return {
    frameTexture: texture(gl, gl.TEXTURE_2D, gl.TEXTURE0),
    cubeTexture: texture(gl, gl.TEXTURE_3D, gl.TEXTURE1),
    scale: gl.getUniformLocation(program, "scale"),
    offset: gl.getUniformLocation(program, "offset"),
    domainMin: gl.getUniformLocation(program, "domainMin"),
    domainMax: gl.getUniformLocation(program, "domainMax"),
    loaded: null,
  };
}

function loadCube(gl: WebGL2RenderingContext, pipeline: Pipeline, lut: Lut): void {
  const { size, table, domainMin, domainMax } = lut;
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, pipeline.cubeTexture);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, table);
  gl.uniform1f(pipeline.scale, (size - 1) / size);
  gl.uniform1f(pipeline.offset, 0.5 / size);
  gl.uniform3f(pipeline.domainMin, domainMin[0], domainMin[1], domainMin[2]);
  gl.uniform3f(pipeline.domainMax, domainMax[0], domainMax[1], domainMax[2]);
  pipeline.loaded = lut;
}

export interface LutLayer {
  /** Goes in the player's box, or a still's, under the guides. */
  readonly element: HTMLCanvasElement;
  dispose(): void;
}

// The stills whose files may hold more than one frame.
const ANIMATED_TYPES = new Set(["image/gif", "image/webp"]);

// A GIF frame shown for 10 ms or less, which browsers show for 100.
const SHORTEST_FRAME_MS = 10;
const STAND_IN_FRAME_MS = 100;

/** A canvas over `media` showing it through the look `choice` names. A
 * still's media `type` lets one that animates play its frames. */
export function createLutLayer(media: HTMLVideoElement | HTMLImageElement, choice: LutChoice, type?: string): LutLayer {
  const element = document.createElement("canvas");
  element.className = "video-lut";
  element.setAttribute("aria-hidden", "true");
  // Until its first frame is drawn the canvas shows nothing of the picture,
  // so it stays hidden until then and the media's own picture shows.
  element.hidden = true;
  const video = media instanceof HTMLVideoElement ? media : undefined;
  // A page keeps only so many GPU contexts and drops its oldest past that,
  // so a player asks for one only once a LUT is on.
  let gl: WebGL2RenderingContext | null = null;
  let pipeline: Pipeline | null = null;
  let frameRequest: number | undefined;
  let disposed = false;
  // Counts the looks applied, so frames still decoding for an earlier one
  // are dropped.
  let run = 0;
  let frameTimer = 0;
  let decoder: ImageDecoder | undefined;
  // Whether a look is showing, and whether a still has begun to show through
  // it: one the look meets still loading begins as it loads.
  let active = false;
  let stillShown = false;

  // A LUT file's cube may still be on its way: the choice says when it lands.
  function prepare(name: string): boolean {
    const lut = choice.cube(name);
    if (!lut) return false;
    // A still keeps its clear parts clear, over its checkerboard.
    gl ??= element.getContext("webgl2", { alpha: !video, antialias: false, depth: false, stencil: false });
    if (!gl || gl.isContextLost()) return false;
    pipeline ??= buildPipeline(gl);
    if (!pipeline) return false;
    if (pipeline.loaded !== lut) loadCube(gl, pipeline, lut);
    return true;
  }

  function draw(source: TexImageSource, width: number, height: number): void {
    if (!gl || !pipeline || !width || !height) return;
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pipeline.frameTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      // Media from another origin can't be read: its own picture shows.
      return;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    element.hidden = false;
  }

  function drawVideo(clip: HTMLVideoElement): void {
    if (clip.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) draw(clip, clip.videoWidth, clip.videoHeight);
  }

  // Drawn once, or its frames played where it animates. Before it has
  // loaded, or before it has a file at all, its load shows it.
  function showStill(img: HTMLImageElement): void {
    if (!img.complete || img.naturalWidth === 0) return;
    stillShown = true;
    if (type && ANIMATED_TYPES.has(type) && typeof ImageDecoder === "function") void playFrames(img, type, run);
    else draw(img, img.naturalWidth, img.naturalHeight);
  }

  function watchFrames(clip: HTMLVideoElement): void {
    frameRequest = clip.requestVideoFrameCallback(() => {
      watchFrames(clip);
      drawVideo(clip);
    });
  }

  // A canvas reads only an animated picture's first frame, so one that
  // animates plays its frames here, decoded from its file and timed as the
  // file times them. Where the browser can't decode them, or the file holds
  // one frame, the picture is drawn once.
  async function playFrames(img: HTMLImageElement, mediaType: string, mine: number): Promise<void> {
    try {
      const response = await fetch(img.currentSrc || img.src);
      if (!response.body || mine !== run) return;
      const opened = new ImageDecoder({ data: response.body, type: mediaType });
      decoder = opened;
      await opened.completed;
      const track = opened.tracks.selectedTrack;
      if (mine !== run) return;
      if (!track?.animated || track.frameCount < 2) {
        draw(img, img.naturalWidth, img.naturalHeight);
        return;
      }
      let index = 0;
      let plays = 0;
      const next = async () => {
        const { image } = await opened.decode({ frameIndex: index });
        if (mine !== run) {
          image.close();
          return;
        }
        draw(image, image.displayWidth, image.displayHeight);
        const shown = (image.duration ?? 0) / 1000;
        image.close();
        index = (index + 1) % track.frameCount;
        if (index === 0 && ++plays > track.repetitionCount) return;
        frameTimer = window.setTimeout(
          () => void next().catch(() => undefined),
          shown <= SHORTEST_FRAME_MS ? STAND_IN_FRAME_MS : shown,
        );
      };
      await next();
    } catch {
      if (mine === run) draw(img, img.naturalWidth, img.naturalHeight);
    }
  }

  function stop(): void {
    run++;
    active = false;
    stillShown = false;
    if (frameRequest !== undefined) video?.cancelVideoFrameCallback(frameRequest);
    frameRequest = undefined;
    window.clearTimeout(frameTimer);
    decoder?.close();
    decoder = undefined;
    element.hidden = true;
  }

  // A browser without per-frame callbacks shows the clip as it is.
  function apply(): void {
    stop();
    const { lut: name, on } = choice.get();
    if (disposed || !on || name === null) return;
    if (video && !("requestVideoFrameCallback" in video)) return;
    if (!prepare(name)) return;
    active = true;
    if (video) {
      watchFrames(video);
      drawVideo(video);
    } else if (media instanceof HTMLImageElement) showStill(media);
  }

  const onLoad = () => {
    if (active && !stillShown && media instanceof HTMLImageElement) showStill(media);
  };
  if (!video) media.addEventListener("load", onLoad);

  // A context lost to a GPU reset leaves the clip's own picture until it
  // comes back. Without the default prevented, it never comes back.
  const onLost = (event: Event) => {
    event.preventDefault();
    pipeline = null;
    stop();
  };
  element.addEventListener("webglcontextlost", onLost);
  element.addEventListener("webglcontextrestored", apply);
  const unsubscribe = choice.subscribe(apply);

  return {
    element,
    dispose() {
      disposed = true;
      unsubscribe();
      stop();
      media.removeEventListener("load", onLoad);
      element.removeEventListener("webglcontextlost", onLost);
      element.removeEventListener("webglcontextrestored", apply);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
