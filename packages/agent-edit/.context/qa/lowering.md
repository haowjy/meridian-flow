# Lowering real AI rewrites

`lowering.probe.ts` takes 60 saved `deepseek-flash` rewrites (`lowering-cases.json`: 30
paragraphs from public-domain novels, each after one of two writer edits: a phrase inserted
(` of course`) or a word retyped (`said` → `muttered`)) and lowers each with `lowerBlock`, the
authors read from the model's view as the write does. It applies the splices through
`replaceText`, the one text write, on a model's copy forked from the view, and imports the
update into the writer's doc. Run it when `resolver/lower-block.ts` or the text write changes:

```sh
pnpm --filter @meridian/agent-edit exec tsx .context/qa/lowering.probe.ts [--examples]
```

It prints one row per typing pattern: the writer's typed word owns the space before it (` word`)
or after it (`word `). `--examples` prints each broken Undo, each comment that did not land on
whole replacement words, and each misplaced concurrent word.

| column | what it measures |
|---|---|
| Ctrl+Z breaks AI words, AI words broken | The writer presses Ctrl+Z (raw `UndoManager.undo()`, no `editStays` gate) after the AI's write. The target is the AI's text with the writer's edit taken back only where the AI kept it word for word; these count cases and AI words the result damages beyond that. |
| as asked, no-op | Undo gave exactly the target; Undo changed nothing. |
| kept-word comments right | Up to 6 comments per case on words the AI keeps: right when the comment covers exactly that word afterwards. |
| changed-word comments whole/fragment/lost | Up to 6 per case on words the probe's token alignment counts as replaced. `whole`: covers whole words inside the replacement. |
| concurrent in place/glued/displaced | The writer types one word after the read, before the write lands: beside the AI's copy of its neighbour, glued to a letter, or elsewhere. |
| review off | Cases whose Review changes highlights differ from the AI's changes plus the writer's word. |
| ops | Mean Loro ops in the AI's change. |

Results on `feat/loro` before the space rule and the comment carry, then after:

| typing | lowering | breaks AI words | words broken | as asked | kept right | changed whole/fragment/lost | concurrent | review off | ops |
|---|---|---|---|---|---|---|---|---|---|
| ` word` | before | 14/60 | 23 | 46 | 357/360 | 45/5/179 | 58/2/0 | 2 | 12.9 |
| ` word` | after | 9/60 | 13 | 51 | 357/360 | 206/4/19 | 60/0/0 | 0 | 11.7 |
| `word ` | before | 14/60 | 22 | 46 | 357/360 | 45/5/179 | 59/1/0 | 1 | 12.9 |
| `word ` | after | 9/60 | 11 | 51 | 357/360 | 206/4/19 | 58/2/0 | 2 | 11.8 |

How to read what is left:

- 7 of the 9 broken Undos restore a retyped word the AI deleted (`very` → `rather`, the AI
  deletes `rather`, Ctrl+Z puts `very` back between two AI words that share one space, so it
  glues to one). No lowering avoids this.
- The 19 lost comments are on words the word diff deletes with nothing in their place (`moment of
  the time so precious;` → `moment;`): the rule drops them. The probe's alignment, by
  whitespace tokens, counts those words as replaced.
- The 4 fragments land on a whole neighbouring word of the same change, or on punctuation that
  replaced the word (`--` → `—`).
- 3 kept-word comments read wrong under every lowering: the alignment pairs a repeated word
  (`the`, `and`) with another occurrence than the diff did.
- With `word ` typing, 2 concurrent words glue: the word typed during the write is not in the
  view, so its space falls to the default side.
