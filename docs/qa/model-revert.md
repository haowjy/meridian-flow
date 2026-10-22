# Model revert by identity

Checks the model's `write {command: "revert", edit: "e1"}`, which takes back one of the model's earlier edits (here
`e1`, the handle its write result printed). Revert finds that edit's text by Yjs item identity, never by matching
text: it deletes what the edit inserted and restores what it deleted. An edit is stored as one or more parts, and each
part reverts or is skipped on its own. Skipped parts are listed by their immutable 1-based part number and reason,
for example `not reverted: part 1: edited since`. The result quotes neither the edit's before/after text nor the
passage's current text. Part numbers identify parts of the named edit, not current document blocks; use ordinary
`read` for the current passage.

When every part is skipped the tool status is `nothing_to_revert`, and the chat's failed step reads "That change
wasn't reverted because its text changed or is already gone."

Undo and Redo use the same part policy. If later typing replaced one part, the
command reverses the parts that remain and lists each skipped part as `not
undone` or `not redone`. It returns `cant_undo_changed` or `cant_redo_changed`
only when no part remains. `count` still checks whole stack entries before it
writes: requesting more entries than are available changes nothing.

## Setup

Run commands from the tested checkout's root, with `./mf` authenticated and a default project available (see
[CLI setup](../debugging.md#set-up-and-debug-with-the-cli)). Auto-apply writes directly to the manuscript. Draft mode
writes into a named Work, a task context whose shared pending edits wait for the writer's Apply.
Reuse the project and private agent; create a fresh document and chat for each case, and a fresh Work for each draft case.

Start a mock-provider stack in the checkout under test (`MODEL_PROVIDER=mock pnpm dev`; find its URLs with
`pnpm portless:list`). Create a private mock-bound agent rather than using General, whose saved model may be a real
provider. From that checkout:

```bash
P=$(./mf project default --json | jq -r .projectId)
AGENT=revert-probe-$(date +%s)
./mf api POST /api/agents --data "$(jq -nc --arg slug "$AGENT" \
  '{slug:$slug,content:"---\nname: Revert Probe\nmode: primary\nmodel: mock-llm-v1\n---\nFollow the writer."}')" --json
SEL=$(./mf api GET "/api/agents?projectId=$P&limit=100" --json | jq -c --arg slug "$AGENT" \
  '.agents[] | select(.slug==$slug) | .selection')
D=manuscript://revert-check-1          # a fresh document per case
./mf doc put "$D" --text 'The cat sat on the mat.' --overwrite

```

Choose **one** mode for each case.

Auto-apply (no named Work):

```bash
T=$(./mf thread create --agent "$AGENT" --title 'revert check' --json | jq -r .threadId)
```

Draft mode instead:

```bash
W=$(./mf api POST "/api/projects/$P/works" --data "$(jq -nc --arg name "$AGENT draft $(date +%s)" '{name:$name}')" --json | jq -r .id)
T=$(./mf api POST /api/threads --json --data "$(jq -nc --arg id "$(node -p 'crypto.randomUUID()')" \
  --arg p "$P" --arg w "$W" --argjson s "$SEL" \
  '{id:$id,projectId:$p,title:"revert check",agentSelection:$s,workId:$w,aiWriteMode:"draft"}')" | jq -r .id)
```

Each model step is one mocked message. Read before replacing a passage the model has not seen. Revert itself
needs no read; it uses the recorded edit identity:

```bash
mock() { jq -nc --argjson a "$1" --arg n "$2" '[{toolCalls:[{name:$n,args:$a}]},{text:"ok"}]'; }
./mf thread send "$T" read --mock "$(mock "{\"path\":\"$D\"}" read)" --json >/dev/null
./mf thread send "$T" write --json --mock "$(mock "{\"command\":\"replace\",\"path\":\"$D\",\"find\":\"The cat sat on the mat.\",\"content\":\"The cat sat on the mat. The big black dog ran.\"}" write)"
./mf thread view "$T" --last 1 --full --json   # the tool result: `write: e1`, and the version (live, or draft)

# After the case's intervening edit, use the handle returned by the first write.
EDIT=e1
./mf thread send "$T" revert --json --mock "$(mock "{\"command\":\"revert\",\"path\":\"$D\",\"edit\":\"$EDIT\"}" write)"
```

In draft mode the first write into a fresh Work can answer `region_changed`; read again and repeat it. Take the
handle from the result rather than assuming `e1`. A later `read` in the same chat shows the version the chat writes
to (the live document, or the Work's draft), and that is the text to check. A second mocked write can stand in for
the writer's edit; the browser steps use real typing.

## Cases

Run each in both modes, in a fresh document and chat. Seed `The cat sat on the mat.` unless the row says otherwise.
N is the model's first write.

| Case | N, then what changes before the revert | Expected result and text |
|---|---|---|
| Plain | N appends ` The dog ran across the yard.`; nothing else | `reverted: e1 (1 of 1 parts)` and a new handle; text `The cat sat on the mat.` |
| Typing elsewhere | the same N; then a new paragraph `Lin Feng drew his sword.` | success; the original sentence and the new paragraph remain |
| Edited inside N | N appends ` The big black dog ran.`; then `black` → `brown` | `nothing_to_revert`; `not reverted: part 1: edited since`; text unchanged |
| Repeated text, original edited | seed `The night was dark.` / `Lin Feng walked on.`; N inserts another `The night was dark.` after the first; the first then becomes `The night was cold.` | success; `The night was cold.` / `Lin Feng walked on.` (N's copy went, not the writer's) |
| Repeated text, N's copy edited | the same, but N's copy becomes `The night was cold.` | `nothing_to_revert`; a numbered skipped-part reason, without quoting the passage; text unchanged |
| Emptied paragraph | N adds the paragraph `The dog ran across the yard.`; then its text is deleted, leaving the paragraph empty | `nothing_to_revert`; a numbered skipped-part reason, without quoting the empty paragraph |
| Paragraph rebuilt | N adds the paragraph `The dog ran across the yard.`; then it is turned into a heading | `nothing_to_revert`; a numbered skipped-part reason, without quoting the heading; the heading stays |
| Existing paragraph rebuilt | N appends ` The dog ran.` to the seed paragraph; then that paragraph is turned into a heading | `nothing_to_revert`; a numbered skipped-part reason, without quoting the heading; the heading stays |
| N deleted a sentence | seed `AAA went first. BBB stood still. CCC came last.`; N removes `BBB stood still. `; then `first` → `home`, `last` → `early` | draft: success, `AAA went home. BBB stood still. CCC came early.`; auto-apply: `nothing_to_revert`, a numbered skipped-part reason (see below) |
| Revert of a revert | the Plain case's revert; then revert the handle it printed | N's sentence is back |
| Two parts | seed three paragraphs; one range replace over all three changes the first and third; then the first is edited | `reverted: e1 (1 of 2 parts)` and `not reverted: part 1: edited since`, without quoting the skipped passage |

Repeat **Two parts** with `undo` instead of `revert`. Expect `undone: e1 (1 of
2 parts)`, a `not undone` fact for part 1, and only the unchanged third
paragraph reversed. Redo restores that third-paragraph part without replacing
the writer's first paragraph.

To check destination routing, make one live edit, switch the chat to draft
mode, and run Undo. The manuscript changes, the Work draft does not, and the
result ends with `version: live`. Then make one draft edit, switch the chat to
auto-apply, and run Undo. The Work draft changes, the manuscript does not, and
the result names that draft. Moving the chat from one Work to another still
does not let its stack write into the former Work.

**Why auto-apply differs in "N deleted a sentence":** a live write stores its whole paragraph as deleted and
reinserted text, so any later change in that paragraph, even to words N kept, skips the part. A draft write stores
only the words it changed ([#969](https://github.com/haowjy/meridian-flow/issues/969)).

## Compact-result recovery

For all-skipped cases, expect `reverted: e1 (0 of 1 parts)`, the numbered reason, and a document address to read.
For partial cases, confirm the ordinary write receipt includes the document address and the reverted-part count.
For cases whose table gives a generic reason, assert the `not reverted: part <n>:` shape and unchanged document;
classification may distinguish edited text from inaccessible structure. Neither result may include the skipped part's before, after, or current paragraph as a refusal quote. Successful
write echoes still show applied changes through their existing path.

After the **Edited inside N** case, the document still contains `The big brown dog ran.`. Read, then deliberately
replace that sentence:

```bash
./mf thread send "$T" read --mock "$(mock "{\"path\":\"$D\"}" read)" --json
./mf thread send "$T" replace --mock "$(mock "{\"command\":\"replace\",\"path\":\"$D\",\"find\":\"The big brown dog ran.\",\"content\":\"The brown dog rested.\"}" write)" --json
```

Expect `The cat sat on the mat. The brown dog rested.` in the destination, with the cat sentence unchanged.
This checks that recovery needs no special current-text echo.

## In the browser

Open the discovered app URL at `/p/$P/chats/$T` in an authenticated `agent-browser` session. Open the seeded
document through the Files tree; for a draft, open its pending document row in the Work. Keep the editor and chat
visible together:

1. Auto-apply, Plain case: after the revert the editor shows `The cat sat on the mat.` and the chat shows the revert
   as an "Edited 1 document" step with Undo.
2. Draft mode, Plain case: before the revert the editor shows N's sentence as a pending change (Show changes, Apply,
   Discard). After it, the pending change is gone.
3. Auto-apply, Edited inside N, typing `brown` in the editor yourself: the text keeps `brown`, and expanding the
   chat's failed step shows "That change wasn't reverted because its text changed or is already gone."
4. Draft mode, Two parts: type over the first changed paragraph, then let the
   model run Undo. The first paragraph keeps the writer's text, the third
   paragraph returns to its earlier text, and the tool row lists the skipped
   part.

Screenshot the editor with the chat for each step. Record the source commit, date, provider, commands and observed
results in the work item; attach masked screenshots to the PR. Delete the run's fixture documents/chats/Works and
close its browser session afterward.
