# TODO

- `EditorView.tsx` (`data-document-schema-stale`, "This chapter is
  temporarily unavailable"): this is the only surface in the app where a
  writer faces a document they cannot read or edit — a state the
  [repair-first ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/repair-first-never-disable.md)
  (2026-07-28) forbids as a product state. It is tolerable only as an
  assertion screen for major schema mismatches, which the evolution policy
  rules out of ordinary operation. Follow-up: if the 4407 path ever becomes
  reachable in practice, replace this surface with the migration flow (and
  at minimum a read-only view of the last known content) — never extend it
  to new cases. The schema-fence read-only state is the model to follow:
  content visible, honest notice, automatic repair attempted.
