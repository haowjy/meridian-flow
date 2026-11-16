/**
 * remark-gfm's `delete` handler predates mdast-util-to-markdown's attention
 * pairing (2.2), so a strike run is not encoded to stay pairable next to
 * emphasis. Tagging the handler with `attention` hands the run to
 * `containerPhrasing`, which chooses markers and encodes the edges.
 */

import type { Attention, Handle } from "mdast-util-to-markdown";

const strikeAttention: Attention = () => ({
  construct: "strikethrough" as ReturnType<Attention>["construct"],
  markers: ["~"],
  sizes: [2],
});

const strike: Handle & { attention?: Attention; peek?: () => string } = (
  node,
  _parent,
  state,
  info,
) => {
  const tracker = state.createTracker(info);
  const exit = state.enter("strikethrough" as Parameters<typeof state.enter>[0]);
  let value = tracker.move("~~");
  value += state.containerPhrasing(node, { ...tracker.current(), before: value, after: "~" });
  value += tracker.move("~~");
  exit();
  return value;
};
strike.attention = strikeAttention;
strike.peek = () => "~";

export const attentionHandlers = { delete: strike };
