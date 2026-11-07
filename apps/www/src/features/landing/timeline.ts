export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const progress = (value: number, from: number, to: number) =>
  clamp((value - from) / (to - from));
export const smooth = (value: number, from: number, to: number) => ease(progress(value, from, to));

/**
 * Beat name, then its scroll length in viewport heights and its autoplay seconds.
 * Lengths leave one viewport of stillness after each thing to read, about two swipes.
 */
const BEATS = [
  ["hold", 0.5, 1.2],
  ["push", 0.9, 2],
  ["sky", 1.6, 7],
  ["world", 2.1, 11],
  ["open", 0.4, 2.2],
  ["write", 2.2, 17],
  ["out", 0.7, 3.5],
  ["back", 0.9, 7],
  ["turn", 1.8, 9],
  ["fight", 3, 12],
  ["twist", 3, 9],
  ["dawn", 1.5, 6],
  ["lore", 1.5, 5],
  ["ask", 3, 12],
  ["hints", 1.2, 5],
  ["roam", 1.2, 3],
  ["skill", 1.6, 6],
  ["leave", 0.7, 3],
] as const;

/** The share of the ask where the question lifts out of the chat, 2 swipes in. */
export const ASK_LIFT = [0.43, 0.55] as const;
/**
 * The ninth night, as shares of the fight beat. The ward splits the first breath, then each of
 * the four hits it once: the front one's arrow, Maren's song, Oskar's charge at its left foot,
 * and Tam's spark in its eye. Then one breath kills them: who falls when, and how. The one left
 * is a shadow, because the visitor hasn't said who survives yet. Rows are the walkers, front first.
 */
export const FIGHT = {
  ward: [0.08, 0.22],
  arrow: { row: 0, at: [0.23, 0.29] },
  song: { row: 3, at: [0.28, 0.38] },
  charge: { row: 2, at: [0.36, 0.48] },
  spark: { row: 1, at: [0.47, 0.54] },
  breath: [0.6, 0.86],
  fates: [
    { kind: "fall", at: 0.65 },
    { kind: "flung", at: 0.71 },
    { kind: "stand", at: 0.86 },
    { kind: "fall", at: 0.79 },
  ],
} as const;

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

const along = (spans: BeatSpans, name: Beat, share: number) =>
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
    s4: [spans.back[1] - viewportHeight * 0.2, spans.turn[0] + viewportHeight * 0.1],
  } as Record<string, Span>;
  return { spans, stops, subtitles, length: position };
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
    jumpTo: (spans: BeatSpans) => along(spans, "ask", ASK_LIFT[1]),
  },
  {
    hash: "#the-workspace",
    label: "Workspace",
    startsAt: (spans: BeatSpans) => spans.hints[0],
    jumpTo: (spans: BeatSpans) => along(spans, "hints", 0.1),
  },
] as const;
