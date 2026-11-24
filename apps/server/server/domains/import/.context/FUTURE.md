# domains/import — future work

Delete an entry when it ships.

- **The AI sort.** Choosing a destination and sorting are separate: the import
  lands where the writer chose, and the sort waits for folder moves. The model's
  folder move has shipped (`write` with `command: "move"`), so what is left is the
  `sort-import` skill that proposes and applies moves over an import's roots, read
  from its status. No document-by-document fallback ships; writers sort with Move…
  until the skill does. Design: the archived import-workflow work item's
  `design/phases.md` (P7).
