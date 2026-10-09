# Document pane continuity

`PaintHold` retains the last finished pane while a visible loading surface is
pending. It owns no route, review, room or launch state. Tabs, URL and breadcrumb
navigate at the click outside the frame. Destination failures are terminal and
release the hold. The patience bound is 10 seconds from the first capture;
another move never extends it. Preloading and a shorter bound belong to #740.

Only a finished, painted surface can replace the last-painted snapshot. A
pending-token retirement gap retains it; loading/status content cannot become
the copy. A failure is finished content and releases the hold.

A component that switches the pane between finished and loading content renders
`PaintCapture` keyed by what it chose, with `state="pending"` for loading,
`state="failed"` for errors, or `state="painted"` (the default) for finished content. Include precursor commits: an incoming
proposal projects loading in review chrome before the room observation dispatch.
The snapshot survives until a finished surface replaces it, the writer leaves,
or the bound expires. Synchronous precursor commits reuse the same snapshot;
the next animation frame admits a replacement only if the pane is finished.

Capture points are the desktop pane kind/document, each tab's pending/failed/
painted choice, `EditorView`'s live/review mount key or pending/error choice, the
phone host kind/document and opening/error/viewer/editor choice, and each in-pane
review header's changes status. Ordinary cold document switches use the same rule;
warm finished-to-finished switches show no cover.

`PaintCapture` declares loading itself; `usePaintPending` belongs to additional
visible loading content without a capture point, including the delayed
skeleton's quiet period and TipTap's construction gap. Commands over finished
prose are not loading. `PaintScope` excludes warm hidden tabs, the parked Editor
pane (by visible screen, never route acquisition readiness), warm live under review and a constructing hidden review from pending and
capture. Viewers are unmarked apart from their delayed skeleton and fail open.

The real page and copy are inert during a hold; the copy is unannounced, excludes
inactive scopes and strips ids. Editor scroll offsets survive. Page focus moves
to the host's status line, then returns to the frame; outside focus stays put.
The review room's paint receipt separately governs input eligibility.
