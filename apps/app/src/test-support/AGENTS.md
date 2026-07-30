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

## Green tests are quiet

A warning on a passing run trains readers to ignore stderr. If a fixture makes
ProseMirror, React, or jsdom complain, the fixture is wrong — fix it there
rather than in the assertion. Real waits are the same kind of debt: drive a
clock, do not sleep past one.
