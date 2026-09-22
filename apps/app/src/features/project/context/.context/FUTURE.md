# Recently opened landing follow-up

Code-local nice-to-haves for `RecentDocumentsLanding.tsx` and the recorder in
`recent-documents-api.ts`. Nothing here is a known defect.

- A confirmed-empty list still shows skeletons for one round trip when the query
  refetches, because `staleTime: 0` plus default `refetchOnWindowFocus` refetches
  a list the writer is already looking at. The first-run screen is replaced by
  the "Recently opened" chrome and skeletons, then snaps back. Tighten only if
  the flicker shows up in use: treat an empty fetch as unsettled only when the
  query is invalidated (`getQueryState(accountQueryKeys.recentDocuments(projectId))`), and
  leave a plain stale refetch on the first-run copy.
- A cold-cache return can still paint the first-run copy for a beat: if the
  landing's GET returns `[]` before the record's invalidation lands, the empty
  result sticks until the next focus. `cancelQueries({ queryKey:
  accountQueryKeys.recentDocumentsRoot })` before the invalidate in
  `useRecordOpenedDocument` closes it.
- The recents query key carries the project but no account id
  (`account-query-keys.ts`), so only the unmount on logout keeps one account's
  list out of another's session. Not worth a change while logout drops the
  authenticated query client.
- The cap is per account, not per project (`USER_RECENT_DOCUMENTS_CAP`), so a
  writer who interleaves projects can see a short list in one of them: the 50
  newest opens account-wide may not cover it. Per-project pruning needs the
  project on the recents row, which is only worth doing if the short list shows
  up in use.
- Scratch and uploads rows would open onto the "Viewing chat resources is not
  available yet." wall (`ReadableProjectRoute.tsx`). The tab seam produces no
  such tab, so none is recorded today; omit those schemes from the list if one
  ever is.
- Nothing asserts that every scheme in `CONTEXT_URI_SCHEMES` is resolvable by
  `document-address`, which is the one axis where recents' listability and
  context's addressability can genuinely diverge: a listed but unaddressable
  scheme shows a row that opens onto nothing. A table test over the scheme list
  closes it; not written because no such scheme exists today.
- Prune now runs only when a row moved, so an unlistable row can linger in the
  table until the next real open. Bounded by the cap and invisible to the list
  (which filters it), so it is storage hygiene on a delay, not staleness.
