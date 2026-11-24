# Press-whole probes

Hand-run probes for [gate/press-whole](https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/loro-build/gate/press-whole/README.md):
a press deletes the draft overrides it read, and a tab's write that races it wins or loses by
last writer wins, the same on every copy. Node, no stack. Run each with

```sh
pnpm --filter @meridian/loro-prosemirror exec tsx .context/qa/press-whole/<probe>.mts
```

- `probe.mts`: the shared setup (a Live room, its draft, the editor's commands through the real
  schema). Not a probe by itself.
- `race.mts`: the race the gate started from. A tab joins a paragraph back while the server's
  press applies the split; both copies must end with the text once. Prints `race settled on both
  copies`.
