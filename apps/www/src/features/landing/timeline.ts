export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const progress = (value: number, from: number, to: number) =>
  clamp((value - from) / (to - from));
export const smooth = (value: number, from: number, to: number) => ease(progress(value, from, to));

/** Beat name, then its scroll length in viewport heights and its autoplay seconds. */
const BEATS = [
  ["hold", 0.5, 1.2],
  ["push", 0.9, 2],
  ["sky", 1.6, 7],
  ["world", 1.1, 8],
  ["open", 0.4, 2.2],
  ["write", 1.2, 14],
  ["out", 0.7, 3.5],
  ["back", 0.8, 7],
  ["turn", 1.1, 7],
  ["twist", 2, 6],
  ["dawn", 1.5, 6],
  ["lore", 2.2, 6],
  ["ask", 1, 10],
  ["hints", 1.2, 9],
  ["roam", 3, 6],
  ["leave", 0.7, 3],
] as const;

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
  const write = (share: number) => along(spans, "write", share);
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
    jumpTo: (spans: BeatSpans) => along(spans, "world", 0.84),
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
    jumpTo: (spans: BeatSpans) => along(spans, "ask", 0.25),
  },
  {
    hash: "#the-workspace",
    label: "Workspace",
    startsAt: (spans: BeatSpans) => spans.hints[0],
    jumpTo: (spans: BeatSpans) => along(spans, "hints", 0.1),
  },
] as const;
