# Decisions

## A cleared desk remains ephemeral

A server row with `recentRoutes: []` is adopted as an empty recent-route list,
but the existing restore ladder may default-open the first manuscript document
on a later screen entry or reload. This matches local reload behavior rather
than introducing a persistent empty-workspace state (Jimmy, 2026-07-17).

If product later chooses a persistent clear-workspace behavior, the data model
already distinguishes a cleared record from no record. The change is one
restore branch: when a cleared record exists, honor it and skip the default-open
ladder.
