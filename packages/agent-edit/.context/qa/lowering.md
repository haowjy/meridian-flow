# Lowering real AI rewrites

`lowering.probe.ts` takes 60 saved `deepseek-flash` rewrites (`lowering-cases.json`: 30
paragraphs from public-domain novels, each after one of two writer edits: a phrase inserted
(` of course`, ` quietly`, ` at last`) or a word retyped (`chamber`, `glanced`)) and lowers each with `lowerBlock`, the
editors read from the model's view as the write does. It applies the splices through
`replaceText`, the one text write, on a model's copy forked from the view, and imports the
update into the writer's doc. Run it when `resolver/lower-block.ts` or the text write changes:

```sh
pnpm --filter @meridian/agent-edit exec tsx .context/qa/lowering.probe.ts [--examples]
```

It first runs the cases review found, each against the result it must give, and prints `ok` or
`FAIL` per case: a letter typed into a word the AI grows while a neighbour is replaced
(`the cat dog ran` → `the cats hound ran`, `r` typed into `cat`, must give `the carts hound ran`),
two comments in one change with no space between them (`one, two` → `three—four`, and adjacent
CJK), a comment over a space a change takes in, and a comment on a word that grows. Then it
prints one row per typing pattern: the writer's typed word owns the space before it (` word`)
or after it (`word `). `--examples` prints each broken Undo, each comment that did not land on
whole replacement words, each misplaced concurrent word and each misplaced grown-word letter.

| column | what it measures |
|---|---|
| Ctrl+Z breaks AI words, AI words broken | The writer presses Ctrl+Z (raw `UndoManager.undo()`) after the AI's write. The target is the AI's text with the writer's edit taken back only where the AI kept it word for word; these count cases and AI words the result damages beyond that. |
| as asked, no-op | Undo gave exactly the target; Undo changed nothing. |
| kept-word comments right | Up to 6 comments per case on words the AI keeps: right when the comment covers exactly that word afterwards. |
| changed-word comments whole/fragment/lost | Up to 6 per case on words the probe's token alignment counts as replaced. `whole`: covers whole words inside the replacement. |
| concurrent in place/glued/displaced | The writer types one word after the read, before the write lands: beside the AI's copy of its neighbour, glued to a letter, or elsewhere. |
| typed in a grown word, in place | In cases where the AI only adds letters to the end of a word (by the probe's alignment), the writer types a letter after the word's first letter before the write lands: in place when it stays there in the AI's copy. |
| review off | Cases whose Review changes highlights differ from the AI's changes plus the writer's word. |
| ops | Mean Loro ops in the AI's change. |

Results on `feat/loro` before the space rule and the comment carry, then after (the grown-word
column was added with the fix round, and reads 11/13 under either lowering):

| typing | lowering | breaks AI words | words broken | as asked | kept right | changed whole/fragment/lost | concurrent | grown word | review off | ops |
|---|---|---|---|---|---|---|---|---|---|---|
| ` word` | before | 14/60 | 23 | 46 | 357/360 | 45/5/179 | 58/2/0 | | 2 | 12.9 |
| ` word` | after | 9/60 | 13 | 51 | 357/360 | 207/3/19 | 60/0/0 | 11/13 | 0 | 11.8 |
| `word ` | before | 14/60 | 22 | 46 | 357/360 | 45/5/179 | 59/1/0 | | 1 | 12.9 |
| `word ` | after | 9/60 | 11 | 51 | 357/360 | 207/3/19 | 58/2/0 | 11/13 | 2 | 11.8 |

How to read what is left:

- 7 of the 9 broken Undos restore a retyped word the AI deleted (`very` → `rather`, the AI
  deletes `rather`, Ctrl+Z puts `very` back between two AI words that share one space, so it
  glues to one). No lowering avoids this.
- The 19 lost comments are on words the word diff deletes with nothing in their place (`moment of
  the time so precious;` → `moment;`): the rule drops them. The probe's alignment, by
  whitespace tokens, counts those words as replaced.
- The 3 fragments land on a whole neighbouring word of the same change, or on punctuation that
  replaced the word (`--` → `—`).
- 3 kept-word comments read wrong under every lowering: the alignment pairs a repeated word
  (`the`, `and`) with another occurrence than the diff did.
- With `word ` typing, 2 concurrent words glue: the word typed during the write is not in the
  view, so its space falls to the default side.
- The 2 grown-word letters out of place are words the write rewrites whole by its rule: the word
  diff's change deletes letters (`they had` → `they'd`), or it pairs the word with another
  occurrence (`that`), so the letter stays where its word was deleted.
