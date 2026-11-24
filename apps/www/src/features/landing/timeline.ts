export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const progress = (value: number, from: number, to: number) =>
  clamp((value - from) / (to - from));
export const smooth = (value: number, from: number, to: number) => ease(progress(value, from, to));
export const envelope = (
  value: number,
  [from, to]: readonly [number, number],
  rise: number,
  fall: number,
) => smooth(value, from, from + rise) * (1 - smooth(value, to - fall, to));

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

export const CAMP = { sits: [0, 0.2], sheets: [0.2, 0.72] } as const;

export const TURN = {
  walksOut: [0.02, 0.5],
  descends: 0.45,
  lands: 0.58,
  perch: [0.6, 0.97],
} as const;

export const DEATH = {
  appears: [0.075, 0.15],
  opens: [0.11, 0.375],
  partyGone: [0.45, 0.975],
  loop: [0.14, 0.41, 0.64],
  reveals: 0.08,
  exits: 0.82,
  gone: [0.89, 1],
} as const;

export const coldFireLeft = (beats: BeatProgress) => 1 - ease(beats.still);

export const DAWN = { returns: 0.1 } as const;
export const LORE = { arrives: 0.05 } as const;

export const ASK = { lift: [0.43, 0.55], assigns: 0.89 } as const;

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

export const tilt = (beats: BeatProgress) => smooth(beats.sky, 0.28, 0.86);

export const grounded = (beats: BeatProgress) =>
  beats.turn >= TURN.lands &&
  beats.flight <= 0 &&
  (beats.fight < FIGHT.spark.eye[1] || beats.fight >= FIGHT.breath[0]);

export const WRITE_TYPED = 0.55;
export const WORLD_TYPED = 0.52;

type Beat = (typeof BEATS)[number][0];
export type Span = readonly [start: number, end: number];
export type BeatSpans = Record<Beat, Span>;
export type BeatProgress = Record<Beat, number>;

const AUTOPLAY_TAIL_SECONDS = 2.5;
const BEAT_SECONDS = BEATS.reduce((total, beat) => total + beat[2], 0);

export const AUTOPLAY_SECONDS = BEAT_SECONDS + AUTOPLAY_TAIL_SECONDS;

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
    s4: [along(spans, "camp", CAMP.sheets[1]), spans.turn[0] + viewportHeight * 0.15],
  } as Record<string, Span>;
  return { spans, stops, subtitles, length: position };
}

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
