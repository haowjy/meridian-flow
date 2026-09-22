# Recently opened landing follow-up

Code-local nice-to-haves for `RecentDocumentsLanding.tsx` and the recorder in
`recent-documents-api.ts`. Nothing here is a known defect.

- A confirmed-empty list still shows skeletons for one round trip when the query
  refetches, because `staleTime: 0` plus default `refetchOnWindowFocus` refetches
  a list the writer is already looking at. The first-run screen is replaced by
  the "Recently opened" chrome and skeletons, then snaps back. Tighten only if
  the flicker shows up in use: treat an empty fetch as unsettled only when the
  query is invalidated (`getQueryState(accountQueryKeys.recentDocuments)`), and
  leave a plain stale refetch on the first-run copy.
- A cold-cache return can still paint the first-run copy for a beat: if the
  landing's GET returns `[]` before the record's invalidation lands, the empty
  result sticks until the next focus. `cancelQueries({ queryKey:
  accountQueryKeys.recentDocuments })` before the invalidate in
  `useRecordOpenedDocument` closes it.
- The recents query key carries no account id (`account-query-keys.ts`), so only
  the unmount on logout keeps one account's list out of another's session. Not
  worth a change while logout drops the authenticated query client.
- Scratch and uploads rows would open onto the "Viewing chat resources is not
  available yet." wall (`ReadableProjectRoute.tsx`). The tab seam produces no
  such tab, so none is recorded today; omit those schemes from the list if one
  ever is.
