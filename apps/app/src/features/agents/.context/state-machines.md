# features/agents state machines

## Package Save word

What the writer's last Save or Undo of one Agent package says where the package's state shows
(`package-save.ts`). The package's own state is the server's and is not drawn here: the word
only stands in front of it while it holds.

```mermaid
stateDiagram-v2
  [*] --> saving: Save, said at once from the files query
  saving --> saved: the server saved it
  saving --> failed: a package-level Error (a 200, not a refusal)
  saving --> [*]: unchanged, or the server listed no such package
  saving --> unreached: no usable answer
  unreached --> saving: Retry
  saved --> undoing: Undo
  undoing --> undone: undone
  undoing --> [*]: a later Save exists, nothing changed
  undoing --> saved: no usable answer (Undo shows as a retry)
  undone --> saving: Save
  saved --> [*]: the package changes from how the Save left it
  failed --> [*]: its files or their findings change
  undone --> [*]: the package changes after Undo's files are read
  unreached --> [*]: the package changes
```

- **`saving` is predicted from the files query**: a package-level Error (state `cant-save`, or
  an Error in a file that defines no Agent or skill) shows "Not saved"; anything else "Saved",
  with the Agent and skill files that have an Error as not in use, and Undo inert until the server
  gives a `saveId`. The server's outcome replaces it.
- **Undo merges the previous text into the files**, so `undone` waits for the files to be read
  again and then holds while the package is as Undo left it and reads Unsaved; one that reads Saved
  shows nothing, the state says it. Each Save's Undo (`pending`, `failed`, `undone`, `nothing`) is
  kept by `saveId`, not on the word, so the AI's Save card and the notice show one state.
- **A word holds while the package is as the word speaks of it** (its state, `saveId`, changes
  and findings): for a settled `saved` or `undone`, as the files read after it, and the word holds
  until that read lands (judged against the package as pressed, the fresh files dropped it for a
  frame); for the rest, as the writer pressed it. Typing after a Save ends the word even when the same file changes again,
  and so does putting a file back by hand. Holding `saved` on the state alone left "1 not in use"
  up after a hand revert made the package read `saved`.
- **Retry sends the Save again with nothing to match it by.** That is safe: a Save of files
  that already are the saved version answers `unchanged`. A second Undo of one `saveId` answers
  `undone: false`.
- Words live in memory, per package, shared by every surface that shows it (the user level's
  across projects); a reload forgets them and the state shows alone.
