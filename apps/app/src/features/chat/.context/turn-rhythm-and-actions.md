# Turn rhythm and settled actions

The design is
[Chat Thread Rhythm](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/chat/transcript.md)
and
[Finished Turns Carry Actions](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/chat/turns.md).

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

## Edit after Stop

The writer's message above the chat's latest reply carries Edit when the writer stopped that
reply (`cancelled`) and nothing closing follows it (`movedPast`); `findStoppedMessageId` in
`TurnList.tsx` decides which message. Only that one: an older stopped reply's message is history,
and the newest message is the one the writer would fix. A steer inside the reply makes the steer
the message. Edit reads the stored blocks back through `userMessageBlocksFromTurn` and
`composerDocFromHandedBack`, the same path a hand-back takes, so chips come back as chips, and
puts them above what is typed through the draft owner's `putBack`. Every way words come back
into a box (hand-back, a refused send's Edit, a deleted chat's transfer, Edit after Stop) goes
through its one builder, `withReturned`: returned words above typed ones, one restorability check,
the caret at the end of the returned words. The message and the stopped reply stay; Edit carries no
receipt, so a second press puts the words back again. Branching an edited message (#628) is a
different feature.

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

Bare transcript rows don't right-align their controls: status dots, times and the
subagent chat icon sit directly after the text, and a fold's chevron leads it (`FoldToggle`), so the writer can see which row a
control belongs to. A card is the exception, because its border already binds the
controls to the row.
