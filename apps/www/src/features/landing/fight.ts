import type { Dragon } from "./dragon-actor";
import type { Layout } from "./film-layout";
import type { FireFrame } from "./fire";
import type { Party } from "./forest";
import { type BeatProgress, envelope, FIGHT, lerp, progress } from "./timeline";

type Point = readonly [number, number];

/** A wall past the right edge of the stage: the fire draws only the breath. */
const NO_WALL = 100;
/** The fight's breaths: how hard, and what share of the way to the party they reach. */
const FIGHT_BREATH = 0.85;
/** How long a hit's flash lasts, in shares of the fight beat. */
const HIT_LASTS = 0.035;
/** How high the spark arcs, in stage heights. */
const SPARK_ARC = 0.14;

/**
 * The ninth night's fight, between the party and the dragon: Sigrun's ward, the four attacks and
 * where each lands, and the breaths. The party and the dragon place themselves; this reads where
 * they are.
 */
export function createFight(root: HTMLElement) {
  const shot = (name: string) => root.querySelector(`#walkers .${name}`) as HTMLElement;
  const ward = shot("ward");
  const spark = shot("spark");
  const rune = shot("rune");
  const song = shot("song");
  const hit = shot("hit");
  let layout: Layout;

  /** Moves a shot from `from` to `to` across its window, arcing up by `arc` stage heights. */
  const fling = (
    element: HTMLElement,
    window: readonly [number, number],
    fight: number,
    from: Point,
    to: Point,
    arc: number,
    pointed = false,
  ) => {
    const t = progress(fight, ...window);
    const flying = t > 0 && t < 1;
    element.style.opacity = flying ? "1" : "0";
    if (!flying) return;
    const x = lerp(from[0], to[0], t);
    const y = lerp(from[1], to[1], t) - Math.sin(t * Math.PI) * layout.height * arc;
    const turn = pointed ? Math.atan2(to[1] - from[1], to[0] - from[0]) : 0;
    const grow = pointed ? 1 : 0.6 + t;
    element.style.transform = `translate3d(${x}px,${y}px,0) rotate(${turn}rad) scale(${grow}) translate(-50%,-50%)`;
  };

  /** Sigrun's ward: it flares to full the instant the first breath lands, then shudders under it. */
  const raiseWard = (at: number, fight: number, party: Party) => {
    const flare = Math.min(1, envelope(fight, FIGHT.ward, 0.04, 0.05) * 2.5);
    const [x, y] = party.rows[0];
    ward.style.opacity = String(flare * (0.85 + Math.sin(at / 5) * 0.15));
    ward.style.transform = `translate3d(${x + party.size * 0.02}px,${y + party.size * 0.05}px,0) scale(${(party.size / 100) * (0.9 + flare * 0.5)}) rotate(${at / 60}rad) translate(-50%,-50%)`;
  };

  /** Each of the four hits it once, and every hit flashes where it lands. */
  const attack = (fight: number, party: Party, { mouth, body }: Dragon) => {
    const chest = [
      lerp(mouth[0], body.x, 0.45),
      lerp(mouth[1], body.y, 0.45) + body.size * 0.05,
    ] as const;
    const foot = [body.x - body.size * 0.12, body.y + body.size * 0.22] as const;
    const flank = [body.x + body.size * 0.05, body.y + body.size * 0.12] as const;
    const from = (row: number) => party.rows[row];
    fling(rune, FIGHT.rune.at, fight, from(FIGHT.rune.row), chest, 0.03, true);
    fling(song, FIGHT.song.at, fight, from(FIGHT.song.row), chest, 0.02);
    // Tam's two sparks: the scales above its left foot, then its eye.
    const toEye = fight >= FIGHT.spark.foot[1];
    const [sparkAt, sparkTo] = toEye ? [FIGHT.spark.eye, mouth] : [FIGHT.spark.foot, foot];
    fling(
      spark,
      sparkAt,
      fight,
      from(FIGHT.spark.row),
      sparkTo,
      toEye ? SPARK_ARC : SPARK_ARC * 0.4,
    );
    const landings = [
      [FIGHT.rune.at[1], chest],
      [FIGHT.song.at[1], chest],
      [lerp(FIGHT.charge.at[0], FIGHT.charge.at[1], 0.5), flank],
      [FIGHT.spark.foot[1], foot],
      [FIGHT.spark.eye[1], mouth],
    ] as const;
    const landed = landings.find(([at]) => fight >= at && fight < at + HIT_LASTS);
    hit.style.opacity = landed ? String(1 - (fight - landed[0]) / HIT_LASTS) : "0";
    if (landed) {
      const [x, y] = landed[1];
      const grow = 0.6 + ((fight - landed[0]) / HIT_LASTS) * 0.8;
      hit.style.transform = `translate3d(${x}px,${y}px,0) scale(${grow}) translate(-50%,-50%)`;
    }
  };

  /** The ward breath stops at the front of the party; the killing one sweeps it front to back. */
  const breathe = (fight: number, party: Party, mouth: Point) => {
    const reach = (target: Point, share: number) =>
      [lerp(mouth[0], target[0], share), lerp(mouth[1], target[1], share)] as const;
    const warded = envelope(fight, FIGHT.ward, 0.03, 0.04);
    const front = party.rows[FIGHT.places.indexOf(0)];
    const back = party.rows[FIGHT.places.indexOf(3)];
    if (warded > 0) return { aim: reach(front, 1), breath: warded * FIGHT_BREATH };
    const killing = envelope(fight, FIGHT.breath, 0.03, 0.04);
    if (killing <= 0) return null;
    const along = progress(fight, ...FIGHT.breath);
    const target = [lerp(front[0], back[0], along), lerp(front[1], back[1], along)] as const;
    return { aim: reach(target, 1.1), breath: killing * FIGHT_BREATH };
  };

  return {
    measure(next: Layout) {
      layout = next;
    },
    /** Runs every frame; returns the breath's fire while one is in the air. */
    update(
      seconds: number,
      at: number,
      beats: BeatProgress,
      party: Party | null,
      dragon: Dragon,
    ): FireFrame | null {
      if (!party) {
        for (const element of [ward, rune, song, spark, hit]) element.style.opacity = "0";
        return null;
      }
      raiseWard(at, beats.fight, party);
      attack(beats.fight, party, dragon);
      const breath = breathe(beats.fight, party, dragon.mouth);
      return (
        breath && {
          mouth: dragon.mouth,
          ...breath,
          char: NO_WALL,
          time: at / layout.height + seconds * 0.5,
        }
      );
    },
  };
}
