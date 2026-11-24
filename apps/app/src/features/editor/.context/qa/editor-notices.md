# Editor schema fence

Start the owned worktree with `pnpm dev` and discover its HTTPS URL with
`pnpm portless:list`. The stack runs with `DEV_AUTH_BYPASS=1`, so the app opens signed in. Open a seeded
manuscript in the Editor.

A normal document has no fence. For a visual probe, supply a fixture
`snapshot.schemaFence` (a `client-superseded` fence) to `ActiveSessionEditorView`
before editability is derived. Use a local, uncommitted wrapper in
`SessionEditor.tsx` switched by a `localStorage` key; do not change stored
documents or commit the fixture.

Check at a wide Editor (1280px), the side panel, and a 390px phone width:

- The fence is one error line, "Editing paused", with Refresh, above the toolbar and aligned
  with it; the editor is read-only. At phone width the sentence may wrap but is never cut off.
- Refresh reloads the page. Under a coarse pointer it is a 44px target without making the bar
  taller.
- With no fence, no empty gap shows above the toolbar.

Capture the affected surface, remove the fixture, close the probe browser
session, and stop only this worktree's stack with `pnpm dev --stop`.
