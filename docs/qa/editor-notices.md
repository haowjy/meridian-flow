# Editor schema notices

Start the owned worktree with `pnpm dev` and discover its HTTPS URL with
`pnpm portless:list`. Sign in through `/api/auth/dev-login` and open a seeded
manuscript in the Editor.

A normal document does not produce schema notices. For a visual probe, intercept
only the browser's `SessionEditor.tsx` module response and supply fixture
`snapshot.schemaRepairs` and `snapshot.schemaFence` values before editability
is derived. Do not change stored documents or commit the fixture. Use an open
repair event with recovered prose, another without `removedText`, and a
`client-superseded` fence. This verifies presentation, not repair detection.

- The fence is an error NoticeCard with Refresh; the editor is read-only.
- The repair is an info NoticeCard with Dismiss. Recovered prose is readable
  in bounded scrolling boxes; missing prose says it could not be recovered.
- Both cards align with the toolbar and prose in a wide Editor and narrow dock.
- Copy reports Copied after a successful clipboard write. Simulate a refused
  second clipboard write in the browser and wait two seconds: the refusal
  must remain visible after the first copy's reset time.
- Dismiss removes the repair notice without affecting the fence.

Capture the affected surface, close the probe browser context to discard its
module interception, and stop only this worktree's stack with `pnpm dev --stop`.
