# Writer typing while the AI rewrites

Run four cells in auto-apply and Draft mode. `./mf` sets up and reads back the
documents; `agent-browser` drives the writer's typing.

## Stack and seed

```bash
MODEL_PROVIDER=mock pnpm dev
pnpm portless:list
P=$(./mf project default --json | jq -r .projectId)
```

Use this fixture as `chapter.md` with `--text @chapter.md`:

```markdown
# Chapter

Paragraph A stood at the gate.

Paragraph B waited by the river.

Paragraph C held the forest.

Paragraph D kept two clocks.

Paragraph E watched the hawk.
```

Create one document for each cell and mode with `./mf doc put`, create one Work
with `POST /api/projects/$P/works`, and create one direct and one Draft chat per
cell. The Draft chats use `workId` and `aiWriteMode: "draft"`. Read each
document once on its chat to learn the hashes for heading, A, B, C, D, and E.
Prime each Draft document with a write to paragraph A so its Work draft exists;
get the `itemKey` from `GET /api/projects/$P/works/$W/branches` and open
`/p/<P>/editor/manuscript/<document>?owner=work:<W>&item=<itemKey>`.

## Each cell

Send one mocked reply with a `read`, a write held by `delayMs: 30000`, and a
final text step:

| Cell | Model write | Writer types after the read |
|---|---|---|
| 1 | `replace`, `in: [hash-B, hash-C]`, two rewritten paragraphs | On B, press Enter and type `hmmm WRITER-P`. |
| 2 | `replace`, `in: hash-B`, rewrite B | Append ` WRITER-W` to B. |
| 3 | `remove`, `in: hash-D` | Append ` WRITER-D` to D. |
| 4 | Same as cell 2 | On E, press Enter and type `WRITER-OUT`. |

Start the send in the background. After the NDJSON has `type: tool.completed`
with `name: read`, type into the visible
`[contenteditable][aria-label="Collaborative document editor"]`. Close the
chat switcher first.

## Expected result

- Cell 1 keeps the writer paragraph between rewritten B and C.
- Cell 2 keeps ` WRITER-W` as B's suffix.
- Cell 3 loses D and ` WRITER-D`; the ancestor delete removed the block.
- Cell 4 keeps `WRITER-OUT` outside the model's passage and lists it under
  `concurrent edits by the user`.

No concurrent writer edit refuses the model write, no text is duplicated, and
Draft mode leaves the live document unchanged. Repeat cell 2 with a sentence
longer than ten words: the write lands and the receipt names the user's
contribution. A write based on a partial read follows the same rule.

For each cell capture the `tool.settled` line, `./mf thread view "$T" --last 2
--full --json`, document text (`./mf doc read` for auto-apply), and a screenshot
of the editor beside the chat.
