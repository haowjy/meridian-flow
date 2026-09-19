# Frontend performance traps

Recurring load-bearing choices for `apps/app` (React 19 + Vite + TanStack Router).

## Do not force-reload long-lived layouts

`shouldReload: () => true` refetches the layout loader on every navigation,
including search-param changes, and makes `staleTime` dead config. `staleTime`
is the freshness gate. `src/router-shell.ts` uses
`shouldReload: ({ cause }) => cause !== "stay"`.

Clock-driven seed values (`now` for relative-time labels) must not piggy-back
on route-loader refetches. Drive them from a local timer in the provider
(`ThreadStoreProvider`, `ProjectStoreProvider`); the loader may still seed the
initial value for SSR.

## EditorView is a static host dependency

The basic `EditorView` is a static dependency of the project hosts, not a lazy
chunk fetched on first New/open. A loaded empty workspace must be able to start
local writing offline; that costs earlier editor-code loading for Chat-only
visits. It does not provide cold offline application boot. See
[`src/features/project/.context/CONTEXT.md`](../src/features/project/.context/CONTEXT.md).

Vite `build.rollupOptions.output.manualChunks` still splits the heavy vendor
trees: `collab-yjs` (`yjs`, `y-protocols`, `y-prosemirror`), `editor-tiptap`
(`@tiptap`, `prosemirror-*`), `collab-transport` (`@hocuspocus`). Add new heavy
editor or collaboration dependencies to the matching bucket.

## Streaming chat: per-block memo, one update per frame, pin from cache

Chapter-length streaming is O(n) per token if the whole answer re-parses and
the transcript re-layouts on every chunk.

1. Keep Streamdown's per-block memo. Do not merge adjacent markdown blocks.
   Pin `streamdown` at 2.6.0 or later.
2. Coalesce append-only text and reasoning deltas into one store update per
   animation frame (`StreamDeltaCoalescer`). Any other event, or a delta for a
   different message, flushes first.
3. Pin auto-follow from cached heights. Follow vs free is an explicit state
   machine, not a per-frame geometry test.

See [Assistant Turns Are Process, Text, and Artifact](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/turns/chat-turn-process-text-artifact.md)
and [Chat Follow State Is Policy, Not Geometry](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/chat-scroll-follow-state.md).
