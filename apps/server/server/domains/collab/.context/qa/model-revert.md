# Model revert by identity

Checks `write {command: "revert", edit: "e1"}`. Revert takes the edit's write back by design §2's
Undo rule ([reversal](../reversal.md)): whole, in the room it was written in, unless someone has
written over it since, and then it stays whole. One write is one part. A part that stays is listed
by its 1-based number and reason (`written over since, so it stays`), and the result does not quote
before, after, or current text.

When every part stays, the status is `nothing_to_revert` and the failed step says “Couldn't
revert”. Undo uses the same rule (`cant_undo_changed` when nothing of the edit goes back). `count`
checks whole stack entries before writing; an excessive count changes nothing.

## Setup

Run from the tested checkout with `./mf` authenticated and a default project.
Start `MODEL_PROVIDER=mock LIVE_TEST_MODEL= pnpm dev` and discover its URL with
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

In Draft mode a write lands in the chat's draft's fork room, and the model's undo and revert
take back only parts written there; Live is untouched until a press. Browser cases use real
typing instead of a mocked writer edit.

## Cases

Run each in both modes, with `The cat sat on the mat.` unless the row says
otherwise. N is the model's first write.

A writer change is `./mf doc edit <uri> --find <text> --replace <text> [--draft <id>]`, which
types into the block's text as a tab does.

| Case | N, then writer change | Required result |
|---|---|---|
| Plain | N appends ` The dog ran across the yard.` | `reverted: e1 (1 of 1 parts)`; original sentence remains. |
| Typing elsewhere | N appends the sentence; writer adds `Lin Feng drew his sword.` to another paragraph. | N is undone; both the original sentence and the writer's words remain. |
| Typed inside N | N appends ` The big black dog ran.`; writer changes `black` to `brown`. | `reverted: e1`: N's text goes, the writer's `brown` stays (`The cat sat on the mat.brown`). Some of what N put in was left, so it goes back around the writer's word. |
| Retyped all of N | N appends ` The dog ran.`; writer replaces it with ` Snow fell.` | `nothing_to_revert`, `not reverted: part 1: written over since, so it stays`; text is unchanged. |
| N rebuilt blocks | Seed `Alpha.`, `Beta.`, `Gamma.`; N replaces the passage with `Red.`, `Beta.`, `Blue.`; writer retypes `Red.` as `Green.` | `nothing_to_revert`: N set structure, and someone wrote in it, so it stays whole. |
| Two writes, `undo` count 2 | N changes the first paragraph, then a second write the third. | `undone: e2, e1`; the text is the seed. |
| One paragraph written twice | Two writes in one turn to one paragraph; `undo` count 2. | `undone: e2, e1`; the text is the seed; a further `undo` is `nothing_to_undo`. |
| Revert of a revert | Revert Plain, then revert the handle it prints. | N's sentence returns. |

In Draft mode, Apply N and run model Undo. It reports `undone: e1` and that the
manuscript still has the text, restores the old text in the draft as a pending change, and leaves
live unchanged. A model `redo` call is
answered `invalid_arguments`: to redo, the model writes the edit again. With one newer pending edit and one
applied edit, `undo` with `count: 2` names the newer handle as undone and the
older as reverted.

In direct mode, edit a live file and delete it in the same chat. `undo` with
`count: 2` restores the file and reverses its earlier text edit atomically.

To check routing, make an edit, switch the chat's write mode, and run Undo: the
edit is taken back in the room it was written in (Live for a Direct-mode edit, the draft for a
Draft-mode one), whichever mode the chat is in now. Move the chat to another Work; Undo still lands in the
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
