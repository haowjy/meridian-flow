# domains/import — deferred work

Delete an entry when it ships.

- **Finish's release can leave a link-ahead ref unsettled (never wrong).**
  In `domain/import-service.ts`, `finish()` releases link-ahead refs bound to
  binary and code entries that never landed (`tree.releaseAhead`), and that
  release-and-settle runs without the address lock. A landing that settles the
  same address concurrently can interleave with it, so a ref may stay waiting
  instead of becoming settled; it never points at the wrong document.
  Follow-up: take the address lock around release-and-settle (one ordered
  ahead-ref transition in the tree writer), and add a barrier test in
  `import-landing.db.test.ts` that pauses a landing's settle while Finish
  releases.

- **Candidate aliases are re-derived for every prepared note.** Derive them
  once per selection instead (performance).
