# rich-content

`Markdown` uses `DocumentMarkdown`: the shared markup codec and a React
walker, with no editor instance ([decision][chat-rendering]). `styles/document.css`
owns document typography, block surfaces, task-item checkboxes, table headers and
lowlight colors for both chat and the manuscript. Chat retains its smaller reading
tier (`--text-scale-chat`) and 4px between list rows; the manuscript retains its
existing block rhythm.

Chat puts 8px between top-level blocks and keeps the owner-approved
[chat rhythm][chat-rhythm] for headings: h1 and h2 open 24px above, smaller
headings 16px, and the next block closes them at 8px.

Static and streaming use the same source-keyed memoized block components. Only the
live tail is repaired with remend and reparsed as tokens arrive. Blank lines outside
fences delimit conservative render units; loose list/quote/indented continuations
stay together. Link reference definitions (not checkboxes or ordinary bracketed text) and raw HTML outside fences retain whole-document parsing
because later source can change earlier blocks. Open-fence highlights are throttled
at 50ms; fresh text is always visible immediately. Settlement keeps the same DOM tree.
Bounded source caches retain settled PM trees and code colors across virtual-row
remounts (256 entries and 250,000 key characters each); live tails are not retained.

Static user turns with occurrences parse once with the canonical codec's opt-in
presentation source map. Exact complete link ranges grant reference identity;
skills must fit entirely inside one mapped text run outside code. Invalid,
rewritten, cross-run, or mismatched ranges stay ordinary Markdown. Projection
is app-owned: never match displayed labels or store presentation schema attrs.
No source map enters the streaming path.

The walker handles the Markdown codec's nodes, not MDX figure/JSX editing views.
Fence indentation is relative to the tracked list/quote container; literal delimiters
inside code cannot close another container's fence. Chat images share the Editor's
`browserPictureSource` allowlist; rejected sources show alt text without a fetch.

Closed diagram fences use the Editor's provider catalog, render hook and sanitized
SVG faces (Mermaid loads lazily). An open fence stays code, even at settlement.
Code copy is visible only on hover or focus within the block. External links
open in a new tab and share the Editor's outbound marker; internal chips stay
unchanged. Copy-as-HTML keeps its separate sanitized clipboard pipeline in
`features/chat/assistant-turn-copy.ts`; its characterization tests pin the output.

[chat-rendering]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/chat-markdown-document-rendering.md
[chat-rhythm]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/chat-thread-rhythm.md
