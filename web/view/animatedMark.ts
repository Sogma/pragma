// Settings' logo, alive: the mark's segments come apart into circles that drift
// within their own half, join as they near each other, and blend color the
// closer they get; a beat after two blobs join, their neck glows white. It
// draws over the official logo's <img> (mark.svg), which stays up wherever
// this can't run: no WebGL2, or reduced motion.
import { hexToOklab } from "../lib/color.ts";
import { type Disposable, DisposableStore } from "../lib/disposable.ts";
import { LOGO_COLORS } from "../lib/logoColors.ts";

// Clockwise from 12 o'clock, as mark.svg's segments sit around the mark.
// Segments 0–3 are the right half, 4–7 the left.
const SEGMENT_COLORS = [
  LOGO_COLORS.green,
  LOGO_COLORS.teal,
  LOGO_COLORS.cyan,
  LOGO_COLORS.blue,
  LOGO_COLORS.yellow,
  LOGO_COLORS.orange,
  LOGO_COLORS.red,
  LOGO_COLORS.crimson,
];

// Circles [x, y, r] in mark.svg's 919-unit box, fitted to each segment's
// path so that their smooth union at rest reads as the logo. Nothing links
// them to the paths: a change to the logo needs a refit here.
const SEGMENT_CIRCLES = [
  [
    [710, 207, 81],
    [561, 106, 81],
    [566, 195, 73],
    [538, 328, 65],
    [517, 259, 29],
  ],
  [
    [813, 373, 80],
    [639, 485, 77],
    [707, 398, 72],
  ],
  [[818, 557, 78]],
  [
    [608, 692, 105],
    [727, 725, 78],
    [558, 822, 77],
    [529, 637, 50],
  ],
  [
    [354, 818, 81],
    [381, 610, 73],
    [385, 736, 34],
    [383, 684, 37],
  ],
  [
    [175, 571, 106],
    [259, 467, 86],
    [194, 721, 82],
    [74, 564, 56],
    [90, 504, 25],
  ],
  [[94, 377, 71]],
  [
    [278, 229, 98],
    [351, 105, 86],
    [364, 295, 70],
    [172, 206, 68],
  ],
];

const BOX = 919;
const MID = BOX / 2;
/** Half the channel kept clear down the middle: the halves never touch. */
const MIDLINE_GAP = 12;
const BOUND = 459;
/** Animation seconds per real second. */
const SPEED = 3.5;
/** How far a circle's color reaches into a neighbor, in box units. */
const BLEND_REACH = 45;
const EASE_IN = 1.5;

const CIRCLES = SEGMENT_CIRCLES.flatMap((circles, segment) =>
  circles.map(([x, y, r]) => ({ x, y, r, segment, right: segment < 4 })),
);

// A fixed seed, so every launch draws the same paths: these are the ones the
// design was signed off on, and a new seed is a different (if equally random)
// motion. Lehmer's generator stays exact in doubles.
let seed = 288421769;
const random = (): number => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const between = (low: number, high: number): number => low + (high - low) * random();
const TAU = Math.PI * 2;
const MOTION = CIRCLES.map(() => ({
  ax: between(35, 70),
  ay: between(35, 70),
  wx: between(0.3, 0.7),
  wx2: between(0.3, 0.7),
  wy: between(0.3, 0.7),
  wy2: between(0.3, 0.7),
  px: random() * TAU,
  px2: random() * TAU,
  py: random() * TAU,
  py2: random() * TAU,
  br: between(0.06, 0.12),
  bw: between(0.4, 0.9),
  bp: random() * TAU,
}));
/** Phase into the paths at which the motion starts. */
const PHASE = 53;

const smoothstep = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

// Eases x to a stop short of `floor` instead of clamping it there: a clamped
// circle sits pinned against the wall and the wall cuts it flat.
const soften = (x: number, floor: number, reach = 20): number =>
  x >= floor + reach ? x : floor + reach * Math.exp((x - floor - reach) / reach);

export interface MarkFrame {
  /** Per circle: x, y, r in box units, then its half (0 right, 1 left). */
  circles: Float32Array;
  /** How close two circles' edges come before they join, in box units. */
  join: number;
}

/** The mark at `t` animation seconds; at 0 it is the logo's rest pose. */
export function markFrame(t: number): MarkFrame {
  const ease = smoothstep(t / EASE_IN);
  const u = t + PHASE;
  const circles = new Float32Array(CIRCLES.length * 4);
  CIRCLES.forEach((c, i) => {
    const q = MOTION[i];
    const dx = ease * q.ax * (0.6 * Math.sin(q.wx * u + q.px) + 0.4 * Math.sin(q.wx2 * u + q.px2)) + c.x - MID;
    const dy = ease * q.ay * (0.6 * Math.sin(q.wy * u + q.py) + 0.4 * Math.sin(q.wy2 * u + q.py2)) + c.y - MID;
    const r = c.r * (1 + ease * q.br * Math.sin(q.bw * u + q.bp));
    const d = Math.hypot(dx, dy) || 1;
    const kept = -soften(-d, -(BOUND - r)) / d;
    // The edge pull aims at the centre, so run after the midline hold it would
    // drag circles back across. Run before, the hold can push one past the
    // edge, so the edge is held again on y alone: circles near the midline sit
    // at the mark's top or bottom.
    const x = MID + dx * kept;
    const held = c.right ? soften(x, MID + MIDLINE_GAP + 0.9 * r) : -soften(-x, -(MID - MIDLINE_GAP - 0.9 * r));
    const room = Math.sqrt(Math.max(0, (BOUND - r) ** 2 - (held - MID) ** 2));
    const y = Math.sign(dy) * -soften(-Math.abs(dy * kept), -room);
    circles.set([held, MID + y, r, c.right ? 0 : 1], i * 4);
  });
  // The join starts at the reach the circles were fitted with, so the rest
  // pose keeps the logo's gaps, then doubles so moving circles stretch longer.
  return { circles, join: 30 + ease * 30 };
}

/** Two blobs of one half that met: circles `a` and `b`, whose gap closed, and a
 * bit for each circle of the blob they now make. The shader reads the bits as
 * an int, so the mark must stay under 32 circles. */
export interface Join {
  a: number;
  b: number;
  blob: number;
}

/** How far past the join reach a closed gap must widen before the pair counts
 * as parted, so a pair hovering at the reach joins once. */
const PART_MARGIN = 3;

// Two circles bridge once their gap is under half the join reach: that is where
// the shader's smooth union first closes between them. A join is a bridge
// between blobs that were apart the frame before; one inside a blob only
// closes a loop. The first frame sets the baseline and reports nothing.
export function createJoinWatch(): (frame: MarkFrame) => Join[] {
  let bridged: Uint8Array | undefined;
  let blobs = new Int32Array(0);
  return ({ circles, join }) => {
    const count = circles.length / 4;
    const reach = join / 2;
    const now = new Uint8Array(count * count);
    const root = Array.from({ length: count }, (_, i) => i);
    const find = (i: number): number => {
      let at = i;
      while (root[at] !== at) at = root[at];
      return at;
    };
    const closed: [number, number][] = [];
    for (let a = 0; a < count; a++) {
      for (let b = a + 1; b < count; b++) {
        if (circles[a * 4 + 3] !== circles[b * 4 + 3]) continue;
        const centres = Math.hypot(circles[a * 4] - circles[b * 4], circles[a * 4 + 1] - circles[b * 4 + 1]);
        const gap = centres - circles[a * 4 + 2] - circles[b * 4 + 2];
        const was = bridged?.[a * count + b] === 1;
        if (gap >= (was ? reach + PART_MARGIN : reach)) continue;
        now[a * count + b] = 1;
        root[find(a)] = find(b);
        if (!was) closed.push([a, b]);
      }
    }
    const next = new Int32Array(count);
    for (let i = 0; i < count; i++) next[i] = find(i);
    const joins: Join[] = [];
    if (bridged) {
      const met = new Set<number>();
      for (const [a, b] of closed) {
        if (blobs[a] === blobs[b]) continue;
        const pair = Math.min(blobs[a], blobs[b]) * count + Math.max(blobs[a], blobs[b]);
        if (met.has(pair)) continue;
        met.add(pair);
        let blob = 0;
        for (let i = 0; i < count; i++) if (next[i] === next[a]) blob |= 1 << i;
        joins.push({ a, b, blob });
      }
    }
    bridged = now;
    blobs = next;
    return joins;
  };
}

// A glow waits a beat after its join, rises, then fades, and a join within the
// spacing of the last glowing one stays dark. The times are real milliseconds,
// not animation time, so a change of speed keeps them.
const GLOW_DELAY = 100;
const GLOW_RISE = 50;
const GLOW_FADE = 1100;
const GLOW_SPACING = 450;
/** Light at a glow's centre at its peak: 1 - e^-3, 95% of the way to white. */
const GLOW_PEAK = 3;
/** Where a glow falls to a tenth of its peak, in box units: 7% of the mark. */
const GLOW_RADIUS = 0.07 * BOX;
/** The most glows the shader lights at once, newest first. */
const GLOW_SLOTS = 8;

/** A glow's light `ms` after its join. */
function glowLight(ms: number): number {
  const lit = ms - GLOW_DELAY;
  if (lit < 0) return 0;
  if (lit < GLOW_RISE) return GLOW_PEAK * (1 - (1 - lit / GLOW_RISE) ** 2);
  return GLOW_PEAK * (1 - Math.min(1, (lit - GLOW_RISE) / GLOW_FADE)) ** 3;
}

// The neck sits halfway across the closing gap, or halfway into the overlap
// once the circles cross, and moves with them.
function neck(circles: Float32Array, a: number, b: number): [number, number] {
  const ax = circles[a * 4];
  const ay = circles[a * 4 + 1];
  const ar = circles[a * 4 + 2];
  const dx = circles[b * 4] - ax;
  const dy = circles[b * 4 + 1] - ay;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, Math.max(0, (ar + (d - ar - circles[b * 4 + 2]) / 2) / d));
  return [ax + dx * k, ay + dy * k];
}

export interface GlowFrame {
  /** Per glow slot: x, y in box units, then its light (0 is dark). */
  lights: Float32Array;
  /** Per glow slot: the bits of the blob its light stays inside. */
  blobs: Int32Array;
}

/** Glows each join's neck as the mark plays: call it with every frame drawn and
 * that frame's `t`. A join while the mark eases in, as it opens, stays dark. */
export function createNeckGlows(): (frame: MarkFrame, t: number) => GlowFrame {
  const watch = createJoinWatch();
  const live: { join: Join; born: number }[] = [];
  const life = GLOW_DELAY + GLOW_RISE + GLOW_FADE;
  let lastBorn = Number.NEGATIVE_INFINITY;
  return (frame, t) => {
    const since = (born: number): number => ((t - born) / SPEED) * 1000;
    for (const join of watch(frame)) {
      if (t < EASE_IN || since(lastBorn) < GLOW_SPACING) continue;
      live.push({ join, born: t });
      lastBorn = t;
    }
    while (live.length > 0 && since(live[0].born) > life) live.shift();
    const lights = new Float32Array(GLOW_SLOTS * 3);
    const blobs = new Int32Array(GLOW_SLOTS);
    let slot = 0;
    for (let n = live.length - 1; n >= 0 && slot < GLOW_SLOTS; n--) {
      const { join, born } = live[n];
      const light = glowLight(since(born));
      if (light <= 0) continue;
      lights.set([...neck(frame.circles, join.a, join.b), light], slot * 3);
      blobs[slot] = join.blob;
      slot++;
    }
    return { lights, blobs };
  };
}

// Each half is a smooth union of its circles. A pixel's color is every circle's
// color weighted by exp(-distance / reach), averaged in OKLab, so color spreads
// further into a neighbor the closer the two come.
//
// A glow mixes white into the shape around a neck and never outside it, so the
// canvas needs no margin past the mark. It lights only the blob that joined:
// the circle nearest the pixel must be one of that blob's.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uCircle[${CIRCLES.length}];
uniform vec3 uLab[${CIRCLES.length}];
uniform float uJoin;
uniform vec2 uRes;
uniform vec3 uGlow[${GLOW_SLOTS}];
uniform int uGlowBlob[${GLOW_SLOTS}];
out vec4 o;
const float MID = ${MID.toFixed(1)}, GAP = ${MIDLINE_GAP.toFixed(1)}, REACH = ${BLEND_REACH.toFixed(1)};
const float GLOW_SIGMA = ${(GLOW_RADIUS / Math.sqrt(2 * Math.LN10)).toFixed(2)};
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
vec3 labToSrgb(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  vec3 rgb = clamp(vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), 0.0, 1.0);
  return mix(rgb * 12.92, 1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
}
void main() {
  float px = ${BOX.toFixed(1)} / uRes.x;
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) * px;
  float best = 1e5; vec3 bestLab = vec3(0.0); int bestNear = 0;
  for (int side = 0; side < 2; side++) {
    float d = 1e5, wsum = 0.0, nearD = 1e5; vec3 lab = vec3(0.0); int near = 0;
    for (int i = 0; i < ${CIRCLES.length}; i++) {
      vec4 c = uCircle[i];
      if (int(c.w + 0.5) != side) continue;
      float di = length(p - c.xy) - c.z;
      if (di < nearD) { nearD = di; near = i; }
      float h = clamp(0.5 + 0.5 * (di - d) / uJoin, 0.0, 1.0);
      d = mix(di, d, h) - uJoin * h * (1.0 - h);
      float w = exp(clamp(-di / REACH, -40.0, 40.0));
      wsum += w;
      lab += uLab[i] * w;
    }
    float wall = side == 0 ? (MID + GAP) - p.x : p.x - (MID - GAP);
    d = smax(d, wall, 16.0);
    if (d < best) { best = d; bestLab = lab / max(wsum, 1e-30); bestNear = near; }
  }
  float a = clamp(0.5 - best / px, 0.0, 1.0);
  float lit = 0.0;
  for (int k = 0; k < ${GLOW_SLOTS}; k++) {
    vec3 g = uGlow[k];
    if (g.z <= 0.0 || ((uGlowBlob[k] >> bestNear) & 1) == 0) continue;
    vec2 q = p - g.xy;
    lit += g.z * exp(-0.5 * dot(q, q) / (GLOW_SIGMA * GLOW_SIGMA));
  }
  o = vec4(mix(labToSrgb(bestLab), vec3(1.0), 1.0 - exp(-lit)) * a, a);
}`;

interface Renderer {
  draw(frame: MarkFrame, glows: GlowFrame): void;
}

function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const program = gl.createProgram();
  const sources: [number, string][] = [
    [
      gl.VERTEX_SHADER,
      "#version 300 es\nlayout(location = 0) in vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }",
    ],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ];
  for (const [type, source] of sources) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.uniform3fv(
    gl.getUniformLocation(program, "uLab"),
    CIRCLES.flatMap((c) => hexToOklab(SEGMENT_COLORS[c.segment])),
  );
  const circles = gl.getUniformLocation(program, "uCircle");
  const join = gl.getUniformLocation(program, "uJoin");
  const res = gl.getUniformLocation(program, "uRes");
  const glow = gl.getUniformLocation(program, "uGlow");
  const glowBlob = gl.getUniformLocation(program, "uGlowBlob");
  return {
    draw(frame, glows) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform4fv(circles, frame.circles);
      gl.uniform1f(join, frame.join);
      gl.uniform2f(res, canvas.width, canvas.height);
      gl.uniform3fv(glow, glows.lights);
      gl.uniform1iv(glowBlob, glows.blobs);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** Plays over `still` while its row is on screen, from the rest pose each time
 * it comes into view; `still` shows whenever it isn't playing. */
export function mountAnimatedMark(still: HTMLImageElement): Disposable {
  const store = new DisposableStore();
  const row = still.parentElement;
  if (!row) return store;
  const canvas = document.createElement("canvas");
  canvas.className = still.className;
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  store.add(() => canvas.remove());

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Built on first view, not at mount: a WebGL context held from startup costs
  // GPU memory for a dialog that may never open. Null once it has failed.
  let renderer: Renderer | null | undefined;
  let glows = createNeckGlows();
  let frameRequest = 0;
  let t = 0;
  let last = 0;
  const draw = (): void => {
    const frame = markFrame(t);
    renderer?.draw(frame, glows(frame, t));
  };
  const tick = (now: number): void => {
    t += (Math.min(100, now - last) / 1000) * SPEED;
    last = now;
    draw();
    frameRequest = requestAnimationFrame(tick);
  };
  const stop = (): void => {
    cancelAnimationFrame(frameRequest);
    canvas.hidden = true;
    still.hidden = false;
  };
  const start = (): void => {
    if (reducedMotion.matches) return;
    if (renderer === undefined) {
      renderer = createRenderer(canvas);
      if (renderer) still.after(canvas);
    }
    if (!renderer) return;
    const scale = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(still.clientWidth * scale);
    canvas.height = Math.round(still.clientHeight * scale);
    still.hidden = true;
    canvas.hidden = false;
    t = 0;
    glows = createNeckGlows();
    last = performance.now();
    draw();
    frameRequest = requestAnimationFrame(tick);
  };

  // Watches the row, not the mark: whichever of the two is hidden lays out to
  // nothing and would never be reported as visible.
  const observer = new IntersectionObserver(([entry]) => {
    stop();
    if (entry?.isIntersecting) start();
  });
  observer.observe(row);
  store.add(() => {
    observer.disconnect();
    stop();
  });
  return store;
}
