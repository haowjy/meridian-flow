# Concurrent typing in one paragraph

`concurrent-typing.probe.ts` mounts two real TipTap editors on two `Y.Doc`s, puts both cursors
at the end of `Start `, and has one type `Alpha ` and the other `Bravo `, a key at a time, with
each side's updates delivered every 1, 2, 3 or 6 keys. Both documents must end as
`Start Alpha Bravo ` or `Start Bravo Alpha `, each word whole and in order.

It guards the cursor the binding restores after a remote update. `@tiptap/y-tiptap` 3.3.0 treats
any text change in the cursor's block as a misresolved position and re-places the cursor at its
old offset when the block has a non-default attribute (every Flow block has an `id`). The
writer's next keys then land in the middle of their own word: `Start AlphaovBar `. The patch
keeps the position Yjs resolves when it is in the block with the same `id`.

No database, dev stack or browser. Run it when the y-tiptap patch or `restoreRelativeSelection`
changes:

```bash
cd apps/app
pnpm exec vitest run --config src/core/editor/.context/qa/concurrent-typing.vitest.config.ts
```

Upstream: [tiptap#8594](https://github.com/ueberdosis/tiptap/issues/8594) reports the same bug, open as of 2026-11-16. When a y-tiptap release fixes it, drop the `recoverSelectionEndpoint` change from the patch and keep this probe.
