// d3-force-3d ships no types; this covers what the graph worker calls. Its API
// is d3-force's, with a z axis and a number of dimensions.
declare module "d3-force-3d" {
  export interface SimNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimLink<N> {
    source: N | number;
    target: N | number;
    index?: number;
  }

  export type Force = (alpha: number) => void;

  export interface Simulation<N> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    force(name: string): Force | undefined;
    force(name: string, force: Force | null): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaTarget(): number;
    alphaTarget(value: number): this;
    velocityDecay(value: number): this;
    tick(iterations?: number): this;
    stop(): this;
  }

  export interface StrengthForce<T> extends Force {
    strength(value: number | ((item: T) => number)): this;
  }

  export interface LinkForce<N, L> extends Force {
    distance(value: number | ((link: L) => number)): this;
    strength(value: number | ((link: L) => number)): this;
  }

  export interface ManyBodyForce<N> extends StrengthForce<N> {
    distanceMin(value: number): this;
  }

  export interface CollideForce<N> extends StrengthForce<N> {
    radius(value: number | ((node: N) => number)): this;
  }

  export function forceSimulation<N extends SimNode>(nodes?: N[], dimensions?: number): Simulation<N>;
  export function forceX<N extends SimNode>(x?: number): StrengthForce<N>;
  export function forceY<N extends SimNode>(y?: number): StrengthForce<N>;
  export function forceZ<N extends SimNode>(z?: number): StrengthForce<N>;
  export function forceLink<N extends SimNode, L extends SimLink<N>>(links?: L[]): LinkForce<N, L>;
  export function forceManyBody<N extends SimNode>(): ManyBodyForce<N>;
  export function forceCollide<N extends SimNode>(radius?: number): CollideForce<N>;
}
