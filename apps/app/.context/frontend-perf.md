# Frontend performance traps

## Long-lived layouts

`shouldReload: () => true` refetches the layout loader on every navigation,
including search-param changes, and turns `staleTime` into dead config.

Clock-driven seed values (`now` for relative-time labels) come from a local timer
in the provider, not route-loader refetches. The loader may seed the initial
value for SSR.

## Editor loading

The basic `EditorView` is a static dependency of the project hosts, so a loaded
empty workspace can start local writing offline. Chat-only visits pay for the
earlier editor-code load, and cold offline boot isn't covered. Add new heavy
editor or collaboration dependencies to the matching `manualChunks` bucket.

## Streaming chat

Chapter-length streaming is O(n) per token if the whole answer re-parses and the
transcript re-lays out on every chunk.

- Text and reasoning deltas coalesce into one store update per animation frame
  (`StreamDeltaCoalescer`). Any other event, or a delta for a different message,
  flushes first.
- Auto-follow pins from cached heights, not a layout read per revision.
