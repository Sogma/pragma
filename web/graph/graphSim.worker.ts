/// <reference path="./d3-force-3d.d.ts" />
// The graph's physics, off the main thread: centring on every axis, links,
// repulsion with a 30-unit floor, collision at 60 and velocity decay 0.4, in
// three dimensions, positions posted back about once a frame.

import type { SimLink, SimNode } from "d3-force-3d";
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from "d3-force-3d";

export interface Forces {
  center: number;
  repel: number;
  linkStrength: number;
  linkDistance: number;
  // How hard a file is pulled to its scope's AGENTS.md; 0 leaves it free.
  scopePull: number;
}

// `springs` pairs each file with its scope's AGENTS.md, and a nested AGENTS.md with
// its parent's, in the same indices as `links`. `alpha` is how hot the
// layout starts: lower when most nodes keep a place from before.
export type ToWorker =
  | { type: "init"; positions: Float32Array; links: Int32Array; springs: Int32Array; forces: Forces; alpha: number }
  | { type: "forces"; forces: Forces }
  | { type: "drag"; index: number; x: number; y: number; z: number }
  | { type: "release"; index: number };

export type FromWorker = { type: "tick"; positions: Float32Array; running: boolean };

type Link = SimLink<SimNode>;

let nodes: SimNode[] = [];
let links: Link[] = [];
let springs: Link[] = [];
let count: number[] = [];
let forces: Forces = { center: 0.1, repel: 1000, linkStrength: 1, linkDistance: 250, scopePull: 0 };
let simulation = forceSimulation<SimNode>([], 3).stop();
let running = false;
let timer = 0;

function applyForces(): void {
  simulation
    .force("x", forceX<SimNode>(0).strength(forces.center))
    .force("y", forceY<SimNode>(0).strength(forces.center))
    .force("z", forceZ<SimNode>(0).strength(forces.center))
    .force(
      "link",
      forceLink<SimNode, Link>(links)
        .distance(forces.linkDistance)
        .strength((link) => {
          const a = (link.source as SimNode).index ?? 0;
          const b = (link.target as SimNode).index ?? 0;
          return forces.linkStrength / Math.min(count[a] || 1, count[b] || 1);
        }),
    )
    .force("charge", forceManyBody<SimNode>().strength(-Math.max(1, forces.repel)).distanceMin(30))
    .force("collide", forceCollide<SimNode>(60).strength(0.5))
    // A force of their own, so a spring never counts towards a node's links,
    // which set each link's strength above. Half a link long, so two files
    // of one scope can still sit a link apart across their AGENTS.md.
    .force(
      "scope",
      springs.length > 0 && forces.scopePull > 0
        ? forceLink<SimNode, Link>(springs)
            .distance(forces.linkDistance / 2)
            .strength(forces.scopePull)
        : null,
    );
}

function post(): void {
  const positions = new Float32Array(nodes.length * 3);
  for (let at = 0; at < nodes.length; at++) {
    positions[at * 3] = nodes[at].x ?? 0;
    positions[at * 3 + 1] = nodes[at].y ?? 0;
    positions[at * 3 + 2] = nodes[at].z ?? 0;
  }
  const message: FromWorker = { type: "tick", positions, running };
  (self as unknown as Worker).postMessage(message, [positions.buffer]);
}

function loop(): void {
  timer = 0;
  if (!running) return;
  const started = performance.now();
  simulation.tick();
  if (simulation.alpha() < simulation.alphaMin() && simulation.alphaTarget() === 0) running = false;
  post();
  if (running) timer = self.setTimeout(loop, Math.max(0, 16 - (performance.now() - started)));
}

function run(alpha: number): void {
  if (simulation.alpha() < alpha) simulation.alpha(alpha);
  running = true;
  if (!timer) timer = self.setTimeout(loop, 0);
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  if (message.type === "init") {
    const total = message.positions.length / 3;
    nodes = Array.from({ length: total }, (_, at) => {
      const x = message.positions[at * 3];
      if (Number.isNaN(x)) return {};
      return { x, y: message.positions[at * 3 + 1], z: message.positions[at * 3 + 2] };
    });
    links = [];
    count = new Array(total).fill(0);
    for (let at = 0; at < message.links.length; at += 2) {
      links.push({ source: message.links[at], target: message.links[at + 1] });
      count[message.links[at]]++;
      count[message.links[at + 1]]++;
    }
    springs = [];
    for (let at = 0; at < message.springs.length; at += 2) {
      springs.push({ source: message.springs[at], target: message.springs[at + 1] });
    }
    forces = message.forces;
    simulation = forceSimulation<SimNode>(nodes, 3).stop().velocityDecay(0.4);
    applyForces();
    simulation.alpha(message.alpha);
    run(message.alpha);
  } else if (message.type === "forces") {
    forces = message.forces;
    applyForces();
    run(0.3);
  } else if (message.type === "drag") {
    const node = nodes[message.index];
    if (!node) return;
    node.fx = message.x;
    node.fy = message.y;
    node.fz = message.z;
    simulation.alphaTarget(0.3);
    run(0.3);
  } else if (message.type === "release") {
    const node = nodes[message.index];
    if (node) {
      node.fx = null;
      node.fy = null;
      node.fz = null;
    }
    simulation.alphaTarget(0);
  }
};
