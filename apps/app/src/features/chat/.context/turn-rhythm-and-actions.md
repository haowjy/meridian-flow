# Turn rhythm and settled actions

The decisions are
[Chat Thread Rhythm](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/transcript.md)
and
[Finished Turns Carry Actions](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/chat/turns.md).

## Spacing

`--chat-space-*`, `--chat-card-pad-*` and `--chat-geometry-*` live on `:root` because
portaled menus render outside the chat subtree; scoping them to `text-tier-chat`
collapses those surfaces to zero spacing. `--prose-space-*` defaults keep manuscript
prose at its own values and `text-tier-chat` alone remaps them, so pointing a default at
a chat token changes every non-chat surface.

`TurnList`'s measured `<li>` owns the space between turns, as padding inside the row.
Vertical margins on `UserTurn` or the `AssistantTurn` root put the gap outside the
measurement and break TanStack Virtual's geometry. The hidden action row reserves its
height to prevent hover layout shift.

Card padding tokens are for card surfaces and sibling gaps; buttons and inputs keep
their component-size geometry.

## Which turns are finished

`continuesResponse` marks the turns with no action row: the next visible turn is another
assistant turn, the next turn is a writer turn the server stamped
`metadata.delivery: "steer"`, or this is the latest turn while background subagents still
run. Read the steer stamp rather than comparing timestamps.

A reply stopped before it produced anything also has no action row: there is nothing to
copy, and Hand off is already on the writer's message above it. Fork is not available at
that spot, an accepted cost. It carries no "Stopped" label and no Retry: a stop is deliberate, and Retry would
resend the same words.

## The action row

Copy takes `finalMessageItems` plus images. Markdown is the plain-text flavor and is
memoized. The HTML flavor renders only inside the click handler, through a module-level
pipeline that strips presentation properties on the HAST tree; a regex on serialized
HTML corrupts code text. Stripping `className` leaves copied KaTeX unstyled. Report
payloads stay in a fenced JSON block in both formats.

Info is `TurnInfoButton`, summarizing all assistant parts joined by `continuesResponse`,
excluding writer steer turns. Cache hit is summed `cacheReadTokens / inputTokens`: input
includes cache tokens, so cache writes are misses. Output speed sums output tokens and
`generationMs`. Don't derive speed from `latencyMs - timeToFirstTokenMs`: the server nulls
`generationMs` when backpressure made the measurement unreliable. "Stats for nerds" is
device-local (`lib/stats-for-nerds.ts`).

Debug opened from a reply's row scopes LLM Calls to every assistant part in that reply;
the pill always opens unscoped. Settled actions use the shared enabled boolean, so they
can't stay visible after debug is disabled.

## Control placement

Bare transcript rows don't right-align their controls: status dots, times, chevrons and
the subagent chat icon sit directly after the text, so the writer can see which row a
control belongs to. A card is the exception, because its border already binds the
controls to the row.
