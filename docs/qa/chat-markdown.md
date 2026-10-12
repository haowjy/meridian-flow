# Chat document rendering

Start an owned stack with `MODEL_PROVIDER=mock pnpm dev`, discover its app URL
with `pnpm portless:list`, then use `./mf doc put` and a scoped `./mf mock script`
to place the same Markdown in a manuscript and a settled assistant reply.
Include nested and ordered lists, a quote, a table with aligned cells, inline
marks, a link, and a TypeScript fence.

Check desktop and 390px in light and dark:

- The editor has not changed. Chat keeps 14px body text against the editor's
  16px default, with 4px between list rows and no paragraph gaps inside them.
- Quotes have the editor's jade border. Tables have cell rules, not an outer card.
- Code has lowlight colors and no language header or download action. At the
  default scales, its font is 11.375px in chat and 13px in the editor.
- The code copy button is hidden at rest, appears on hover or keyboard focus,
  and copies only the source, not token markup. Clipboard failure never reports
  success. External links open a new tab and retain the outbound arrow. Internal links use
  the same document-family chips as the Editor.
- Every top-level block pair has an 8px gap, including table/code wrappers,
  rules, headings, lists and quotes. Outer margins are zero.

Streaming uses the same document renderer. Pace a mock reply's existing socket
messages (without changing content or sequence) in a browser capture to check:

- `**bol` renders bold in the tail, not flashing literal markers. Half links
  remain text and a table header stays text until its delimiter arrives.
- Blank lines inside an open fence do not settle code prematurely. Code text
  appears with every append; lowlight catches up within 50ms, never hiding words.
- Completed paragraphs and code DOM survive tail appends and turn settlement.
  A closed reply has the same spacing and markup before and after settlement.
- Repeat with loose/nested lists, longer tilde fences, reference definitions,
  source replacements, and leading blank lines. They retain canonical parsing.

Reference/skill occurrence turns still use Streamdown at this migration stage.
Diagrams remain source. Those migrations belong to the next phase.

Performance: `pnpm --filter @meridian/app bench:markdown` runs 4,000 whitespace
chunks at 30/s and measures synchronous React commits with forced layout. Keep
this fixture/cadence unchanged for comparisons; do not run checks concurrently.

Focused contract checks:
`pnpm --filter @meridian/app exec vitest run src/rich-content/document-markdown.test.tsx src/rich-content/code-block.test.tsx`.
