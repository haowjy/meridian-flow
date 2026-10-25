# Context browser FUTURE

## Recently opened landing

Code-local nice-to-haves for `RecentDocumentsLanding.tsx`, the recorder in
`recent-documents-api.ts`, and the device record those surfaces read. Nothing
here is a known defect.

- A confirmed-empty list still shows skeletons for one round trip when the query
  refetches, because `staleTime: 0` plus default `refetchOnWindowFocus` refetches
  a list the writer is already looking at. The first-run screen is replaced by
  the "Recently opened" chrome and skeletons, then snaps back. Tighten only if
  the flicker shows up in use: treat an empty fetch as unsettled only when the
  query is invalidated (`getQueryState(accountQueryKeys.recentDocuments(projectId))`), and
  leave a plain stale refetch on the first-run copy.
- The cap is per account, not per project (`USER_RECENT_DOCUMENTS_CAP`), so a
  writer who interleaves projects can see a short list in one of them: the 50
  newest opens account-wide may not cover it. Per-project pruning needs the
  project on the recents row, which is only worth doing if the short list shows
  up in use.
- Uploads rows would open onto the "Viewing chat resources is not available
  yet." wall (`ProjectRouteBoundary.tsx`, chosen by `isEditorScheme`). The tab
  seam produces no such tab, so none is recorded today; omit that scheme from
  the list if one ever is.
- Nothing asserts that every scheme in `CONTEXT_URI_SCHEMES` is resolvable by
  `document-address`, which is the one axis where recents' listability and
  context's addressability can genuinely diverge: a listed but unaddressable
  scheme shows a row that opens onto nothing. A table test over the scheme list
  closes it; not written because no such scheme exists today.
- Prune now runs only when a row moved, so an unlistable row can linger in the
  table until the next real open. Bounded by the cap and invisible to the list
  (which filters it), so it is storage hygiene on a delay, not staleness.
- `apps/app/src/client/recents/store.ts` `rememberRemovals` keeps 50 removals
  this record actually held. After 50 later own removals, the oldest falls off
  and a list that still has that id can import it. Revisit only if a writer
  sees a long-closed row return after many later removals on this device. Do
  not grow an unbounded log, and do not let lists delete to cover the miss.
- A closed row's rename or delete waits on window focus, coming online, or the
  60s poll in `account-feature-context.tsx`, which calls
  `availability.recheckWatchedProjects`. `recent-availability.ts` then folds
  that batch into the device record. An unfocused tab can keep a deleted or
  renamed row on the landing until one of those fires. Do not recheck the set
  on catalog cache writes to close that lag.
# Context tree follow-ups

- `use-create-entry-form.ts` and `ContextTreeRows.tsx`: offer **Open existing**
  when the tree's New file form hits an existing file, opening that identity
  rather than making the writer dismiss the form and find it manually. Only
  `IdentityPlacementField.tsx` currently offers this recovery action. Keep
  folder conflicts distinct and preserve the editable failed field.
- `use-rename-entry-form.ts`: surface the server's actionable reason when a
  rename cannot change type (for example `data.json` to `data.md`), instead of
  generic retry copy. Verify the message stays on the attempted rename and
  the existing document remains unchanged.
- Sidebar rows are `role="button"` and report a multi-row selection with
  `aria-pressed`. The ARIA tree pattern (`role="tree"`/`treeitem`,
  `aria-selected`, arrow-key navigation) would describe the selection natively;
  it changes every tree surface (Files, Scratch, Work Files), so it is its own
  change.

## Delete Undo notice

For `document-delete-undo.tsx` and `shell/SurfaceNotice.tsx`.

- A restore that lands at another name says so only through `announce()`, so a
  sighted writer learns the new name by scanning the tree. Keep the card open for
  a moment with "Restored at ‹location›" if that confuses anyone.
