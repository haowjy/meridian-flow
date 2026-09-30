## Turn rhythm and settled actions

`--chat-space-*`, `--chat-card-pad-*`, and `--chat-geometry-*` live on `:root`
because chat chrome and portaled menus (composer reference and command menus,
Work pickers) render outside the chat subtree;
scoping them to `text-tier-chat` collapses those surfaces to zero spacing.
Shared `prose-tokens` read independent `--prose-space-*` variables whose
`:root` defaults keep manuscript and other non-chat prose at their own values;
`text-tier-chat` alone remaps them to the chat scale. Never point a
`--prose-space-*` default at a chat token. The scale is inline and row 4px, block
8px, writer-turn 12px, and assistant-exchange 6px. The `chat-card` utility
bundles card padding, border, and radius; card padding is 12px horizontally and
8px vertically. Markdown paragraphs, lists,
blockquote, table, and code use the 8px block rhythm; list siblings use 4px,
h1/h2 start 24px above, h3-h6 16px above, and headings end 8px below. The
composer uses the same card padding and 4px chip/control gaps. Card padding
tokens are for card surfaces and sibling gaps, not buttons or inputs; those keep
their component-size geometry. The writer bubble pads 16px by 12px.

Every boundary has exactly one spacing owner. In particular, `TurnList`'s
measured `<li>` owns space between turns using padding inside the row: 12px
after a writer turn and 6px after the assistant's reserved action row. Only a
finished turn gets the action row: one the model ended with nothing to pick it
back up. `continuesResponse` (`transcript-model.ts`) marks the others, which
render no action row and pad only the 8px block gap: the next visible turn is
another assistant turn (a subagent notification woke the model), the next turn
is a writer turn the server stamped `metadata.delivery: "steer"` (enqueued while
this run was live), or this is the latest turn while background subagents still
run. Read the steer stamp; never compare client and server timestamps. A compaction divider between two parts
never ends the reply; the rule looks past it. Stopped
and failed turns are always finished. The
hidden action row still reserves its compact height to prevent hover layout
shift. Do not add vertical margins to `UserTurn` or the `AssistantTurn` root;
keeping the turn gap inside the measured row keeps TanStack Virtual's geometry
accurate. Assistant sections, receipts, and cards use one 8px parent gap;
fold-to-body and prose-to-action boundaries are separately owned by their
inner block and inline spacing respectively. Never stack a margin, padding,
and gap on one boundary.

A finished turn has a quiet action row below all turn content: Copy, Fork,
Hand off, Info, and Debug. Fork and Hand off appear only in a primary chat the
server already has (`canDeriveFrom`); a subagent's view shows neither. See
[fork and handoff](fork-and-handoff.md). Copy takes the
turn's final message: the text and report items after its last process fold
(`finalMessageItems`) plus its images, never thinking, tool rows, delivery
events, spawn cards, or earlier prose. Images copy as Markdown images, so the
HTML flavor carries real `<img>` elements. Markdown is the plain-text flavor and is memoized; the HTML
flavor is rendered only inside the click handler through a module-level
unified pipeline that strips presentation properties on the HAST tree (never
by regex on serialized HTML, which corrupts code text). Stripping `className`
leaves copied KaTeX unstyled by design. Report payloads stay in a fenced JSON
block in both clipboard formats. Info is `TurnInfoButton`, the one stats
popover for every turn: a compaction divider's Info uses it too (see
[compaction surfaces](compaction-surfaces.md)). The reply's popover summarizes
the whole writer-facing reply: all assistant parts joined by
`continuesResponse`, excluding any writer steer turns. Input/output tokens are
summed across those parts, cache hit is summed
`cacheReadTokens / inputTokens` (input includes cache tokens, so cache writes
are misses), TTFT is the first call's first-token time, and output speed sums
output tokens and `generationMs` across calls whose generation time the server
measured. Never derive speed from `latencyMs - timeToFirstTokenMs`; the server
nulls `generationMs` when backpressure made the measurement unreliable.
Speed and TTFT are omitted when they cannot be computed; cache hit is omitted
for zero input. No row ever reads "Unavailable". No Info button is rendered
until a turn has model responses.
Debug is gated by the shared debug store. Opening from a finished reply's action
row scopes LLM Calls to every assistant part in that reply; the pill always
opens unscoped, and the viewer's Show all control clears an active scope.
Settled actions use the shared enabled boolean,
so they cannot remain visible after debug is disabled. The latest finished turn
keeps its row visible; older rows reveal actions on hover/focus and touch keeps
them visible. An open popover keeps its anchored row visible.

Bare transcript rows never right-align their controls. Status dots, times,
disclosure chevrons, and the subagent chat icon sit directly after the row's
text, so the writer can see which row a control belongs to. This holds for
activity rows in the process fold and for subagent lines. A card is the one
exception: its border already binds the controls to the row, so a subagent
launch card spans its width, truncates the description, and ends in the time,
chevron, and chat icon.
