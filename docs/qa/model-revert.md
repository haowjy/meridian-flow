# Model revert by identity

Checks the model's `write {command: "revert", edit: "wN"}`: it deletes what edit N inserted and restores what N
deleted, by Yjs identity, and skips any passage edited since N. A skipped passage whose paragraph still holds N's
text is listed with that paragraph's current text; one whose paragraph was replaced (turned into a heading, rebuilt)
or removed is listed as such, with no guessed text, since nothing but content could say which block replaced it. Undo and redo are
separate commands and are not covered here.

Use a fresh mock-provider stack (`pnpm dev`, URLs from `pnpm portless:list`). `./mf` sets up documents and drives
the mocked model; a second mock-model write may stand in for the writer's edit in the API steps. Run every case
twice: in auto-apply (a thread with no Work, writes land live) and in draft mode (a named Work, writes wait in its
draft). Use a fresh document and thread per case. Keep evidence in the work directory.

## Driving a case

Seed with `./mf doc put "manuscript://<name>" --text '<text>' --overwrite`, then send one mocked write per message:

```bash
op='{"command":"replace","path":"manuscript://<name>","find":"The cat sat on the mat.","content":"The cat sat on the mat. The dog ran across the yard."}'
./mf thread send "$T" 'write' --ref "manuscript://<name>" \
  --mock "[{\"toolCalls\":[{\"name\":\"write\",\"args\":$op}]},{\"text\":\"ok\"}]" --json
```

The first write's handle is `w1`; revert it with `{"command":"revert","path":"manuscript://<name>","edit":"w1"}`.
Read the document afterwards with a mocked `read` in the same version (live or the Work's draft).

## Cases

Seed `The cat sat on the mat.` unless the row says otherwise. N is `w1`.

| Case | Between N and the revert | Expect |
|---|---|---|
| Plain | nothing | `reverted: w1 (1 of 1 parts)`, a new handle `w2`; the document is the seed again |
| Typing elsewhere | another paragraph added after N | N removed, the other paragraph kept |
| Edited inside N | N's `black` changed to `brown` | `nothing_to_revert`; the line `not reverted: "…" → "…": edited since; now "<the edited sentence>"`; text unchanged |
| Repeated text, original edited | seed `The night was dark.` / `Lin Feng walked on.`; N inserts another `The night was dark.` after the first; the first changed to `cold` | N's copy goes: `The night was cold.` / `Lin Feng walked on.` / `The night was dark.` |
| Repeated text, N's copy edited | the same, but N's inserted copy changed | skipped and listed; `now` shows N's copy's current text |
| Paragraph rebuilt | N adds `The dog ran across the yard.` as its own paragraph; the writer turns it into a heading | skipped: `its paragraph was replaced or removed`, no `now`; the heading stays |
| Existing paragraph rebuilt | N appends ` The dog ran.` to the seed paragraph; the writer turns that paragraph into a heading | the same |
| N deleted a sentence | N removed `BBB stood still.`; the neighbouring sentences then changed | the sentence comes back between the changed neighbours |
| Revert of a revert | revert `w1`, then revert that revert's handle | N's text is back |

A write is one part, so a write that touched two separated paragraphs and was then edited in one of them is skipped
whole and listed once.

## In the browser

With `agent-browser`, as the writer: run one revert in auto-apply and watch the editor drop N's text; run one in
draft mode and see the revert as a pending change in the draft's review. For "Edited inside N", type the change in
the editor yourself, then revert: the chat's tool card reads "That change wasn't reverted because its text changed
or is already gone." and the text stays. Screenshot the chat card and the editor for each.
