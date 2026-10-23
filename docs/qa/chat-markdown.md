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
  rules, lists and quotes, except above a heading: 24px above h1 and h2, 16px
  above h3 to h6. Outer margins are zero.
- Task items draw a read-only checkbox (checked and unchecked) in both
  surfaces. Table headers without an alignment sit at the start of their
  column, not centered; aligned columns keep their alignment.

Streaming uses the same document renderer. Pace a mock reply's existing socket
messages (without changing content or sequence) in a browser capture to check:

- `**bol` renders bold in the tail, not flashing literal markers. Half links
  remain text and a table header stays text until its delimiter arrives.
- Blank lines inside an open fence do not settle code prematurely. Code text
  appears with every append; lowlight catches up within 50ms, never hiding words.
- Completed paragraphs and code DOM survive tail appends and turn settlement.
  A closed reply has the same spacing and markup before and after settlement.
- Repeat with loose/nested lists, longer tilde fences, reference definitions,
  source replacements, and leading blank lines. Each completed worker result must
  match one canonical whole-source parse of that text block.
- Put tool, report, and artifact items between text blocks. Each text block keeps
  its own worker stream, and a settled block is never submitted again.

Static reference/skill occurrence turns use the same canonical codec and document
renderer. Only exact authored link ranges may resolve to a document; adjacent
same-destination links must not acquire combined identity. Skills stay outside
code and rewritten/unmappable ranges remain ordinary Markdown.

Closed diagram fences draw through the Editor's sanitized provider boundary;
open fences stay source, including list/quote-contained fences. Verify that
quoted or four-space-indented delimiters inside a top-level fence stay literal
code. Checkboxes and ordinary bracketed text must not disable settled-block reuse.
Reference definitions follow the canonical full parse, including first-definition
precedence. Chat
images use the Editor's positive browser-source allowlist; unavailable sources
show their alt text without fetching an app-origin or disallowed URL.

Performance: `pnpm --filter @meridian/app bench:markdown` streams one 30,381-character,
5,071-word text block at 30 tokens/s. It reports synchronous main-thread React
commits, forced layout, and arrival-to-next-paint delay after the matching worker
result. It also measures 50-message and long-reply cold and cached mounts. Keep the
fixture and cadence unchanged for comparisons; do not run checks concurrently.

Focused contract checks:
`pnpm --filter @meridian/app exec vitest run src/rich-content/document-markdown.test.tsx src/rich-content/code-block.test.tsx`.
