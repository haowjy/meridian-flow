# File-policy performance guidance

This page records the performance constraints that shape file authorization.
Keep reads batched and authorization fresh; do not trade correctness for a
cache that hides Work switches or branch-view changes.

## Constraints

- `listAccess` and tree facts are set-oriented. Resolve locations and folder
  ancestry for an identity set, grouped by branch view, rather than once per
  document or ancestor.
- Agent-chain reads are linear in chain depth. Read the binding fresh for each
  tool call so a rebind is visible on the next call.
- Room frames confirm grants, while reply saves confirm once for all documents.
  Do not add a second confirmation inside a seam that already owns the Work
  locks.
- Skill visibility reads one thread binding per call. Do not re-read the whole
  skill set for each skill.
- A path that can run concurrently must not hold one pooled connection while
  acquiring another. Live pulls snapshot before opening their root transaction;
  remaining exceptions are tracked in [collab TODO](../../collab/.context/TODO.md).

Measure statement count and peak connection usage with the current fixtures
before narrowing confirmation, adding a cache, or changing lock ownership.
