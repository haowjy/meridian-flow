# test-support

Shared fixtures for app tests. Nothing here is production code, and nothing
here is a place to park a lane's own document — a fixture that only one suite
uses belongs in that suite, where the claim can be read next to it.

## Pick the cheapest editor tier the claim allows

- **`standalone-editor.ts`** — one editor, in the page, plus node-position
  queries. The default. Reach for it for anything one writer does alone.
- **`react-editor.tsx`** — a React root over that editor, for chrome,
  surfaces, and node views. Owns the act environment, mount order, and
  teardown order. It can borrow an editor a test already has.
- **`collab-editors.ts`** — two editors over one document. Only when the claim
  names a peer: y-prosemirror rebuilds the whole ProseMirror document on a
  remote write, which no hand-built transaction reproduces, and paying for that
  binding elsewhere makes local behavior depend on its mount sequence.

Undo is the exception that looks like a peer: on a shared document it is the
Yjs UndoManager, so a suite asserting undo mounts the pair for the document
rather than for the collaborator.

Every tier mounts the editor in a manuscript pane, positioned and clipping like
the app's (`EditorSurfaceFrame`), because measured chrome resolves against the
nearest positioned ancestor and is taken off the page by that element's
overflow. Never hand-roll a second one: a bare `data-stable-layout-scroll`
marker satisfies every lookup while being none of the things the lookup was
asking about, and a suite standing on it cannot fail the way the app does.
Neither can it see clipping — jsdom lays nothing out, so what is only PART
visible is a browser question and belongs in a probe.

## Review fixtures

- **`draft-review-scope.tsx`** — real presented-review, Chat and third-Work scopes,
  controllers, query cache, mutations and header model. `createReviewScopeFixture`
  installs test-lifetime network spies and account dependency seams; always
  dispose it after the render finishes, and do not use concurrent tests with it.
  `deferredReviewAnswer` holds each request independently. Pass scenario Works
  and identities to `render`; mount actual document/phone/Work UI through
  `surface`, and the chat strip through `chatSurface`. `host` wraps those scopes
  inside the query provider for shell providers. The default removal coordinator
  uses the real tab workspace; pass an owned coordinator for route coordination.
  The default detached sessions supply room subscriptions, never a
  delivery or editor-paint witness. Supply a session registry and mounted editor
  when claiming those outcomes. Existing consumers may still supply their own
  network/account seams to `renderReviewScopes`; importing the helper installs
  nothing. Keep surface-only setup and scenario data in their suites.
- **`branch-handoff-harness.ts`** — real branch sessions, pool and
  `BranchWriterHandoff` over `HeldBranchTransport`, a wire whose sync and
  acknowledgements the test controls. That wire stores local bytes before it
  announces them, so it cannot witness transport ordering. For a claim about
  when pending writing becomes observable, pass a real Hocuspocus transport
  over `core/transport/test-support/DocumentSocketHarness` through its
  `transportFactory` (it replaces the wire for generation-1 rooms only). The
  fake's order hid a live review failure through two fixes.
- **`editor-sessions.ts`** — instance-owned real detached document sessions;
  await `dispose()` after unmount. Tests may hold public horizons locally.
- **`editor-shell.tsx`** — explicitly installed/disposed neutral EditorView shell
  dependencies. Supply the registry; paint readiness and transport faults stay
  local, and the live-change suite keeps real inline synchronization.
- **`react-dom-harness.tsx`** — root teardown and bounded `settleReact` assertions
  under real or fake timers. Review-scope fixtures own query notification `act`.
- **`inline-review-editor.ts`** — a real collaborative editor with the
  inline-review extension, for claims about marks, removal widgets, folds, focus
  and the bar slot.

## Order independence

Shuffle before calling a fixture isolated: run the touched suites with
`--sequence.shuffle --sequence.seed=<n>` for more than one seed. Module-level mock
histories reset in one `describe` leak into the next; give each mount its own
fixture instead.

## Green tests are quiet

A warning on a passing run trains readers to ignore stderr. If a fixture makes
ProseMirror, React, or jsdom complain, the fixture is wrong — fix it there
rather than in the assertion. Real waits are the same kind of debt: drive a
clock, do not sleep past one.
