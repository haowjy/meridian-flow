# Press-whole probes

Hand-run probes for [gate/press-whole](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/loro-build/gate/press-whole/README.md):
a press settles a draft's overrides by a record (`d.settled`), never by writing or deleting them.
Node, no stack. Run each with

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/press-whole/<probe>.mts
node packages/loro-prosemirror/.context/qa/press-whole/settled-race.mjs
```

- `probe.mts`: the shared setup (a Live room, its draft, the editor's commands through the real
  schema). Not a probe by itself.
- `race.mts`: the race the gate started from. A tab joins a paragraph back while the server's
  press applies the split; both copies must end with the text once. Prints `race settled on both
  copies`.
- `settled.mts`: Apply and Discard settle the draft's values without writing the overrides, a
  writer's write to a settled key unsettles it in the same commit, and the press's Undo puts the
  overrides back in force. Throws on a failed check.
- `map-size.mts`: what `d.settled` costs: 500 settled paragraphs are about 10 KB of entries.
- `settled-race.mjs`: Loro alone (review p19041). Setting a key to the value it holds writes no
  op; deleting an absent key writes one. A tab that never saw a Discard, redoing exactly the value
  the Discard settled, loses that redo when the press has the higher clock: the draft reads Live.
  Accepted (design §2): every copy agrees, nothing typed is lost, and the outcome is the one a
  Discard landing after the redo gives.
