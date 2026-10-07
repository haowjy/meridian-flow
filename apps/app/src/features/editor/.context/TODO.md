# TODO

- `EditorView.tsx` (`data-document-schema-stale`, "This chapter is
  temporarily unavailable"): this is the only surface in the app where a
  writer faces a document they cannot read or edit — a state the
  [repair-first ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/schema/repair-first-never-disable.md)
  (2026-07-28) forbids as a product state. It is tolerable only as an
  assertion screen for major schema mismatches, which the evolution policy
  rules out of ordinary operation. Follow-up: if the 4407 path ever becomes
  reachable in practice, replace this surface with the migration flow (and
  at minimum a read-only view of the last known content) — never extend it
  to new cases. The schema-fence read-only state is the model to follow:
  content visible, honest notice, automatic repair attempted.

- `EditorView.tsx` review entry: on an existing document the read-only live
  text shows under the review header for about 110 ms until the draft paints
  (the alternative before #654 was about 1.1 s of blank body). Open product
  question for the human: (A) keep this, or (B) hold the whole live view,
  header included, until the draft paints. Undecided; do not change it without
  a ruling. Evidence: `evidence/final-682-findings.md` F1 in the
  [draft-review-repair work item](https://github.com/haowjy/meridian-flow-docs/tree/main/work/draft-review-repair).
