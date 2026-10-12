# Settled chat document rendering

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
  success. External links open a new tab.

Streaming and reference/skill occurrence turns still use Streamdown at this
migration stage. Their visual differences are not a settled-renderer regression.

Focused contract checks:
`pnpm --filter @meridian/app exec vitest run src/rich-content/document-markdown.test.tsx src/rich-content/code-block.test.tsx`.
