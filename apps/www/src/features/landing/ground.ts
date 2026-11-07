import type { Layout } from "./film-layout";
import { progress, smooth, TURN } from "./timeline";

/**
 * The ground the party walks, in shares of the stage. It is one strip, wider than the stage, along
 * the bottom of it: the forest, then the clearing on the lake shore where they meet the dragon,
 * then a stand of trees behind it. It slides under them only while they walk.
 */
export const GROUND = {
  /** The strip's size: stage widths across, stage heights up from the bottom. */
  wide: 2.5,
  tall: 0.5,
  /** The woods' floor, and the beach's surface in the clearing, from the top of the stage. */
  floor: 0.95,
  beach: 0.915,
  /** Where the walkers' feet are. */
  feet: 0.93,
  /** The clearing, in strip widths. */
  shore: [1.5, 2.3],
} as const;

/** How far along the strip they walk: the road, then out of the woods onto the shore. */
const ROAD = [0.075, 0.195] as const;
const TO_SHORE = 1.1;

/**
 * How far the strip has slid left, in stage widths. Camped, perched over or fighting, it holds
 * still.
 */
export const walked = (at: number, { spans }: Layout) =>
  ROAD[0] +
  (ROAD[1] - ROAD[0]) * progress(at, spans.world[0], spans.write[1]) +
  TO_SHORE * smooth(progress(at, ...spans.turn), ...TURN.walksOut);

/** A point `share` of the way across the clearing, in stage widths, once they stand on the shore. */
export const onTheShore = (share: number) =>
  GROUND.shore[0] + (GROUND.shore[1] - GROUND.shore[0]) * share - ROAD[1] - TO_SHORE;
