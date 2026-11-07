export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const progress = (value: number, from: number, to: number) =>
  clamp((value - from) / (to - from));
export const smooth = (value: number, from: number, to: number) => ease(progress(value, from, to));
/** Up across `rise` from the window's start and back down across `fall` to its end: 0 outside. */
export const envelope = (
  value: number,
  [from, to]: readonly [number, number],
  rise: number,
  fall: number,
) => smooth(value, from, from + rise) * (1 - smooth(value, to - fall, to));

/**
 * Beat name, then its scroll length in viewport heights and its autoplay seconds.
 * Lengths leave one viewport of stillness after each thing to read, about two swipes.
 */
const BEATS = [
  ["hold", 0.5, 0.8],
  ["push", 0.9, 1.4],
  ["sky", 2, 6],
  ["world", 2.1, 7.5],
  ["open", 0.4, 1.5],
  ["write", 2.2, 12],
  ["out", 0.7, 2.5],
  ["back", 0.9, 5],
  ["camp", 1.4, 4],
  ["turn", 1.8, 6.5],
  ["fight", 3, 8.5],
  ["dies", 0.8, 2],
  ["still", 1, 2],
  ["flight", 0.9, 2],
  ["burn", 1.3, 2.5],
  ["dawn", 1.5, 4],
  ["lore", 1.5, 3.5],
  ["ask", 3, 8.5],
  ["hints", 1.2, 3.5],
  ["roam", 1.2, 2],
  ["skill", 1.6, 4],
  ["leave", 0.7, 2],
] as const;

/**
 * Shares of the camp beat: they sit down round the fire, then the System shows the four of them
 * at once, a status window each, before the ninth night.
 */
export const CAMP = { sits: [0, 0.2], sheets: [0.2, 0.72] } as const;
/*
 * The story's moments, as shares of their beat. Every number that more than one layer has to
 * agree on is here; a layer keeps only the curves nothing else needs to match.
 */

/**
 * The turn: they stand up and walk out of the woods onto the lake shore while the dragon comes
 * down, lands in front of them and perches. Perched, it raises its head and sends the Cold Fire up
 * into the sky while they back away; then the fight starts.
 */
export const TURN = {
  walksOut: [0.02, 0.5],
  /** From here it is low over the trees and keeps its eyes on them. */
  descends: 0.45,
  lands: 0.58,
  perch: [0.6, 0.97],
} as const;

/**
 * The death, across four beats. `dies`: the box opens over the last one standing, and the last
 * shadow goes. `still`: nothing moves but the sky, and the Cold Fire over the peak dies down.
 * `flight`: the dragon takes off, loops once small in the far sky, and goes out at the left.
 * `burn`: it comes back across the stage, burning the box away to uncover the dawn.
 */
export const DEATH = {
  /** Shares of `dies`: the box appears, grows from a bright line, and the party goes. */
  appears: [0.075, 0.15],
  opens: [0.11, 0.375],
  partyGone: [0.45, 0.975],
  /** Shares of `flight`: up behind the box, the loop, and out at the left. */
  loop: [0.14, 0.41, 0.64],
  /** Shares of `burn`: where the fire uncovers the dawn, the dragon leaves, and the box goes. */
  reveals: 0.08,
  exits: 0.82,
  gone: [0.89, 1],
} as const;

/** How much of the Cold Fire the dragon sent up is still over the peak: it dies down in the still. */
export const coldFireLeft = (beats: BeatProgress) => 1 - ease(beats.still);

/** It comes back into the dawn, and reaches the knowledge base early in the lore. */
export const DAWN = { returns: 0.1 } as const;
export const LORE = { arrives: 0.05 } as const;

/**
 * The ask: the question lifts out of the chat two swipes in. Whenever the card is fully up it
 * shows only what the visitor chose: nothing, autoplay included, answers for them, and a pass made
 * by scrolling or jumping past comes off when they come back. Only as the card starts to leave
 * does the System pick the survivor, so its notice shows on the card on the way out.
 */
export const ASK = { lift: [0.43, 0.55], assigns: 0.89 } as const;

/**
 * The ninth night, as shares of the fight beat, after the Prologue: Sigrun's ward splits the
 * first breath, then each of the four hits it. Sigrun throws a cut rune, Maren's song breaks on
 * it, Oskar charges its flank, and Tam's spark goes into the scales above its left foot, then
 * into its eye. Then one breath kills them: who falls when, and how. The one left is a shadow,
 * because the visitor hasn't said who survives yet. Rows are the walkers: Sigrun, Tam, Oskar,
 * Maren, the order they walk in. `places` is where each stands in the fight, front first: Sigrun
 * in front with her wards, Maren behind her, Oskar on the flank, Tam behind them all.
 */
export const FIGHT = {
  places: [0, 3, 2, 1],
  ward: [0.08, 0.22],
  rune: { row: 0, at: [0.23, 0.29] },
  song: { row: 3, at: [0.28, 0.37] },
  charge: { row: 2, at: [0.35, 0.45] },
  spark: { row: 1, foot: [0.44, 0.49], eye: [0.5, 0.56] },
  breath: [0.6, 0.86],
  fates: [
    { kind: "fall", at: 0.65 },
    { kind: "stand", at: 0.86 },
    { kind: "flung", at: 0.71 },
    { kind: "fall", at: 0.79 },
  ],
} as const;

/**
 * How far the opening view has tipped down from straight overhead to the horizon, 0 to 1. It
 * holds overhead for a while once the product has gone, then tips down before the world opens.
 */
export const tilt = (beats: BeatProgress) => smooth(beats.sky, 0.28, 0.86);

/** The dragon is on the ground from its landing until it takes off, but for the rear at the spark. */
export const grounded = (beats: BeatProgress) =>
  beats.turn >= TURN.lands &&
  beats.flight <= 0 &&
  (beats.fight < FIGHT.spark.eye[1] || beats.fight >= FIGHT.breath[0]);

/** The share of the write and world beats spent typing; the rest is the hold. */
export const WRITE_TYPED = 0.55;
export const WORLD_TYPED = 0.52;

type Beat = (typeof BEATS)[number][0];
export type Span = readonly [start: number, end: number];
export type BeatSpans = Record<Beat, Span>;
/** How far through each beat a scroll position is, 0 to 1. */
export type BeatProgress = Record<Beat, number>;

const AUTOPLAY_TAIL_SECONDS = 2.5;
const BEAT_SECONDS = BEATS.reduce((total, beat) => total + beat[2], 0);

export const AUTOPLAY_SECONDS = BEAT_SECONDS + AUTOPLAY_TAIL_SECONDS;

/** The scroll position `share` of the way through a beat. */
export const along = (spans: BeatSpans, name: Beat, share: number) =>
  spans[name][0] + (spans[name][1] - spans[name][0]) * share;

export function spanBeats(viewportHeight: number) {
  const spans = {} as Record<Beat, Span>;
  const stops = [{ y: 0, t: 0 }];
  let position = 0;
  let seconds = 0;
  for (const [name, viewports, duration] of BEATS) {
    spans[name] = [position, position + viewportHeight * viewports];
    position += viewportHeight * viewports;
    seconds += duration;
    stops.push({ y: position, t: seconds });
  }
  const write = (share: number) => along(spans, "write", share * WRITE_TYPED);
  const subtitles = {
    s1: [spans.open[0], write(0.2)],
    s2: [write(0.24), write(0.7)],
    s3: spans.out,
    // Only once the camp's sheets are down, so the two never share the stage.
    s4: [along(spans, "camp", CAMP.sheets[1]), spans.turn[0] + viewportHeight * 0.15],
  } as Record<string, Span>;
  return { spans, stops, subtitles, length: position };
}

/** How far through a run of beats, `first` to `last`, by scroll length: one curve across them all. */
export function across(beats: BeatProgress, first: Beat, last: Beat) {
  const from = BEATS.findIndex(([name]) => name === first);
  const to = BEATS.findIndex(([name]) => name === last);
  const run = BEATS.slice(from, to + 1);
  const length = run.reduce((total, [, viewports]) => total + viewports, 0);
  return run.reduce((done, [name, viewports]) => done + beats[name] * viewports, 0) / length;
}

export function beatProgress(at: number, spans: BeatSpans): BeatProgress {
  const result = {} as BeatProgress;
  for (const [name] of BEATS) result[name] = progress(at, spans[name][0], spans[name][1]);
  return result;
}

/** The stops of the top bar, in order. */
export const SECTIONS = [
  {
    hash: "#the-world",
    label: "World",
    startsAt: (spans: BeatSpans, vh: number) => spans.sky[1] - vh * 0.1,
    jumpTo: (spans: BeatSpans) => along(spans, "world", 0.7),
  },
  {
    hash: "#the-team",
    label: "AI Team",
    startsAt: (spans: BeatSpans, vh: number) => spans.out[0] - vh * 0.1,
    jumpTo: (spans: BeatSpans) => spans.out[1],
  },
  {
    hash: "#knowledge-base",
    label: "Knowledge Base",
    startsAt: (spans: BeatSpans) => spans.lore[0],
    jumpTo: (spans: BeatSpans) => along(spans, "lore", 0.6),
  },
  {
    hash: "#your-decisions",
    label: "Your decisions",
    startsAt: (spans: BeatSpans, vh: number) => spans.ask[0] - vh * 0.05,
    jumpTo: (spans: BeatSpans) => along(spans, "ask", ASK.lift[1]),
  },
  {
    hash: "#the-workspace",
    label: "Workspace",
    startsAt: (spans: BeatSpans) => spans.hints[0],
    jumpTo: (spans: BeatSpans) => along(spans, "hints", 0.1),
  },
] as const;
