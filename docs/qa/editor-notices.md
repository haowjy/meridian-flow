# Editor schema notices

Start the owned worktree with `pnpm dev` and discover its HTTPS URL with
`pnpm portless:list`. Sign in through `/api/auth/dev-login` and open a seeded
manuscript in the Editor.

A normal document does not produce schema notices. For a visual probe, supply
fixture `snapshot.schemaRepairs` and `snapshot.schemaFence` values to
`ActiveSessionEditorView` before editability is derived: a local, uncommitted
wrapper in `SessionEditor.tsx` switched by a `localStorage` key works, as does
intercepting the browser's `SessionEditor.tsx` module response. Do not change
stored documents or commit the fixture. Use an open repair event with recovered
prose (long enough to scroll), one without `removedText`, a second short one,
and a `client-superseded` fence. This verifies presentation, not repair
detection.

Check at a wide Editor (1280px), the side dock, and a 390px phone width:

- The fence is one error line, "Editing paused. This chapter needs a newer
  version of Meridian.", with Refresh; the editor is read-only. At 390px the
  sentence may wrap to two lines but is never cut off.
- The repair is one line, "Some text was removed", with Details and no X.
  With both, the two lines stack above the toolbar, aligned with it.
- Details opens a popover over the page, as wide as the bar (at most 30rem), so
  in the side dock it stays inside the pane; the manuscript does not move. It
  lists each rescued passage with Copy, "This passage couldn't be recovered." in
  its own box in place of the missing one, then the cause line and Dismiss. Shrink the viewport
  height to about 300px: the popover stays inside the viewport and scrolls.
- Keyboard: focus Details and press Enter; focus lands on the first Copy. Tab
  reaches each Copy and Dismiss. Escape closes and returns focus to Details.
- Replace `navigator.clipboard.writeText` with a rejecting function and press
  Copy: "Couldn't copy. Select the text to copy it." appears under that
  passage. After a successful copy, a refusal within 1.5 s must stay visible
  after the Copied reset time.
- Dismiss (by keyboard) removes the repair line, leaves the fence, and leaves
  no empty gap above the toolbar when it was the only notice. Focus goes to the
  editor, or to Refresh while the fence holds the editor read-only.
- After Dismiss, a new repair brings the bar back; Details then Escape returns
  focus to Details again.

Capture the affected surface, remove the fixture, close the probe browser
session, and stop only this worktree's stack with `pnpm dev --stop`.
