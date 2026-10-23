# rich-content — rendering pipeline

The current implementation behind the invariants in [`../AGENTS.md`](../AGENTS.md).

## Typography and rhythm

`styles/document.css` owns document typography, block surfaces, task-item
checkboxes, table headers and lowlight colors for both chat and the manuscript.
Chat keeps its smaller reading tier (`--text-scale-chat`) and 4px between list
rows; the manuscript keeps its own block rhythm. Chat puts 8px between top-level
blocks. Headings follow the [chat rhythm][chat-rhythm]: h1 and h2 open 24px
above, smaller headings 16px, and the next block closes them at 8px.

## Parsing and streaming

Static and streaming text use the same PM-node memoized block components. One
document snapshot owner holds parse requests, identity reconciliation, settled
caches and open-code paths. Its parse session runs through a module-worker
adapter in the browser, and a synchronous adapter for SSR, tests and worker
failure. Each assistant text block uses its permanent render key as the stream
identity. The worker coalesces queued updates per stream and sends content keys
for every block, but JSON only for blocks that stream hasn't received. An open
fence always travels as a top-level block plus descendant path, so identical
and nested code blocks stay distinct.

The main thread ignores stale sequence and generation results, keeps the last
completed render while a newer parse runs, and releases worker state when the
text block settles or unmounts. Streaming settlement reads the same snapshot
owner and reuses equal worker nodes by position, preserving mounted code and
diagram components. Every settled text block is cached by its full source;
there is no blank-line splitter or inferred fence state.

Current limits: open-fence highlights are throttled at 50 ms, and bounded source
caches keep settled PM trees and code colors across virtual-row remounts (256
entries and 250,000 key characters each). Chat mounts prewarm the module worker
before a reply starts. A browser worker failure reports once to the console
before synchronous parsing takes over; SSR and tests start on the synchronous
path without reporting a failure.

## Writer occurrences

Static user turns with occurrences parse once with the canonical codec's opt-in
presentation source map. Exact complete link ranges grant reference identity;
skills must fit entirely inside one mapped text run outside code. The codec maps
an authorized original-source subrange to displayed text offsets; the app never
decodes Markdown to reconstruct them. Invalid, rewritten, cross-run or
mismatched ranges stay ordinary Markdown. Projection is app-owned: never match
displayed labels or store presentation schema attrs. No source map enters the
worker streaming path.

## Shared Editor pieces

The walker handles the Markdown codec's nodes, not MDX figure or JSX editing
views. Chat images share the Editor's `browserPictureSource` allowlist; a
rejected source shows alt text without a fetch. Closed diagram fences use the
Editor's provider catalog, render hook and sanitized SVG faces (Mermaid loads
lazily); an open fence stays code, even at settlement. Code copy shows only on
hover or focus within the block. External links open in a new tab and share the
Editor's outbound marker; internal chips stay unchanged. Copy-as-HTML keeps its
separate sanitized clipboard pipeline in `features/chat/assistant-turn-copy.ts`.

[chat-rhythm]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/writer-ux/chat-thread-rhythm.md
