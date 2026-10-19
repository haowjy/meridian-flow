# #871 cells: the writer types while the AI rewrites

Protects [#871](https://github.com/haowjy/meridian-flow/issues/871): an AI write plans on what the
model was shown, so writer text typed after the model's read survives unless the write deletes the
block holding it. Four cells, each in auto-apply (No Work, direct) and draft mode (a named Work,
`aiWriteMode: "draft"`). Run it in the browser with `agent-browser`; `./mf` sets up and reads back.

## Stack and seed

```bash
MODEL_PROVIDER=mock pnpm dev
pnpm portless:list          # this worktree's app and server
P=$(./mf project default --json | jq -r .projectId)
```

`chapter.md` (pass it with `--text @chapter.md`; a shell `$'…'` string collapses to one block):

```markdown
# 871 Chapter

Paragraph A stood at the gate.

Paragraph B waited by the river.

Paragraph C held the forest.

Paragraph D kept two clocks.

Paragraph E watched the hawk.
```

One document per cell and mode, so writes can't contaminate each other:

```bash
for c in C1 C2 C3 C4; do for m in Direct Draft; do
  ./mf doc put "manuscript://871 $c $m" --text @chapter.md --overwrite --json
done; done
./mf api POST "/api/projects/$P/works" --data '{"name":"871 Sweep Probe"}' --json > work.json
W=$(jq -r .id work.json)
./mf api GET "/api/agents?projectId=$P&limit=100" --json \
  | jq '.agents[] | select(.slug=="general").selection' > agent-selection.json
for c in c1 c2 c3 c4; do
  ./mf thread create --work @/ --title "871 $c direct" --json > thread-$c-direct.json
  jq -n --arg p "$P" --arg w "$W" --arg id "$(node -p 'crypto.randomUUID()')" --arg t "871 $c draft" \
    --argjson sel "$(cat agent-selection.json)" \
    '{id:$id,projectId:$p,title:$t,agentSelection:$sel,workId:$w,aiWriteMode:"draft"}' > body-$c.json
  ./mf api POST /api/threads --data @body-$c.json --json > thread-$c-draft.json
done
```

Read each document once on its thread to learn the block hashes (blocks are heading, A, B, C, D,
E), with `./mf thread send "$T" 'Read.' --mock '[{"toolCalls":[{"name":"read","args":{"path":"manuscript://871 C1 Direct"}}]},{"text":"Read."}]'`
and `./mf thread view "$T" --last 2 --full --json`. Hashes differ per document and per run.

**Prime each draft document** with one draft-mode write to paragraph A (`in: <hash-A>`, content
`Paragraph A stood at the gate (draft primed).`), so a Work draft exists and the writer can type in
the draft editor. Its `itemKey` (`branchId:documentId`) comes from
`./mf api GET "/api/projects/$P/works/$W/branches"`; the draft editor is
`/p/<P>/editor/manuscript/871%20C1%20Draft?work=<W>&item=<itemKey>`. Auto-apply opens the same path
without `?work=`.

## Each cell

One reply, three model calls: read, a write held with `delayMs: 30000` so the writer types after
the read, then text.

| Cell | Write | Writer types, after the read (press End on the paragraph first) |
|---|---|---|
| 1 | `replace`, `in: [hash-B, hash-C]`, two rewritten paragraphs | on B: `Enter`, then `hmmm WRITER-P` |
| 2 | `replace`, `in: hash-B`, `Paragraph B was rewritten by the model.` | on B: ` WRITER-W` |
| 3 | `remove`, `in: hash-D` | on D: ` WRITER-D` |
| 4 | same as 2 | on E: `Enter`, then `WRITER-OUT` |

```json
[
  {"toolCalls":[{"name":"read","args":{"path":"manuscript://871 C1 Direct"}}]},
  {"delayMs":30000,"toolCalls":[{"name":"write","args":{"command":"replace","path":"manuscript://871 C1 Direct","in":["<hash-B>","<hash-C>"],"content":"Paragraph B was rewritten by the model.\n\nParagraph C was rewritten by the model."}}]},
  {"text":"Done."}
]
```

Start the send in the background (`./mf thread send "$T" '…' --mock @c1-direct.json --json > c1-direct.ndjson`),
wait until the NDJSON has `type: tool.completed` with `name: read`, then type in the browser.
The draft review page holds two editors (a hidden live one); type into the
`[contenteditable][aria-label="Collaborative document editor"]` whose height is above 0. Close the
chat switcher before typing.

## Expect

Every writer edit here is 1 or 2 words, under the region check's 10-word budget, so no write is
refused; the merge decides what survives.

| Cell | Both modes |
|---|---|
| 1 | writer paragraph kept between the rewritten B and C; no `swept:` |
| 2 | B rewritten, ` WRITER-W` kept as its suffix (the settled result still prints a `swept:` line for B; swept reporting is M3's) |
| 3 | D and ` WRITER-D` gone; the result names it on a `swept:` line |
| 4 | `WRITER-OUT` kept; it is outside the write's passage and listed under `concurrent edits:` |

No text duplicated anywhere. In draft mode the live document keeps the five original paragraphs
(`./mf doc read`). To see the refusal, repeat cell 2 typing a sentence of more than ten words:
the write returns `status: region_changed` with "Not applied: this passage changed since you last
saw it. Current text:", the chat row reads "Got the latest text of" the document, and the next
step's identical write lands with the writer's sentence intact. (A passage the model hasn't seen
all of says "Not applied: you haven't seen all of this passage yet. Current text:" instead.)

Capture per cell the `tool.settled` line, `./mf thread view "$T" --last 2 --full --json`, the
document text (auto-apply: `./mf doc read`; draft: the visible editor), and one screenshot of the
editor beside the chat dock.

## Last run

2026-10-19, M2's last fix round (`persist` returns a save's only cut and an "only if empty"
precondition is judged inside the append; a delivery request cuts a retry's wait short), API level
only (an in-process probe on the real collab domain, writer edits applied as Yjs updates to the live
room and as writer frames to the Work draft): all eight cells as expected above, text identical to
fix round 4's apart from Yjs-client-dependent hashes. Before-state and W1's browser run:
`work/concurrent-edit-design/m2/probe/before/` and `probe/after/` in the docs repository; raw
results: `probe/final/cells-871.md`. A browser run is still owed.
