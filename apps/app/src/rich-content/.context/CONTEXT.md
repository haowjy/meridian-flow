# rich-content — rendering pipeline

## Parsing and streaming

Each assistant text block uses its permanent render key as the stream identity. The
worker coalesces queued updates per stream and sends content keys for every block, but
JSON only for blocks that stream hasn't received. An open fence always travels as a
top-level block plus descendant path, so identical and nested code blocks stay distinct.

The main thread ignores stale sequence and generation results, keeps the last completed
render while a newer parse runs, and releases worker state when the text block settles
or unmounts. Settlement reuses equal worker nodes by position, preserving mounted code
and diagram components. Chat mounts prewarm the module worker before a reply starts.

## Writer occurrences

Exact complete link ranges grant reference identity; skills have to fit entirely inside
one mapped text run outside code. The codec maps an authorized source subrange to
displayed text offsets, and the app doesn't decode Markdown to reconstruct them.
Invalid, rewritten, cross-run or mismatched ranges stay ordinary Markdown. No source map
enters the worker streaming path.

An occurrence is keyed `kind:id` (`referenceKey`) in the answers
`useReferenceAvailability` reads from the replay. A document chip follows only while its current URI equals the authored one; a
folder chip has no such gate, because it follows the folder by ID.

## Shared Editor pieces

The walker handles the Markdown codec's nodes, not MDX figure or JSX editing views.
Copy-as-HTML keeps its separate sanitized clipboard pipeline in
`features/chat/assistant-turn-copy.ts`.
