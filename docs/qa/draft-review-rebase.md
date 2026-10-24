# Fresh draft seeds, content rebases and late typing

Run from the checkout under review:

```sh
pnpm exec tsx tools/qa/probes/draft-review-r/run.mts
```

The runner creates, migrates and drops a scratch PostgreSQL database. It calls
production draft creation, the writer/agent append doors, the debounced pull
service, committed-live journal reads, the effect job and the exact inverse
adapter. It does not replace them with memory stores. Ten labelled acceptance
rows must pass:

1. Two writers queue behind a held 50,000-word content rebase, with a low-similarity
   rewrite and a paragraph changed to a heading. Each writer's typing survives once.
2. Already committed writer and agent typing moves into the new heading, once each.
3. A frame authored before the heading rebase arrives afterward, followed by the
   next character in a later frame. One recovered paragraph extends beside the
   heading; resending the same reconnect state writes nothing.
4. Typing under another writer's deleted paragraph is not recovered.
5. Live acquires the draft's only change; the rebase drops `has_effect` without a key.
6. A reconnect with unsent typing and server-owned base tombstones is admitted.
7. Model Undo on the fresh-seeded draft leaves the base once, with no live duplication.

The seed assertion checks only client 1 authored its items and the two fragments
start equal. The runner prints append hold/wait observations for the large case;
these are observations, not the separate repeated hold-time performance gate.
Three additional rows cover deletion-only incremental frames, a contained
separator deletion during the receipt read, and a deferred contained-frame
observer overtaken by newer recovered typing. No permanent test cases are added
by this recipe.

## Browser confirmation

After the API/kernel rows, run a fresh stack pinned to the implementation commit
(`pnpm dev`, discover it with `pnpm portless:list`). Use `./mf` to create a Work,
thread and document, propose an AI edit, and open its Work draft in the browser.
Type in the draft. Edit live in another tab, then wait for the rebase. Confirm
both texts appear once, the draft remains connected, and Ctrl+Z reverses only
writer typing. Reload to confirm durable content. Save screenshots and the
`./mf` durable readback in the work-item evidence, not this source directory.
The browser is a separate writer-flow confirmation; the runner is server/store
verification, not proof of rendering or native keyboard history.
