# domains/import — future work

Delete an entry when it ships.

- **The AI sort (ruling I5).** Choosing a destination and sorting are separate:
  the import lands where the writer chose, and the sort waits for folder moves.
  Follow-up, in order: the model tool surface's folder move
  (P6, model-tool-surface PR 3), then the `sort-import` skill (P7) that
  proposes and applies moves over an import's roots, read from its status. No
  document-by-document fallback ships before P6; writers sort with Move… until
  then. Design: the import-workflow work item's `design/phases.md` (P6, P7).
