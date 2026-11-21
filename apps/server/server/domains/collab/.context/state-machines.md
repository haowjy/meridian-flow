# Collab state machines

The status columns collab owns. A draft's tree records are rows; its text changes are suggestion
marks in Live, which have no status of their own.

## Press text effect

A row of `press_text_effects` (`yjs.ts`): one press's text change to one document, kept for
its Undo ([press](press.md)).

```mermaid
stateDiagram-v2
  [*] --> in_force: press commits its Yjs update
  in_force --> taken_back: unpress
  in_force --> [*]: the press's command row is purged (day 30)
  taken_back --> [*]: purge
  state "in force" as in_force
  state "taken back (undone_by set)" as taken_back
```

- **An Undo runs once.** `undone_by` is set in the unpress's transaction; a second unpress of
  the same press finds nothing to take back.
- **A version restore makes the ranges meaningless**, so an unpress of an effect whose generation
  differs from the document's marks it taken back and leaves the text as it is; so does an
  unpress of an effect in a closed owner's notes.
