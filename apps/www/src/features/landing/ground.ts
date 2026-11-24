import type { Layout } from "./film-layout";
import { progress, smooth, TURN } from "./timeline";

export const GROUND = {
  wide: 2.5,
  tall: 0.5,
  floor: 0.95,
  beach: 0.915,
  feet: 0.93,
  shore: [1.5, 2.3],
} as const;

const ROAD = [0.075, 0.195] as const;
const TO_SHORE = 1.1;

export const walked = (at: number, { spans }: Layout) =>
  ROAD[0] +
  (ROAD[1] - ROAD[0]) * progress(at, spans.world[0], spans.write[1]) +
  TO_SHORE * smooth(progress(at, ...spans.turn), ...TURN.walksOut);

export const onTheShore = (share: number) =>
  GROUND.shore[0] + (GROUND.shore[1] - GROUND.shore[0]) * share - ROAD[1] - TO_SHORE;
