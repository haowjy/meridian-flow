# Model revert merges through the write door

Checks [#871](https://github.com/haowjy/meridian-flow/issues/871): a model revert removes an
older write's change from its current view, keeps independent later edits, and uses the ordinary
write's region check, reply save and receipts. Undo/redo remain inverse operations.

Use a fresh mock-provider stack and the thread/document setup in [871 cells](871-cells.md#stack-and-seed).
Run each case in auto-apply and draft mode. `./mf` drives model calls and reads durable state;
`agent-browser` types writer edits and checks the visible editor and chat. Keep evidence in the work
directory. This recipe does not claim a browser pass.

## One reply, three writes

Seed `The cat sat on the mat.`. Use one mocked reply whose successive steps are:

```json
[
  {"toolCalls":[{"name":"read","args":{"path":"manuscript://Revert probe"}}]},
  {"toolCalls":[{"name":"write","args":{"command":"replace","path":"manuscript://Revert probe","find":"The cat sat on the mat.","content":"The cat sat on the mat. The big black dog ran."}}]},
  {"toolCalls":[{"name":"write","args":{"command":"revert","path":"manuscript://Revert probe","edit":"w1"}}]},
  {"toolCalls":[{"name":"write","args":{"command":"revert","path":"manuscript://Revert probe","edit":"w2"}}]},
  {"text":"Done."}
]
```

Send with `./mf thread send "$T" 'Try the reverts.' --mock @revert.json --json`.
The orchestrator saves before each revert. Expect three ordinary write handles, `w1`, `w2`, `w3`;
final text includes the dog sentence again. Durable edit rows are `kind: "write"`, with before/after
cuts for all three writes. In draft mode live text stays unchanged until Apply. Repeat with a Stop
after staging a revert: its unsaved text must not reach the durable document.

## Later changes

Start each case in a fresh document/thread. After saving `w1`, read its text, then hold the revert
step with `delayMs: 30000` and type in the browser as in [871 cells](871-cells.md#each-cell).

| Case | Change after `w1` | Expect |
|---|---|---|
| Plain | None | Revert removes the dog sentence. Repeating revert of `w1` returns unchanged, not another write handle. |
| Seen overlap | Rewrite the dog sentence with more than ten different words; model reads again before reverting | Dog sentence and its overlapping rewrite are removed. |
| Unseen overlap | Same rewrite, without another model read | `region_changed` with current text. Retry after that showing succeeds unless it changes again. |
| Later model rewrite | Model replaces `black` with `brown`, reads, then reverts `w1` | The whole dog sentence is removed, not skipped as edited since. |
| Original duplicate edited | Seed `dark / Lin / dark` as three paragraphs, insert another `dark` paragraph after the first, change the first to `cold`, read, revert insertion | `cold / Lin / dark`. The original first paragraph survives. |
| Inserted duplicate edited | Same insertion, change the inserted paragraph to `cold`, read, revert insertion | `dark / Lin / dark`. The inserted copy goes. |

For the duplicate cases, use complete sentences (`The night was dark.` and `Lin Feng walked on.`)
and the read's block hashes to target insertion and typing. Equal text is not proof of keeping the
right copy: retain the editor's Yjs item identities when collecting debugging evidence.

## Independent passages and receipts

Seed nine paragraphs. One write changes paragraphs 2 and 8. Read, then rewrite paragraph 8 with more
than ten different words while the revert waits. Expect paragraph 2 to revert and paragraph 8 to be
refused. Change paragraph 8 again before save. The settled tool result and the **next model request**
must show its saved text after `Not reverted: this passage changed since you last saw it. Current text:`.
The recorded frontier must match that saved cut, not the text at planning time.

Check the editor beside the chat in both modes, the new write's Undo/Redo card, and the refusal row.
Capture screenshots and `./mf thread view "$T" --last 2 --full --json`. An unavailable-history refusal
says the change cannot be reverted, never that there was nothing to revert; history lists writes
without cuts as unavailable. Also check source history after Apply, Discard and source reset: cuts
that are no longer contained refuse explicitly, never fall back to the identity inverse.
