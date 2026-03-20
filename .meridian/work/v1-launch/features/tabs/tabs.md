# Tabs

Multi-tab document management with hybrid mounting for performance.

## Scope

- Tab strip with document names
- Preview tabs (single-click from explorer, replaced by next preview)
- Persistent tabs (double-click or edit, stays open)
- Close tab (click X, middle-click)
- Tab reorder via drag
- Path disambiguation for duplicate names (show parent folder)
- Overflow: scroll + dropdown for many tabs

## Hybrid Mount (LRU)

- Keep 2-3 recent CM6 + Y.Doc + WebSocket sessions alive
- Evict full document session (CM6 + Y.Doc + WebSocket) when LRU limit reached — not just CM6
- Reconnect on navigate-back (Y.Doc reloads from y-indexeddb, WebSocket reconnects)

## Carry Forward

- Existing tab state in `useEditorStore.ts`
- Existing document mounting/unmounting

## Key Decision

Tab model must scale to 100+ chapter projects. Preview-tab pattern prevents tab strip churn from browsing. Path disambiguation prevents confusion from duplicate filenames (notes.md, outline.md common across arcs).

## Dependencies

- Explorer (tab creation on file open)
- Editor (CM6 instance per tab)
- Design system (tab strip components)
