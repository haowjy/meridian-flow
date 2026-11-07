export const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;
export const ease = (t: number) => t * t * (3 - 2 * t);
export const progress = (value: number, from: number, to: number) =>
  clamp((value - from) / (to - from));
export const smooth = (value: number, from: number, to: number) => ease(progress(value, from, to));

/** Beat name, then its scroll length in viewport heights and its autoplay seconds. */
const BEATS = [
  ["hold", 0.1, 1.2],
  ["push", 0.55, 2],
  ["world", 0.65, 8],
  ["open", 0.2, 2.2],
  ["write", 0.8, 14],
  ["out", 0.45, 3.5],
  ["back", 0.5, 7],
  ["ask", 0.7, 10],
  ["turn", 0.4, 6],
  ["twist", 0.6, 5],
  ["dawn", 0.8, 4.5],
  ["hints", 0.8, 9],
  ["leave", 0.45, 3],
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
    s4: [spans.back[1] - viewportHeight * 0.2, spans.ask[0] + viewportHeight * 0.02],
  } as Record<string, Span>;
  return { spans, stops, subtitles, length: position };
}

export function beatProgress(at: number, spans: BeatSpans): BeatProgress {
  const result = {} as BeatProgress;
  for (const [name] of BEATS) result[name] = progress(at, spans[name][0], spans[name][1]);
  return result;
}

/** The four stops of the top bar, in order. */
export const SECTIONS = [
  {
    hash: "#the-world",
    label: "World",
    startsAt: (spans: BeatSpans, vh: number) => spans.push[1] - vh * 0.1,
    jumpTo: (spans: BeatSpans) => along(spans, "world", 0.84),
  },
  {
    hash: "#the-team",
    label: "AI Team",
    startsAt: (spans: BeatSpans, vh: number) => spans.out[0] - vh * 0.1,
    jumpTo: (spans: BeatSpans) => spans.out[1],
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
    startsAt: (spans: BeatSpans, vh: number) => spans.dawn[1] - vh * 0.1,
    jumpTo: (spans: BeatSpans) => along(spans, "hints", 0.1),
  },
] as const;
