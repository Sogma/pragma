// An open entry's graph in 3D, with a third axis given to the physics.
// Nodes are flat discs facing the camera, and far ones sink into fog. Every
// node is one draw and every line another.
//
// pragma's scope marks ride on it: a scope's AGENTS.md is the logo's six dots, its
// folder a ringed disc riding at its upper left, and a scope's outline lights
// round its files while one of them is open or hovered. Springs gather a
// scope's files round its AGENTS.md.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { ShownGraph, ShownNode } from "./graphData.ts";
import { FORCES } from "./graphSettings.ts";
import type { FromWorker, ToWorker } from "./graphSim.worker.ts";
import {
  FOLDER_RING_STOPS,
  type Hues,
  MARK_CENTRE_RADIUS,
  MARK_DOT_RADIUS,
  MARK_DOTS,
  strokeScopeRegion,
} from "./marks.ts";

export interface GraphLook {
  background: number;
  // Label and outline text, as CSS.
  text: string;
  line: number;
  highlight: number;
  noteGrey: number;
  hues: Hues;
  font: string;
  // A node's colour, as the tree paints its kind's icon.
  colorOf(node: ShownNode): { color: number; alpha: number };
}

export type Place = [number, number, number];

export interface SceneDeps {
  // One renderer for the tab's whole life: a WebGL context per scene would
  // run into the browser's cap on them, which drops the oldest.
  renderer: THREE.WebGLRenderer;
  look: GraphLook;
  // Where the scene this one replaces left each node and its camera, so a
  // node in both stays put and the view eases over rather than jumping.
  start?: ReadonlyMap<string, Place>;
  view?: { position: Place; target: Place };
  open(node: ShownNode): void;
  // A right-click's menu, at the click's client point.
  menu(node: ShownNode, at: { x: number; y: number }): void;
}

export interface GraphScene {
  setLook(look: GraphLook): void;
  // The node the open entry is, lit with its links.
  focus(id: string | null): void;
  positions(): Map<string, Place>;
  view(): { position: Place; target: Place };
  pause(): void;
  resume(): void;
  dispose(): void;
}

const FOV = 50;
const HALF_FOV_TAN = Math.tan(((FOV / 2) * Math.PI) / 180);
const MAX_LABELS = 80;
const FADE = 0.2;
const FOG = 0.5;
// How far a scope's outline stands off its files, in screen pixels.
const OUTLINE_PAD = 28;

// A disc per node, sized in world units so it shrinks with distance. A mark
// of 1 draws a scope folder's disc in its ring, four colours clockwise from
// the top and parted at top and bottom; 2 draws a scope's AGENTS.md as the mark's
// six dots round a centre dot in the notes' grey.
const VERTEX = /* glsl */ `
attribute float size;
attribute vec4 rgba;
attribute float mark;
uniform float pixelsPerUnit;
varying vec4 vColor;
varying float vMark;
#include <fog_pars_vertex>
void main() {
  vColor = rgba;
  vMark = mark;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * pixelsPerUnit / -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const FRAGMENT = /* glsl */ `
uniform vec3 ringColors[4];
uniform vec2 ringStops[4];
uniform vec3 dotColors[6];
uniform vec2 dotCentres[6];
uniform float dotRadius;
uniform vec3 centreColor;
uniform float centreRadius;
varying vec4 vColor;
varying float vMark;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  float aa = fwidth(p.x) * 1.2;
  vec3 rgb = vColor.rgb;
  float cover = 0.0;
  if (vMark < 0.5) {
    cover = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  } else if (vMark < 1.5) {
    float disc = 1.0 - smoothstep(0.57 - aa, 0.57, d);
    float band = smoothstep(0.74 - aa, 0.74, d) * (1.0 - smoothstep(0.98 - aa, 0.98, d));
    float angle = degrees(atan(p.x, -p.y));
    if (angle < 0.0) angle += 360.0;
    float inRing = 0.0;
    vec3 ringRgb = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      if (angle >= ringStops[i].x && angle < ringStops[i].y) {
        inRing = 1.0;
        ringRgb = ringColors[i];
      }
    }
    band *= inRing;
    cover = max(disc, band);
    if (band > disc) rgb = ringRgb;
  } else {
    cover = 1.0 - smoothstep(centreRadius - aa, centreRadius, d);
    rgb = centreColor;
    for (int i = 0; i < 6; i++) {
      float a = 1.0 - smoothstep(dotRadius - aa, dotRadius, length(p - dotCentres[i]));
      if (a > cover) {
        cover = a;
        rgb = dotColors[i];
      }
    }
  }
  float alpha = vColor.a * cover;
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(rgb, alpha);
  #include <fog_fragment>
}`;

// Colours go to the GPU as written, never converted, so a token's hex lands
// on screen as it reads.
const plain = (hex: number) => new THREE.Color().setHex(hex, THREE.LinearSRGBColorSpace);
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
// Every change eases 10% of the way a frame.
const ease = (from: number, to: number, keep = 0.9) => {
  const next = from * keep + to * (1 - keep);
  return Math.abs(next - to) < 0.002 ? to : next;
};
// A node is 3√(links + 1) wide, never under 8 or over 30.
const nodeSizeFor = (links: number) => Math.max(8, Math.min(3 * Math.sqrt(links + 1), 30));

export function createGraphRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  renderer.domElement.className = "graph-canvas";
  return renderer;
}

export function createGraphScene(host: HTMLElement, graph: ShownGraph, deps: SceneDeps): GraphScene {
  const { renderer } = deps;
  let look = deps.look;
  const nodes = graph.nodes;
  const n = nodes.length;
  const index = new Map(nodes.map((node, at) => [node.id, at]));

  // One line per linked pair, so a two-way link draws once.
  const pairs = new Set<string>();
  const endList: number[] = [];
  for (const link of graph.links) {
    const a = link.source;
    const b = link.target;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || pairs.has(key)) continue;
    pairs.add(key);
    endList.push(a, b);
  }
  const ends = Int32Array.from(endList);
  const m = ends.length / 2;
  const around: number[][] = Array.from({ length: n }, () => []);
  const lineOf = new Map<string, number>();
  for (let j = 0; j < m; j++) {
    const a = ends[2 * j];
    const b = ends[2 * j + 1];
    around[a].push(b);
    around[b].push(a);
    lineOf.set(a < b ? `${a}:${b}` : `${b}:${a}`, j);
  }

  // The shader's glyph is the other way round from a node's mark: an AGENTS.md
  // (1) in six dots, its folder (2) in the ring. How far a node reaches from
  // its centre: a ring keeps its disc's size inside it, and the dots spread
  // as wide as a ring.
  const size = Float32Array.from(around, (list) => nodeSizeFor(list.length));
  const mark = Uint8Array.from(nodes, (node) => node.mark);
  const glyph = Float32Array.from(mark, (each) => (each === 1 ? 2 : each === 2 ? 1 : 0));
  const reach = Float32Array.from(nodes, (_, at) => size[at] * (glyph[at] === 1 ? 1.75 : glyph[at] === 2 ? 1.7 : 1));

  // A scope folder rides beside its AGENTS.md rather than joining the physics,
  // up and to the left of it from wherever the camera looks, so the pair
  // reads as one. The worker lays out the rest.
  const anchorOf = new Int32Array(n).fill(-1);
  nodes.forEach((node, at) => {
    if (mark[at] === 2) {
      anchorOf[at] = nodes.findIndex((other, k) => mark[k] === 1 && other.scope?.id === node.scope?.id);
    }
  });
  const riders = nodes.flatMap((_, at) => (anchorOf[at] !== -1 ? [at] : []));
  const simNodes = nodes.flatMap((_, at) => (anchorOf[at] === -1 ? [at] : []));
  const simIndex = new Int32Array(n).fill(-1);
  simNodes.forEach((at, k) => {
    simIndex[at] = k;
  });

  const positions = new Float32Array(n * 3).fill(Number.NaN);
  let known = 0;
  nodes.forEach((node, at) => {
    const start = deps.start?.get(node.id);
    if (!start) return;
    positions.set(start, at * 3);
    known++;
  });
  const fade = new Float32Array(n);
  const lineFade = new Float32Array(m);

  const canvas = renderer.domElement;
  if (!host.contains(canvas)) host.prepend(canvas);
  const scene = new THREE.Scene();
  const fog = new THREE.Fog(plain(look.background), 1e9, 2e9);
  scene.fog = fog;
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 1e7);
  camera.position.set(...(deps.view?.position ?? [0, 0, 1600]));

  const nodeGeometry = new THREE.BufferGeometry();
  const nodePosition = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
  const nodeSize = new THREE.BufferAttribute(new Float32Array(n), 1);
  const nodeColor = new THREE.BufferAttribute(new Float32Array(n * 4), 4);
  nodeGeometry.setAttribute("position", nodePosition);
  nodeGeometry.setAttribute("size", nodeSize);
  nodeGeometry.setAttribute("rgba", nodeColor);
  nodeGeometry.setAttribute("mark", new THREE.BufferAttribute(glyph, 1));
  const nodeMaterial = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        pixelsPerUnit: { value: 1 },
        ringColors: { value: FOLDER_RING_STOPS.map(([, , hue]) => plain(look.hues[hue])) },
        ringStops: { value: FOLDER_RING_STOPS.map(([from, to]) => new THREE.Vector2(from, to)) },
        dotColors: { value: MARK_DOTS.map(([, , hex]) => plain(hex)) },
        dotCentres: { value: MARK_DOTS.map(([x, y]) => new THREE.Vector2((x - 12) / 12, (y - 12) / 12)) },
        dotRadius: { value: MARK_DOT_RADIUS / 12 },
        centreColor: { value: plain(look.noteGrey) },
        centreRadius: { value: MARK_CENTRE_RADIUS / 12 },
      },
    ]),
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    fog: true,
  });
  const points = new THREE.Points(nodeGeometry, nodeMaterial);
  points.frustumCulled = false;

  const lineGeometry = new THREE.BufferGeometry();
  const linePosition = new THREE.BufferAttribute(new Float32Array(m * 6), 3);
  const lineRgba = new THREE.BufferAttribute(new Float32Array(m * 8), 4);
  lineGeometry.setAttribute("position", linePosition);
  lineGeometry.setAttribute("color", lineRgba);
  const lineMaterial = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: true,
  });
  const lines = new THREE.LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  scene.add(lines, points);

  const regionLayer = document.createElement("canvas");
  regionLayer.className = "graph-outline";
  canvas.after(regionLayer);
  const regionCtx = regionLayer.getContext("2d");
  const overlay = document.createElement("div");
  overlay.className = "graph-labels";
  host.append(overlay);

  let baseColor = nodes.map((node) => look.colorOf(node));
  let highlight = plain(look.highlight);
  let lineColor = plain(look.line);
  const applyLook = () => {
    renderer.setClearColor(plain(look.background), 1);
    fog.color = plain(look.background);
    baseColor = nodes.map((node) => look.colorOf(node));
    highlight = plain(look.highlight);
    lineColor = plain(look.line);
    nodeMaterial.uniforms.ringColors.value = FOLDER_RING_STOPS.map(([, , hue]) => plain(look.hues[hue]));
    nodeMaterial.uniforms.centreColor.value = plain(look.noteGrey);
  };
  applyLook();

  // Each scope's members, a scope's tree counting its nested scopes, for the
  // scopes whose AGENTS.md is in the graph.
  const scopeIds = [...new Set(nodes.flatMap((node, at) => (mark[at] === 1 && node.scope ? [node.scope.id] : [])))];
  const within = (scope: string, id: string) => scope === id || scope.startsWith(`${id}/`);
  const members = new Map(
    scopeIds.map((id) => [
      id,
      nodes.flatMap((node, at) => (node.scope && !node.scope.library && within(node.scope.id, id) ? [at] : [])),
    ]),
  );
  const scopeName = new Map(scopeIds.map((id) => [id, nodes.find((node) => node.scope?.id === id)?.scope?.name ?? id]));
  const innermost = (ids: string[]) => ids.sort((a, b) => b.length - a.length)[0] ?? null;
  const parentScope = new Map(
    scopeIds.map((id) => [id, innermost(scopeIds.filter((other) => id.startsWith(`${other}/`)))]),
  );
  // Each node's scope: the innermost one holding it whose AGENTS.md is in the
  // graph. None for a tag, a library's file or a file of the space's root.
  const scopeOf = nodes.map((node) => {
    const own = node.scope;
    return !own || own.library ? null : innermost(scopeIds.filter((id) => within(own.id, id)));
  });
  // A scope's AGENTS.md, then the folder riding beside it.
  const hubOf = new Map<string, number[]>();
  nodes.forEach((node, at) => {
    if (mark[at] === 1 && node.scope) {
      hubOf.set(node.scope.id, [at, ...riders.filter((rider) => anchorOf[rider] === at)]);
    }
  });

  let shownScope: string | null = null;
  let regionAlpha = 0;
  // A hovered node's scope shows for a while after the pointer leaves it,
  // so its counts can be reached.
  let hoverScope: string | null = null;
  let hoverLeftAt = 0;

  // Links across the shown outline, and where the last frame drew their
  // counts, for the pointer. A tag belongs to no scope and a folder's links
  // only file what it holds, so neither counts.
  interface Crossing {
    inside: number;
    outside: number;
    out: boolean;
    line: number;
  }
  let crossings: Crossing[] = [];
  let crossingsOf: string | null = null;
  let countBoxes: { left: number; right: number; top: number; bottom: number; out: boolean }[] = [];
  let crossLight: { key: string; nodes: Set<number>; lines: Set<number> } | null = null;
  const crossingsFor = (id: string): Crossing[] => {
    const inside = new Set(members.get(id) ?? []);
    const found: Crossing[] = [];
    const seen = new Set<string>();
    for (const link of graph.links) {
      if (link.kind === "tag" || link.kind === "contains") continue;
      const a = link.source;
      const b = link.target;
      if (inside.has(a) === inside.has(b) || seen.has(`${a}>${b}`)) continue;
      seen.add(`${a}>${b}`);
      const line = lineOf.get(a < b ? `${a}:${b}` : `${b}:${a}`);
      if (line === undefined) continue;
      found.push({ inside: inside.has(a) ? a : b, outside: inside.has(a) ? b : a, out: inside.has(a), line });
    }
    return found;
  };
  const crossingAt = (px: number, py: number) => {
    if (shownScope === null || regionAlpha < 0.5) return null;
    const box = countBoxes.find((b) => px >= b.left && px <= b.right && py >= b.top && py <= b.bottom);
    const chosen = box ? crossings.filter((c) => c.out === box.out) : [];
    if (!box || chosen.length === 0) return null;
    return {
      key: `${shownScope} ${box.out ? "out" : "in"}`,
      nodes: new Set(chosen.flatMap((c) => [c.inside, c.outside])),
      lines: new Set(chosen.map((c) => c.line)),
    };
  };

  const labelPool: HTMLDivElement[] = [];
  // Where the last frame's readable labels sit, so the counts keep off them.
  let labelBoxes: { left: number; right: number; top: number; bottom: number }[] = [];
  // A label's width as the page sets it, measured in its own face.
  const textWidth = (text: string, size: number, bold: boolean) => {
    if (!regionCtx) return text.length * size * 0.6;
    regionCtx.font = `${bold ? 600 : 400} ${size}px ${look.font}`;
    return regionCtx.measureText(text).width;
  };
  let hovered = -1;
  let focused = -1;
  let dragged = -1;
  let lit: Set<number> | null = null;
  let hub: number[] = [];
  let lastLight = "";
  let pressed = false;
  let moved = false;
  let pressX = 0;
  let pressY = 0;
  let fitting = true;
  let settledFrames = 0;
  let radius = 500;
  let positionsDirty = true;
  let colorsDirty = true;
  let workerRunning = true;
  let idle = 0;
  let frameCount = 0;
  let raf = 0;
  let paused = false;
  let disposed = false;
  let cssHeight = 1;

  // Each node's place on screen as of the last drawn frame, for picking.
  const screenX = new Float32Array(n);
  const screenY = new Float32Array(n);
  const screenR = new Float32Array(n);
  const depth = new Float32Array(n).fill(Number.POSITIVE_INFINITY);

  const worker = new Worker(new URL("./graphSim.worker.ts", import.meta.url), { type: "module" });
  const send = (message: ToWorker) => worker.postMessage(message);
  worker.onmessage = (event: MessageEvent<FromWorker>) => {
    const placed = event.data.positions;
    simNodes.forEach((at, k) => {
      positions[at * 3] = placed[k * 3];
      positions[at * 3 + 1] = placed[k * 3 + 1];
      positions[at * 3 + 2] = placed[k * 3 + 2];
    });
    workerRunning = event.data.running;
    positionsDirty = true;
    wake();
  };
  const simLinks: number[] = [];
  for (let j = 0; j < m; j++) {
    const a = simIndex[ends[2 * j]];
    const b = simIndex[ends[2 * j + 1]];
    if (a !== -1 && b !== -1) simLinks.push(a, b);
  }
  // Springs gather each file round its scope's AGENTS.md, and a nested AGENTS.md
  // round its parent's, so a scope's files sit together and a nested scope
  // inside its parent.
  const springs: number[] = [];
  nodes.forEach((_, at) => {
    const scope = scopeOf[at];
    const hubScope = scope === null ? null : mark[at] === 1 ? (parentScope.get(scope) ?? null) : scope;
    const readme = hubScope === null ? undefined : hubOf.get(hubScope)?.[0];
    if (readme !== undefined && readme !== at && simIndex[at] !== -1) springs.push(simIndex[at], simIndex[readme]);
  });
  const simStart = new Float32Array(simNodes.length * 3);
  simNodes.forEach((at, k) => {
    simStart.set(positions.subarray(at * 3, at * 3 + 3), k * 3);
  });
  send({
    type: "init",
    positions: simStart,
    links: Int32Array.from(simLinks),
    springs: Int32Array.from(springs),
    forces: FORCES,
    alpha: known < simNodes.length / 2 ? 1 : 0.3,
  });

  const placeRiders = () => {
    const e = camera.matrixWorld.elements;
    for (const at of riders) {
      const anchor = anchorOf[at];
      if (Number.isNaN(positions[anchor * 3])) continue;
      const away = (reach[anchor] + reach[at]) * 0.75;
      for (let axis = 0; axis < 3; axis++) {
        positions[at * 3 + axis] = positions[anchor * 3 + axis] + (e[4 + axis] - e[axis]) * away;
      }
    }
  };

  const centreNode = () => (hovered !== -1 ? hovered : dragged !== -1 ? dragged : focused);
  const wake = () => {
    idle = 0;
    if (!raf && !disposed && !paused) raf = requestAnimationFrame(frame);
  };

  // The nearest disc under the pointer, the one in front winning.
  const pick = (px: number, py: number): number => {
    let best = -1;
    let bestDepth = Number.POSITIVE_INFINITY;
    for (let at = 0; at < n; at++) {
      if (depth[at] === Number.POSITIVE_INFINITY) continue;
      const dx = screenX[at] - px;
      const dy = screenY[at] - py;
      const r = screenR[at] + 3;
      if (dx * dx + dy * dy <= r * r && depth[at] < bestDepth) {
        best = at;
        bestDepth = depth[at];
      }
    }
    return best;
  };

  const point = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const dragPlane = new THREE.Plane();
  const raycaster = new THREE.Raycaster();
  const hitPoint = new THREE.Vector3();

  // Registered before the orbit controls, so a press on a node drags the
  // node and never reaches them.
  const onDown = (event: PointerEvent) => {
    const p = point(event);
    pressed = true;
    moved = false;
    pressX = p.x;
    pressY = p.y;
    if (event.button !== 0) return;
    const hit = pick(p.x, p.y);
    if (hit === -1) return;
    event.stopImmediatePropagation();
    canvas.setPointerCapture(event.pointerId);
    dragged = hit;
    const at = new THREE.Vector3(positions[hit * 3], positions[hit * 3 + 1], positions[hit * 3 + 2]);
    dragPlane.setFromNormalAndCoplanarPoint(camera.getWorldDirection(new THREE.Vector3()), at);
    wake();
  };
  const onMove = (event: PointerEvent) => {
    const p = point(event);
    if (pressed && Math.hypot(p.x - pressX, p.y - pressY) > 3) moved = true;
    if (dragged !== -1) {
      if (!moved || simIndex[dragged] === -1) return;
      const ndc = new THREE.Vector2((p.x / canvas.clientWidth) * 2 - 1, -(p.y / canvas.clientHeight) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(dragPlane, hitPoint)) return;
      positions.set([hitPoint.x, hitPoint.y, hitPoint.z], dragged * 3);
      positionsDirty = true;
      send({ type: "drag", index: simIndex[dragged], x: hitPoint.x, y: hitPoint.y, z: hitPoint.z });
      wake();
      return;
    }
    if (pressed) return;
    const light = crossingAt(p.x, p.y);
    if ((light?.key ?? null) !== (crossLight?.key ?? null)) {
      crossLight = light;
      wake();
    }
    if (light) {
      canvas.style.cursor = "";
      if (hovered !== -1) {
        hoverLeftAt = performance.now();
        hovered = -1;
      }
      return;
    }
    const hit = pick(p.x, p.y);
    if (hit === hovered) return;
    if (hovered !== -1) hoverLeftAt = performance.now();
    hovered = hit;
    // A file of no scope shows none, rather than the last one's.
    if (hit !== -1) hoverScope = scopeOf[hit];
    canvas.style.cursor = hit === -1 ? "" : "pointer";
    wake();
  };
  // A click opens what the node stands for, as a tree click does; a tag or a
  // missing file opens nothing and has no menu.
  //
  // The menu opens on the right button's release, never on `contextmenu`: a
  // right-drag pans, and macOS and Linux send that event on the press,
  // before a drag can show.
  const opens = (node: ShownNode) => node.kind !== "tag" && node.kind !== "missing";
  const onUp = (event: PointerEvent) => {
    if (dragged !== -1) {
      if (simIndex[dragged] !== -1) send({ type: "release", index: simIndex[dragged] });
      const node = nodes[dragged];
      if (!moved && opens(node)) deps.open(node);
      dragged = -1;
    } else if (pressed && !moved && event.button === 2) {
      const p = point(event);
      const hit = pick(p.x, p.y);
      if (hit !== -1 && opens(nodes[hit])) deps.menu(nodes[hit], { x: event.clientX, y: event.clientY });
    }
    pressed = false;
    wake();
  };
  const onLeave = () => {
    if (hovered === -1 && crossLight === null) return;
    if (hovered !== -1) hoverLeftAt = performance.now();
    hovered = -1;
    crossLight = null;
    wake();
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = true;
  if (deps.view) controls.target.set(...deps.view.target);
  controls.addEventListener("start", () => {
    fitting = false;
    wake();
  });
  controls.addEventListener("change", wake);

  const resize = () => {
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    cssHeight = height;
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    nodeMaterial.uniforms.pixelsPerUnit.value =
      renderer.getDrawingBufferSize(new THREE.Vector2()).y / (2 * HALF_FOV_TAN);
    regionLayer.width = Math.round(width * renderer.getPixelRatio());
    regionLayer.height = Math.round(height * renderer.getPixelRatio());
    wake();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  const bgCss = () => `#${look.background.toString(16).padStart(6, "0")}`;
  const drawRegion = (id: string, alpha: number, width: number, withCounts: boolean) => {
    if (!regionCtx) return;
    const centres: [number, number][] = [];
    for (const at of members.get(id) ?? []) {
      if (depth[at] !== Number.POSITIVE_INFINITY) centres.push([screenX[at], screenY[at]]);
    }
    const view = { width: canvas.clientWidth, height: canvas.clientHeight, margin: 12 };
    const drawn = strokeScopeRegion(regionCtx, centres, look.hues, { pad: OUTLINE_PAD, width, alpha, within: view });
    if (!drawn) return;
    const name = scopeName.get(id) ?? id;
    regionCtx.save();
    regionCtx.globalAlpha = alpha;
    regionCtx.font = `600 12px ${look.font}`;
    regionCtx.textAlign = "center";
    regionCtx.textBaseline = "bottom";
    regionCtx.lineJoin = "round";
    regionCtx.lineWidth = 4;
    regionCtx.strokeStyle = bgCss();
    // The name sits just over the outline's top, or just under it where the
    // outline runs along the view's top edge, so it never lies on the line.
    const over = drawn.top[1] - 6;
    const nameY = over - 12 >= 4 ? over : drawn.top[1] + 18;
    regionCtx.strokeText(name, drawn.top[0], nameY);
    regionCtx.fillStyle = look.text;
    regionCtx.fillText(name, drawn.top[0], nameY);
    regionCtx.restore();
    if (withCounts) drawCounts(drawn.bottom, alpha);
  };

  // How many links cross the outline each way, just under its bottom, or
  // just over it where the outline runs along the view's bottom edge.
  const drawCounts = (bottom: [number, number], alpha: number) => {
    if (!regionCtx) return;
    const ctx = regionCtx;
    ctx.save();
    ctx.globalAlpha = alpha;
    const outward = crossings.filter((c) => c.out).length;
    const inward = crossings.length - outward;
    ctx.font = `600 12px ${look.font}`;
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = bgCss();
    countBoxes = [];
    const parts: [string, boolean | null][] =
      crossings.length === 0
        ? [["no links cross", null]]
        : [
            [`${outward} out`, true],
            [" · ", null],
            [`${inward} in`, false],
          ];
    const widths = parts.map(([text]) => ctx.measureText(text).width);
    const left = bottom[0] - widths.reduce((sum, w) => sum + w, 0) / 2;
    const right = left + widths.reduce((sum, w) => sum + w, 0);
    // The row never lies on a label: under the outline and past any label
    // there, or, where that runs off the view, inside it and above them.
    const row = 16;
    const hit = (top: number) =>
      labelBoxes.find((box) => box.left < right && box.right > left && box.top < top + row && box.bottom > top);
    let y = bottom[1] + 8;
    for (let box = hit(y); box; box = hit(y)) y = box.bottom + 2;
    if (y + row > canvas.clientHeight - 4) {
      y = bottom[1] - 22;
      for (let box = hit(y); box; box = hit(y)) y = box.top - row - 2;
    }
    let x = left;
    parts.forEach(([text, out], i) => {
      const lit = out !== null && crossLight?.key === `${shownScope} ${out ? "out" : "in"}`;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = lit ? `#${look.highlight.toString(16).padStart(6, "0")}` : look.text;
      ctx.fillText(text, x, y);
      if (out !== null) countBoxes.push({ left: x - 4, right: x + widths[i] + 4, top: y - 4, bottom: y + 18, out });
      x += widths[i];
    });
    ctx.restore();
  };

  const bounds = () => {
    const placed = nodes.flatMap((_, at) => (Number.isNaN(positions[at * 3]) ? [] : [at]));
    if (placed.length === 0) return null;
    const centre = [0, 1, 2].map(
      (axis) => placed.reduce((sum, at) => sum + positions[at * 3 + axis], 0) / placed.length,
    );
    const far = Math.max(
      ...placed.map((at) =>
        Math.hypot(positions[at * 3] - centre[0], positions[at * 3 + 1] - centre[1], positions[at * 3 + 2] - centre[2]),
      ),
    );
    return { x: centre[0], y: centre[1], z: centre[2], r: far + 40 };
  };
  // The camera never comes closer than where the largest disc reaches half
  // the outline's margin, or a file with one link would fill the view with
  // two discs, the outline shrunk inside them.
  const closest = () => (Math.max(0, ...reach) * cssHeight) / (2 * HALF_FOV_TAN) / (OUTLINE_PAD / 2);

  const toView = new THREE.Vector3();
  function frame(): void {
    raf = 0;
    if (disposed || paused) return;
    frameCount++;
    let changed = false;

    if (fitting || frameCount % 30 === 0) {
      const box = bounds();
      if (box) {
        radius = box.r;
        if (fitting) {
          const target = controls.target;
          target.set(ease(target.x, box.x, 0.85), ease(target.y, box.y, 0.85), ease(target.z, box.z, 0.85));
          const direction = camera.position.clone().sub(target).normalize();
          const distance = camera.position.distanceTo(target);
          const wanted = Math.max(box.r / Math.sin(((FOV / 2) * Math.PI) / 180), closest());
          camera.position.copy(target).addScaledVector(direction, ease(distance, wanted, 0.85));
          changed = true;
          if (!workerRunning && ++settledFrames > 45) fitting = false;
        }
      }
    }

    if (controls.update()) changed = true;

    const distance = camera.position.distanceTo(controls.target);
    fog.near = Math.max(1, distance - 0.5 * radius);
    fog.far = distance + radius * (1 + 2 * (1 - FOG));

    const centre = crossLight ? -1 : centreNode();
    const litLines = crossLight?.lines ?? null;
    // The AGENTS.md and folder of a hovered or open node's scope stay lit and named.
    const hubScope = centre === -1 ? null : scopeOf[centre];
    const lightKey = crossLight ? crossLight.key : `node ${centre} ${hubScope ?? ""}`;
    const centreChanged = lightKey !== lastLight;
    if (centreChanged) {
      hub = hubScope === null ? [] : (hubOf.get(hubScope) ?? []);
      lit = crossLight ? crossLight.nodes : centre === -1 ? null : new Set([centre, ...around[centre], ...hub]);
      lastLight = lightKey;
    }
    let settling = false;

    if (hoverScope !== null && hovered === -1 && crossLight === null) {
      if (performance.now() - hoverLeftAt > 1500) hoverScope = null;
      else settling = true;
    }
    const wantedScope = hoverScope ?? (focused === -1 ? null : scopeOf[focused]);
    if (shownScope !== wantedScope && regionAlpha < 0.02) shownScope = wantedScope;
    if (shownScope !== crossingsOf) {
      crossings = shownScope === null ? [] : crossingsFor(shownScope);
      crossingsOf = shownScope;
      countBoxes = [];
    }
    const wanted = shownScope !== null && shownScope === wantedScope ? 1 : 0;
    if (regionAlpha !== wanted) {
      regionAlpha = ease(regionAlpha, wanted, 0.85);
      settling = true;
    }

    for (let at = 0; at < n; at++) {
      const target = lit === null || lit.has(at) ? 1 : FADE;
      if (fade[at] !== target) {
        fade[at] = ease(fade[at], target);
        settling = true;
      }
    }
    const lineLit = (j: number) =>
      litLines ? litLines.has(j) : centre !== -1 && (ends[2 * j] === centre || ends[2 * j + 1] === centre);
    for (let j = 0; j < m; j++) {
      const target = (centre === -1 && litLines === null) || lineLit(j) ? 1 : FADE;
      if (lineFade[j] !== target) {
        lineFade[j] = ease(lineFade[j], target);
        settling = true;
      }
    }
    // Colours go to the GPU only while something changes: an upload of every
    // line's colour each frame would cost more than drawing them.
    if (settling || centreChanged || colorsDirty || frameCount < 3) {
      const rgba = nodeColor.array as Float32Array;
      const sizes = nodeSize.array as Float32Array;
      const colour = new THREE.Color();
      for (let at = 0; at < n; at++) {
        if (at === centre) colour.copy(highlight);
        else colour.setHex(baseColor[at].color, THREE.LinearSRGBColorSpace);
        rgba[at * 4] = colour.r;
        rgba[at * 4 + 1] = colour.g;
        rgba[at * 4 + 2] = colour.b;
        rgba[at * 4 + 3] = fade[at] * baseColor[at].alpha;
        sizes[at] = Number.isNaN(positions[at * 3]) ? 0 : 2 * reach[at];
      }
      const line = lineRgba.array as Float32Array;
      for (let j = 0; j < m; j++) {
        const c = lineLit(j) ? highlight : lineColor;
        for (let end = 0; end < 2; end++) line.set([c.r, c.g, c.b, lineFade[j]], (j * 2 + end) * 4);
      }
      nodeColor.needsUpdate = true;
      nodeSize.needsUpdate = true;
      lineRgba.needsUpdate = true;
      colorsDirty = false;
    }

    if (riders.length > 0 && (changed || positionsDirty)) {
      camera.updateMatrixWorld();
      placeRiders();
      positionsDirty = true;
    }
    if (positionsDirty) {
      const place = nodePosition.array as Float32Array;
      for (let at = 0; at < n * 3; at++) place[at] = Number.isNaN(positions[at]) ? 0 : positions[at];
      const line = linePosition.array as Float32Array;
      for (let j = 0; j < m; j++) {
        line.set(place.subarray(ends[2 * j] * 3, ends[2 * j] * 3 + 3), j * 6);
        line.set(place.subarray(ends[2 * j + 1] * 3, ends[2 * j + 1] * 3 + 3), j * 6 + 3);
      }
      nodePosition.needsUpdate = true;
      linePosition.needsUpdate = true;
      changed = true;
      positionsDirty = false;
    }

    renderer.render(scene, camera);

    // Every node projected once a frame: picking reads it, and labels come
    // from it.
    if (changed || settling || frameCount % 10 === 0) {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const unitsToPixels = cssHeight / (2 * HALF_FOV_TAN);
      const candidates: { at: number; alpha: number }[] = [];
      camera.updateMatrixWorld();
      for (let at = 0; at < n; at++) {
        if (Number.isNaN(positions[at * 3])) {
          depth[at] = Number.POSITIVE_INFINITY;
          continue;
        }
        toView
          .set(positions[at * 3], positions[at * 3 + 1], positions[at * 3 + 2])
          .applyMatrix4(camera.matrixWorldInverse);
        const z = -toView.z;
        if (z <= camera.near) {
          depth[at] = Number.POSITIVE_INFINITY;
          continue;
        }
        const ppu = unitsToPixels / z;
        screenX[at] = width / 2 + toView.x * ppu;
        screenY[at] = height / 2 - toView.y * ppu;
        screenR[at] = reach[at] * ppu;
        depth[at] = z;
        if (screenX[at] < -50 || screenX[at] > width + 50 || screenY[at] < -50 || screenY[at] > height + 50) continue;
        // One entry's neighbourhood is few enough to name every node, so a
        // label fades with its node and the fog, never with the zoom as a
        // whole-space graph's would.
        const named = at === centre || hub.includes(at) || (crossLight?.nodes.has(at) ?? false);
        let alpha = named ? 1 : fade[at];
        if (!named) alpha *= 1 - clamp((z - fog.near) / (fog.far - fog.near), 0, 1);
        if (alpha > 0.03) candidates.push({ at, alpha });
      }
      candidates.sort((a, b) => b.alpha - a.alpha || depth[a.at] - depth[b.at]);
      const labelled = candidates.slice(0, MAX_LABELS);
      if (centre !== -1 && !labelled.some((c) => c.at === centre) && depth[centre] !== Number.POSITIVE_INFINITY) {
        labelled.push({ at: centre, alpha: 1 });
      }
      while (labelPool.length < labelled.length) {
        const label = document.createElement("div");
        label.className = "graph-label";
        overlay.append(label);
        labelPool.push(label);
      }
      labelBoxes = [];
      labelPool.forEach((label, slot) => {
        const entry = labelled[slot];
        label.hidden = !entry;
        if (!entry) return;
        const at = entry.at;
        const top = screenY[at] + screenR[at] + 4 + (at === centre ? 6 : 0);
        const size = clamp(13 * Math.sqrt(unitsToPixels / depth[at]), 9, 26);
        if (label.textContent !== nodes[at].label) label.textContent = nodes[at].label;
        label.style.left = `${screenX[at]}px`;
        label.style.top = `${top}px`;
        label.style.fontSize = `${size}px`;
        label.classList.toggle("centre", at === centre);
        label.style.opacity = String(entry.alpha);
        // A label faded too far to read can sit under the counts.
        if (entry.alpha < 0.3) return;
        const half = textWidth(nodes[at].label, size, at === centre) / 2;
        labelBoxes.push({ left: screenX[at] - half, right: screenX[at] + half, top, bottom: top + size * 1.2 });
      });

      if (regionCtx) {
        const ratio = regionLayer.width / Math.max(1, width);
        regionCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
        regionCtx.clearRect(0, 0, width, height);
        // Chrome can keep showing a canvas's last frame after it is cleared
        // to nothing, so an empty layer is hidden as well.
        const showing = shownScope !== null && regionAlpha > 0.01;
        regionLayer.hidden = !showing;
        if (showing && shownScope !== null) {
          const parent = parentScope.get(shownScope) ?? null;
          if (parent) drawRegion(parent, regionAlpha * 0.35, 1.5, false);
          drawRegion(shownScope, regionAlpha, 2.5, true);
        }
      }
    }

    if (changed || settling || workerRunning || dragged !== -1 || fitting) idle = 0;
    else idle++;
    // A wake during this frame may already have asked for the next one.
    if (idle < 60 && !raf) raf = requestAnimationFrame(frame);
  }
  wake();

  const place = (vector: THREE.Vector3): Place => [vector.x, vector.y, vector.z];

  return {
    setLook(next) {
      look = next;
      applyLook();
      colorsDirty = true;
      wake();
    },
    focus(id) {
      focused = id === null ? -1 : (index.get(id) ?? -1);
      wake();
    },
    positions() {
      const out = new Map<string, Place>();
      nodes.forEach((node, at) => {
        if (!Number.isNaN(positions[at * 3])) {
          out.set(node.id, [positions[at * 3], positions[at * 3 + 1], positions[at * 3 + 2]]);
        }
      });
      return out;
    },
    view: () => ({ position: place(camera.position), target: place(controls.target) }),
    pause() {
      paused = true;
      cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      paused = false;
      resize();
      wake();
    },
    // The renderer and its canvas outlive the scene; everything else it
    // made goes with it.
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      worker.terminate();
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.style.cursor = "";
      controls.dispose();
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      lineGeometry.dispose();
      lineMaterial.dispose();
      regionLayer.remove();
      overlay.remove();
    },
  };
}
