# Model revert by identity

Checks `write {command: "revert", edit: "e1"}`. Revert reads the edit's
recorded `delta`: it takes out what the edit inserted and restores what it deleted, where that
change still stands. Each
part reverts or skips independently. Skipped parts use their immutable
1-based number and reason, and the result does not quote before, after, or
current text.

When every part is skipped, the status is `nothing_to_revert` and the failed
step says, “Couldn't revert” Undo uses the same part policy. `count` checks whole stack
entries before writing; an excessive count changes nothing.

## Setup

Run from the tested checkout with `./mf` authenticated and a default project.
Start `MODEL_PROVIDER=mock pnpm dev` and discover its URL with
`pnpm portless:list`. Create a private mock-bound agent, a fresh document, a
fresh chat, and a fresh Work for each Draft case. Auto-apply uses
`./mf thread create --agent <agent>`; Draft mode uses
`./mf thread create --work <work>` with `aiWriteMode: "draft"`.

Read before replacing a passage the model has not seen. Keep the handle from
the first write result rather than assuming `e1`:

```bash
./mf thread send "$T" read --mock "$READ" --json
./mf thread send "$T" write --mock "$WRITE" --json
./mf thread view "$T" --last 1 --full --json
./mf thread send "$T" revert --mock "$REVERT" --json
```

Phase 1 has no text drafts: in Draft mode too, a write lands in Live. Browser cases use real
typing instead of a mocked writer edit.

## Cases

Run each in both modes, with `The cat sat on the mat.` unless the row says
otherwise. N is the model's first write.

| Case | N, then writer change | Required result |
|---|---|---|
| Plain | N appends ` The dog ran across the yard.` | `reverted: e1 (1 of 1 parts)`; original sentence remains. |
| Typing elsewhere | N appends the sentence; writer adds `Lin Feng drew his sword.` | N is reverted; both the original sentence and new paragraph remain. |
| Edited inside N | N appends ` The big black dog ran.`; writer changes `black` to `brown`. | `nothing_to_revert`, `not reverted: part 1: edited since`; text is unchanged. |
| Repeated text, original edited | Seed `The night was dark.` and `Lin Feng walked on.`; N inserts a second dark sentence; writer changes the first to cold. | The writer's sentence remains; N's copy is removed. |
| Repeated text, N's copy edited | Same seed; writer changes N's copy to cold. | `nothing_to_revert` with a numbered skipped-part reason and unchanged text. |
| Emptied paragraph | N adds a paragraph; writer deletes its text. | `nothing_to_revert` with a numbered skipped-part reason; the empty paragraph remains. |
| Paragraph rebuilt | N adds a paragraph; writer wraps it in a quote. | `nothing_to_revert` with a numbered skipped-part reason; the quote remains. |
| Existing paragraph rebuilt | N appends to the seed paragraph; writer wraps it in a quote. | `nothing_to_revert` with a numbered skipped-part reason; the quote remains. |
| N deleted a sentence | Seed `AAA went first. BBB stood still. CCC came last.`; N deletes BBB; writer changes first to home and last to early. | Draft: success with both writer changes. Auto-apply: the changed paragraph is skipped. |
| Revert of a revert | Revert Plain, then revert the handle it prints. | N's sentence returns. |
| Two parts | N changes the first and third of three paragraphs; writer edits the first. | `reverted: e1 (1 of 2 parts)` plus `not reverted: part 1: edited since`; only the third reverses. |

Repeat Two parts with `undo`: only the unchanged third paragraph reverses.

In Draft mode, Apply N and run model Undo. It reports `reverted: e1`, restores
the old text as a pending change, and leaves live unchanged. A model `redo` call is
answered `invalid_arguments`: to redo, the model writes the edit again. With one newer pending edit and one
applied edit, `undo` with `count: 2` names the newer handle as undone and the
older as reverted.

In direct mode, edit a live file and delete it in the same chat. `undo` with
`count: 2` restores the file and reverses its earlier text edit atomically.

To check routing, make an edit, switch the chat's write mode, and run Undo: the
manuscript's change is taken back, with `version: live`. Move the chat to another Work; Undo still lands in the
Work that owns the edit. Archive that Work; its rebound chat offers no command
and Undo returns `nothing_to_undo`.

## In the browser

Open `/p/$P/chats/$T` in an authenticated `agent-browser` session. Open the
document through Files; for Draft mode, open its pending row.

1. Auto-apply Plain: the editor returns to the original sentence and the chat
   shows an “Edited 1 document” step with Undo.
2. Draft Plain: the sentence is a pending change before Revert and disappears
   from review after Revert.
3. Auto-apply Edited inside N: type `brown`; the text keeps `brown`, and the
   failed step says the change was not reverted because its text changed or is
   already gone.
4. Draft Two parts: type over the first changed paragraph, run model Undo, and
   check that the first keeps the writer's text, the third returns, and the tool
   row lists the skipped part.

Inspect the editor and chat together, then read the destination with `./mf`.
Remove the fixture documents, chats, and Work and close the named browser
session.
