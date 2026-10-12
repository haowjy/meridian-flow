# domains/export — deferred work

Delete an entry when it ships.

- **The export preview reads every prose document on each option change.**
  `domain/project-export.ts` `preview()` runs the whole link-spelling pass over
  live prose to count outside links and pending drafts, and the dialog asks
  again whenever Scratch or Uploads is toggled (debounced, abortable). Cost
  grows with the project, not the change. Follow-up: compute per-document
  outside-link counts once per preview session (or cache them by document
  version) and recombine per option, so a toggle reads nothing; measure on a
  2,000-document project first.
