// The LUT a video player shows its picture through, as a viewer's monitor
// LUT does: the GPU looks each pixel of each frame up in a color cube, and a
// canvas over the picture shows the result. The file is never touched; the
// clip's own element still decodes it and plays its sound underneath.

/** The LUTs Pragma ships, by the name a stored choice keeps. */
export type LutName = "panchromatic" | "orthochromatic";

/** The look a player shows its picture through: the LUT last picked, none
 * before the first pick, kept while the look is off so it can come back. */
export interface Look {
  lut: LutName | null;
  on: boolean;
}

export const NO_LOOK: Look = { lut: null, on: false };

/** The look every player shows its picture through: changed in one, it changes in all. */
export interface LutChoice {
  get(): Look;
  set(look: Look): void;
  subscribe(listener: (look: Look) => void): () => void;
}

/** A look read back from storage, where anything unknown reads as none. */
export function readLook(stored: string | null): Look {
  let value: unknown;
  try {
    value = stored ? JSON.parse(stored) : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== "object" || value === null) return NO_LOOK;
  const { lut, on } = value as Record<string, unknown>;
  if (typeof lut !== "string" || !Object.hasOwn(LUTS, lut)) return NO_LOOK;
  return { lut: lut as LutName, on: on === true };
}

/** Turns the look off, or back on, keeping its LUT. Before the first pick
 * there is nothing to turn on. */
export function toggleLook(choice: LutChoice): void {
  const look = choice.get();
  if (look.lut !== null) choice.set({ ...look, on: !look.on });
}

/** The looks the Looks menu lists, in its order, each by the name it shows. */
export const LOOKS: readonly { lut: LutName; label: string }[] = [
  { lut: "panchromatic", label: "Panchromatic" },
  { lut: "orthochromatic", label: "Orthochromatic" },
];

/** A look's name, as the Looks menu lists it. */
export function lookLabel(lut: LutName): string {
  return LOOKS.find((look) => look.lut === lut)?.label ?? lut;
}

/** A 3D LUT: `size` points along each axis and an RGB triple for each, red
 * changing fastest, then green, then blue, as a `.cube` file lists them. */
export interface Lut {
  size: number;
  table: Float32Array;
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
  return { size, table };
}

const LUTS: Record<LutName, () => Lut> = {
  panchromatic: () => grayLut(PANCHROMATIC_MIX),
  orthochromatic: () => grayLut(ORTHOCHROMATIC_MIX),
};

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
// land 0 and 1 on them rather than on the edges.
const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
uniform sampler2D frame;
uniform sampler3D cube;
uniform float scale;
uniform float offset;
in vec2 at;
out vec4 color;
void main() {
  vec3 source = texture(frame, at).rgb;
  color = vec4(texture(cube, source * scale + offset).rgb, 1.0);
}`;

interface Pipeline {
  frameTexture: WebGLTexture;
  cubeTexture: WebGLTexture;
  scale: WebGLUniformLocation | null;
  offset: WebGLUniformLocation | null;
  // The LUT the cube texture holds.
  loaded: LutName | null;
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
    loaded: null,
  };
}

function loadCube(gl: WebGL2RenderingContext, pipeline: Pipeline, name: LutName): void {
  const { size, table } = LUTS[name]();
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_3D, pipeline.cubeTexture);
  gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, table);
  gl.uniform1f(pipeline.scale, (size - 1) / size);
  gl.uniform1f(pipeline.offset, 0.5 / size);
  pipeline.loaded = name;
}

export interface LutLayer {
  /** Goes in the player's box, under the guides. */
  readonly element: HTMLCanvasElement;
  dispose(): void;
}

export function createLutLayer(video: HTMLVideoElement, choice: LutChoice): LutLayer {
  const element = document.createElement("canvas");
  element.className = "video-lut";
  element.setAttribute("aria-hidden", "true");
  // Opaque, the canvas shows black until its first frame is drawn, so it
  // stays hidden until then and the clip's own picture shows.
  element.hidden = true;
  // A page keeps only so many GPU contexts and drops its oldest past that,
  // so a player asks for one only once a LUT is on.
  let gl: WebGL2RenderingContext | null = null;
  let pipeline: Pipeline | null = null;
  let frameRequest: number | undefined;
  let disposed = false;

  function prepare(name: LutName): boolean {
    gl ??= element.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl || gl.isContextLost()) return false;
    pipeline ??= buildPipeline(gl);
    if (!pipeline) return false;
    if (pipeline.loaded !== name) loadCube(gl, pipeline, name);
    return true;
  }

  function draw(): void {
    const { videoWidth: width, videoHeight: height } = video;
    if (!gl || !pipeline || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !width || !height) return;
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pipeline.frameTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
    } catch {
      // A clip from another origin can't be read: its own picture shows.
      return;
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    element.hidden = false;
  }

  function watchFrames(): void {
    frameRequest = video.requestVideoFrameCallback(() => {
      watchFrames();
      draw();
    });
  }

  function stop(): void {
    if (frameRequest !== undefined) video.cancelVideoFrameCallback(frameRequest);
    frameRequest = undefined;
    element.hidden = true;
  }

  // A browser without per-frame callbacks shows the clip as it is.
  function apply(): void {
    stop();
    const { lut: name, on } = choice.get();
    if (disposed || !on || name === null || !("requestVideoFrameCallback" in video) || !prepare(name)) return;
    watchFrames();
    draw();
  }

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
      element.removeEventListener("webglcontextlost", onLost);
      element.removeEventListener("webglcontextrestored", apply);
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
