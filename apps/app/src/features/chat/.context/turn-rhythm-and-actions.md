## Turn rhythm and settled actions

`--chat-space-*`, `--chat-card-pad-*`, and `--chat-geometry-*` live on `:root`
because chat chrome and portaled menus (the independent chat header, composer
reference and command menus, Work pickers) render outside the chat subtree;
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
after a writer turn and 6px after the assistant's reserved action row. An
assistant turn whose next visible turn is also an assistant turn (a subagent
notification woke the model, with no writer message between) is one continuing
response: it renders no action row and its row pads only the 8px block gap. The
hidden action row still reserves its compact height to prevent hover layout
shift. Do not add vertical margins to `UserTurn` or the `AssistantTurn` root;
keeping the turn gap inside the measured row keeps TanStack Virtual's geometry
accurate. Assistant sections, receipts, and cards use one 8px parent gap;
fold-to-body and prose-to-action boundaries are separately owned by their
inner block and inline spacing respectively. Never stack a margin, padding,
and gap on one boundary.

Settled assistant turns have a quiet action row below all turn content. Copy
takes the turn's final message: the text and report items after its last
process fold (`finalMessageItems`), never thinking, tool rows, delivery events,
or earlier prose. Markdown is the plain-text flavor and is memoized; the HTML
flavor is rendered only inside the click handler through a module-level
unified pipeline that strips presentation properties on the HAST tree (never
by regex on serialized HTML, which corrupts code text). Stripping `className`
leaves copied KaTeX unstyled by design. Report payloads stay in a fenced JSON
block in both clipboard formats. The information popover summarizes
`Turn.responses`: input/output tokens are summed, cache hit is summed
`cacheReadTokens / inputTokens` (input includes cache tokens, so cache writes
are misses), TTFT is the first call's first-token time, and output speed sums
output tokens and `generationMs` across calls whose generation time the server
measured. Never derive speed from `latencyMs - timeToFirstTokenMs`; the server
nulls `generationMs` when backpressure made the measurement unreliable.
Speed and TTFT are omitted when they cannot be computed; cache hit is omitted
for zero input. No row ever reads "Unavailable". No Info button is rendered
until a turn has model responses.
Debug is gated by the shared debug store. Opening from a turn always sets the
LLM Calls scope; the pill always opens unscoped, and the viewer's Show all
control clears an active scope. Settled actions use the shared enabled boolean,
so they cannot remain visible after debug is disabled. The latest settled turn
keeps its row visible; older rows reveal actions on hover/focus and touch keeps
them visible. An open popover keeps its anchored row visible.
