# Remember a chapter's place

Run `pnpm dev` in the owned worktree and discover its HTTPS app route with
`pnpm portless:list`. Sign in through `/dev-login`. Seed a long chapter:

```bash
./mf doc put manuscript://reading-position.md --text @/tmp/long-chapter.md
```

1. Open the chapter in Editor. Scroll halfway and place the caret mid-paragraph
   (also try a backwards selection). Reload. Expect the same text at the top
   of the viewport and the same editor selection, without taking focus.
2. Open another chapter and return. Close and reopen the tab, then open the
   chapter's URL in a new browser tab. Expect the remembered place. Warm tabs
   retain their DOM instead of rereading device memory.
3. Switch to Chat, carrying the chapter into the side panel. Expect the same
   text despite its narrower width. Move the caret and scroll there, reload,
   and open the chapter from the tree again. Expect the side panel's latest
   place. Dock document arrangement is a separate persistence contract.
4. From another tab/peer, insert paragraphs above the remembered text.
   Close and reopen the chapter. Expect the same text and caret, not the
   former paragraph number. Change pane width or device text size and repeat.
5. Delete the remembered paragraph from the other peer and reopen. Expect a
   surviving position or the top, never an error.
6. Open a Changes card, a search passage, or an inline draft review. Expect
   that target, not device memory. A URL with `?draft=` or a fragment suppresses
   restoration. Heading targeting itself is not implemented by the current
   internal-link follower; this lane does not add it.
7. Block localStorage, or replace the account's `meridian:reading-position:v1`
   record with malformed JSON. Opening and writing must still work. Sign in
   as another account: it must not restore the first account's places.

At the core seam, run:

```bash
pnpm exec vitest run apps/app/src/core/editor/reading-position.test.ts apps/app/src/core/editor/use-reading-position.test.tsx apps/app/src/features/editor/EditorView.lifetime.test.tsx
```

The tests protect shared-view restore, collaborative insertions/deletions,
selection direction, resized viewport offsets, explicit-target precedence,
account isolation, LRU, denied storage, pagehide flushing and warm-view lifetime.
Stop the stack with `pnpm dev --stop`.
