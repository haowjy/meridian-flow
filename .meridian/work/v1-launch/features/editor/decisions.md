---
detail: standard
audience: architect, developer
---

# Editor Architecture Decisions

Key design decisions for the CM6/Yjs editor refactor, with rationale. These explain **why** the architecture is shaped the way it is — the constraints that forced each tradeoff and what would break if you changed it.

## D1: Y.Doc as Single Source of Truth ("Yjs-first")

**Decision:** Y.Doc owns the document, not React state, not the server, not CM6. CM6 renders it. IDB persists it. WebSocket syncs it.

**Why:**

- Meridian is a collaborative writing platform — every edit is a CRDT operation. Building a non-CRDT path alongside a CRDT path creates two content models that must be kept in sync, which is a perpetual source of bugs.
- The v2 collab model (proposals, projection, undo, compaction) is built around text-level Yjs operations. The AI proposal pipeline creates Yjs binary updates (`yjsUpdate: Uint8Array`), diffs them against canonical state, and derives decoration hunks. A non-Yjs content path cannot participate in this pipeline.
- Offline-first requires a CRDT. Without Y.Doc persistence to IndexedDB, there's no way to accumulate edits offline and merge them on reconnect without manual conflict resolution.
- Yjs sync protocol gives us "open document → load from IDB → instant content → sync in background" for free. A controlled React editor would need a separate offline cache, a separate reconciliation layer, and a separate conflict resolution strategy.

**What would break if changed:** The entire collab pipeline (proposals, projection, offline accept/reject, undo) assumes Y.Text is the canonical model. Switching to React-controlled state would require rebuilding all of these from scratch, plus adding a separate persistence/sync layer.

## D2: No `value` Prop — CM6 Is Uncontrolled

**Decision:** The Editor component has no `value` or `onChange` props. Content flows through Y.Text, not React state.

**Why:**

- CM6 + yCollab share bidirectional ownership of the document. The `yCollab` extension from `y-codemirror.next` keeps `EditorState.doc` and `Y.Text` in sync automatically. Adding a React `value` prop creates a third owner that fights the other two.
- A controlled component pattern requires a reconciliation effect: when `value` changes, replace the CM6 document. Full-document replace (`from: 0, to: doc.length`) destroys decoration state, selection state, and causes full reflow. Diff-based reconciliation (`ChangeSpec` entries) is possible but redundant — Yjs already does this via its sync protocol.
- The pre-refactor Editor had `value`/`onChange` which duplicated the extension assembly path between `Editor.tsx` and `createMeridianExtensions()`. Review finding (p546, segment 13, message 7): "Two extension assembly paths (`Editor.tsx` vs `createMeridianExtensions`) create drift risk." The uncontrolled design eliminates this duplication — one `createEditorExtensions()` function, one content model.
- For standalone editors (stories, simple embeds), `Editor` creates a local `Y.Doc` internally and exposes it through `sessionRef`. Parents read content via `sessionRef.current?.ytext.toString()` or observe changes via `ytext.observe()`. This keeps the same API regardless of collab mode.

**What would break if changed:** Re-adding `value` would require either (a) a reconciliation effect that races with yCollab, or (b) disabling yCollab for non-collab editors, which re-creates the two-path problem the refactor eliminated.

## D3: Always Y.UndoManager — No CM6 History

**Decision:** Every editor instance uses `Y.UndoManager` for undo/redo. CM6's built-in history extension is never loaded. Even standalone local editors use a local `Y.UndoManager`.

**Why:**

- CM6 history and Y.UndoManager track different things. CM6 history records `ChangeSet`s against `EditorState.doc`. Y.UndoManager tracks Yjs struct operations. Running both simultaneously causes undo to sometimes revert a CM6 change and sometimes a Yjs change, producing unpredictable behavior.
- The pre-refactor code had a compartment swap — CM6 history when offline, Y.UndoManager when collab was active. This swap was a frequent source of bugs: undo history was lost on mode transition, and the swap timing had to be carefully coordinated with collab session lifecycle. The refactor eliminated this by making Yjs the always-on model.
- Y.UndoManager supports tracked origins (`ORIGIN_HUMAN`, `ORIGIN_ACCEPT`, `ORIGIN_REJECT`, `ORIGIN_THREAD`), which is required for the proposal pipeline: when a user accepts an AI proposal, the accept operation gets `ORIGIN_ACCEPT` so it groups correctly in undo history and doesn't get mixed with typing. CM6 history has no equivalent concept.
- `Prec.high(keymap.of(yUndoManagerKeymap))` is installed before `defaultKeymap` so Mod-z/Mod-y are intercepted by Y.UndoManager, not CM6's default undo bindings.
- Fewer runtime compartments. No undo compartment swap means the extension stack is simpler and there are fewer reconfiguration paths to test.

**What would break if changed:** Proposal accept/reject undo grouping (`ORIGIN_ACCEPT`/`ORIGIN_REJECT`) would not work with CM6 history. The compartment swap would re-introduce mode-transition undo loss. Two undo systems running simultaneously would produce unpredictable behavior.

## D4: SessionPool + ViewController Split

**Decision:** Document lifecycle (Y.Doc, IDB, WebSocket, awareness) is owned by `SessionPool` via `DocSession` objects. View lifecycle (EditorView creation, CSS show/hide, LRU eviction, scroll restore) is owned by per-surface `ViewController` instances.

**Why:**

- Meridian has two editor surfaces: Studio (tabbed main editor) and Converse (sidebar editor). Both can be mounted simultaneously and may target the same or different documents. If each surface owned its own Y.Doc, opening the same document in both would create two Y.Docs racing on the same IDB database and WebSocket connection.
- `SessionPool` is the single owner of document-scoped resources. It creates at most one `DocSession` per document ID. Both surfaces borrow from the same pool. This makes the "same doc in two places" problem a coordination problem (lease transfer) rather than a consistency problem (two divergent CRDTs).
- `ViewController` is per-surface because each surface has independent state: which doc is active, which tabs are open, scroll positions, eviction order. These are view concerns, not document concerns.
- The split maps cleanly to the dependency inversion principle: `SessionPool` depends on document abstractions (Y.Doc, IDB, WebSocket). `ViewController` depends on view abstractions (EditorView, DOM container). Neither depends on the other's internals. The only coupling is the borrow/release protocol.
- `useDocumentSessions()` is the React hook that wraps one `ViewController` instance. Studio and Converse each get their own hook instance, sharing the same `SessionPool` from context. This gives React components a clean, surface-local API without exposing cross-surface coordination.

**What would break if changed:** Merging session + view ownership into a single object would either (a) duplicate Y.Docs when both surfaces open the same doc, causing IDB/WebSocket races, or (b) require the single object to manage both surfaces, violating SRP and making the lease transfer logic much harder to reason about.

## D5: Single Active View Per DocSession

**Decision:** A `DocSession` allows at most one active `EditorView` at a time, enforced by `attachedViewCount: 0 | 1`. If Studio and Converse both target the same document, one must detach before the other attaches (lease transfer).

**Why:**

- Yjs awareness is local-state-per-Y.Doc, not per-view. Two simultaneous live `yCollab` views for the same Y.Doc would race on the same cursor/selection payload in awareness. User A's cursor would flicker between the Studio position and the Converse position as each view overwrites the other's awareness state.
- The `yCollab` extension binds to a specific `Y.Text` and `Awareness` instance. Having two EditorViews with two `yCollab` bindings pointing at the same `Y.Text` would cause each edit to be observed twice by the other view (echo), requiring `origin === this` guards that are fragile and not part of the `y-codemirror.next` public API contract.
- Per-surface awareness multiplexing (separate awareness channels per surface) was explicitly rejected: "We explicitly do not build per-surface awareness multiplexing for this refactor because the UX value is low and the complexity is high." The common case is editing in one surface at a time. Seeing your own cursor in the other surface provides no useful information.
- Lease transfer is a simple atomic operation: clear awareness on old surface → detach old view → attach new view → publish awareness from new view. No concurrent state to manage.

**What would break if changed:** Allowing two live views would require either (a) per-surface awareness multiplexing (significant complexity for no UX value), or (b) accepting cursor flicker and edit echo between surfaces.

## D6: Two-Tier Eviction

**Decision:** View eviction (tier 1) and session eviction (tier 2) are separate, with different owners, budgets, and triggers.

**Why:**

- **Tier 1 (view eviction)** — per `ViewController`, LRU, max ~6 live EditorViews per surface. When a surface has too many open tabs, the least-recently-used EditorView is destroyed (DOM removed, CM6 state released). But the `DocSession` stays alive in the pool — Y.Doc, IDB persistence, and WebSocket connection remain active. This means:
  - Remote edits continue flowing into the Y.Doc while the view is gone.
  - Restoring an evicted tab rebuilds EditorState from the current `Y.Text`, reflecting all background changes, not stale CM6 state.
  - Reopen is fast (~100ms) because IDB and WebSocket are already connected.

- **Tier 2 (session eviction)** — `SessionPool`, idle timeout (~5 min), warm budget cap (~10 sessions). When all views for a document are closed and no local changes are pending, the session enters a warm idle state. After the timeout (or if the warm budget is exceeded), the pool destroys Y.Doc + WebSocket. IDB data persists for the next cold open.
  - The warm window exists because users frequently close a tab and reopen it within minutes. Keeping the session alive avoids a cold reconnect.
  - The budget cap prevents resource exhaustion. A writer with 30+ chapters open shouldn't keep 30 WebSocket connections alive.
  - The generation guard prevents a stale idle timer from destroying a re-borrowed session. Each borrow/release/preload increments `DocSession.generation`. When the timer fires, it only destroys if the generation is unchanged — meaning no activity has occurred since the timer was set.

**Why not single-tier:**
- If evicting a view also destroyed the session, switching between Studio tabs would require a cold IDB → WebSocket → sync cycle every time. With 100+ chapter serials, this would make tab switching unacceptably slow.
- If sessions never evicted, a writer who opened and closed 50 chapters in a session would have 50 active WebSocket connections and 50 live Y.Docs consuming memory.
- The two tiers map to natural lifecycle boundaries: "user isn't looking at this doc" (view eviction) vs "user has moved on from this doc" (session eviction).

**What would break if changed:** Single-tier eviction forces a choice between slow tab switching (destroy everything) and unbounded resource usage (destroy nothing). The two-tier design gives fast reopens within the warm window while bounding long-term resource consumption.

## D7: One Extension Stack

**Decision:** A single `createEditorExtensions()` function assembles the CM6 extensions. Every EditorView in the app — stories, Studio tabs, Converse sidebar — uses the same stack.

**Why:**

- The pre-refactor code had two extension assembly paths: `Editor.tsx` (inline stack for the React component) and `createMeridianExtensions()` (shared helper for stories and direct EditorView construction). Review finding: these drifted — one path would get a fix, the other wouldn't. Extension ordering bugs (e.g., keymap precedence, compartment registration order) surfaced only in one path.
- One function means one place to audit extension ordering, one place to add new extensions, one place to verify `Prec.high(yUndoManagerKeymap)` is before `defaultKeymap`.
- The function takes a config object with the minimum required inputs: `ytext`, `awareness`, `undoManager`, `compartments`. Everything else (readOnly, placeholder, livePreview, extra) has sensible defaults. The caller's responsibility is limited to providing Yjs resources and compartments.
- `createLocalEditorSession()` provides Yjs resources for standalone use, so even story editors go through the same extension builder. The old `createMeridianExtensions()` compatibility export was removed — "Rip the bandage off now while the callsite set is still small."

**What would break if changed:** Re-introducing a second extension path would re-create the drift problem. Any extension ordering fix or addition would need to be applied in two places.

## Cross-References

- [Editor Refactor Design](./editor-refactor-design.md) — full architecture spec these decisions implement
- [Editor Strategy](./editor-strategy.md) — why CM6 over ProseMirror/Tiptap, why not full WYSIWYG
- [CM6 Architecture](./cm6-architecture.md) — current extension stack, compartments, tab system
- [Editor Direction](./editor-direction.md) — decoration layers, preview/edit mode
- [Implementation Plan](../../plan/editor-refactor-implementation.md) — execution phases and agent staffing
