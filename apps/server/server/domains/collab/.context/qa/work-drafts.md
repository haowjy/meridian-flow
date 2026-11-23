# A Work's drafts and the press

Two hand-run probes for a Work's several drafts and the press over them. Run them when
`adapters/drizzle-work-drafts.ts`, `shared/draft-owner.ts`, `adapters/drizzle-press.ts`, a fork's
save (`rooms/postgres-document-rooms.ts`) or the pending counts change.

## On a scratch database

[`scripts/probe-work-drafts.ts`](../../../../../scripts/probe-work-drafts.ts) runs the production adapters (`createDrizzleWorkDrafts`,
the rooms, the Works boundary, the thread-Works repository) over its own `lfd_probe_*` database
and prints one line per check. No stack.

```sh
pnpm dev:infra   # Postgres
node --import tsx apps/server/scripts/probe-work-drafts.ts
```

| Check | What it shows |
|---|---|
| `setChatDraft` names one of the Work's drafts | The chat's root names it, under the Work's row |
| Delete draft lists the draft nowhere; a chat on it names the default | `remove` |
| `setChatDraft` does not name a deleted draft | Its update joins only living drafts |
| Its Undo lists the draft again and leaves the chat where it is | `restore` (design decision: chats don't move back) |
| 25 races of `setChatDraft` and Delete draft | Both take the Work's row first, so no chat ends up naming a deleted draft |
| The purge takes the draft deleted 31 days ago; the racing save settles | A tab's typing in the draft's loaded fork saves while the purge runs: the purge takes the fork's document key before it deletes, and the save reads the draft under that key without a row lock (the lock order in `CONTEXT.md`), so neither waits on the other |
| The draft, its fork row and its fork's rows are gone; a save for a purged draft writes nothing | The trigger takes the fork's snapshots; a later save finds no draft and writes no row |
| An unshared draft moves with its chat; the move recounts both Works | `carryRootDraft` answers the Works the draft left and joined, and the binding recounts them after commit |

## On a running stack

[`press-on-the-stack.sh`](press-on-the-stack.sh) drives the HTTP routes with `./mf` on the mock
model, in a new Work each run. It needs a stack of its own.

```sh
MODEL_PROVIDER=mock pnpm dev
bash apps/server/server/domains/collab/.context/qa/press-on-the-stack.sh
```

| Check | What it shows |
|---|---|
| `PUT /api/threads/:id/draft` names the Work's second draft | A Draft chat writes into the draft it names |
| A draft-created paragraph applied alone lands with its text | `applyBlocks` on a `change` scope whose block only the fork has |
| The second draft counts its pending document; the Work counts both | A fork save that turns its pending flag on recounts the draft's owner (`onForkPendingChanged`) |
| Apply all lands both drafts, leaves no fork pending, the Work's count is 0 | The `work` scope presses each draft in id order |
| Its Undo leaves nothing and gives Live its text back; both forks are pending again | The Undo, draft by draft, newest first |
| The Undo names the chat that wrote over; each change it left is named by an id; the chat's text stays | `stayed[].by` from the commit messages on the change's text |
| A change whose letters a chat's rewrite kept stays, and Live keeps the chat's text | `editStays` part 4: a later write that deleted any of what the change put in keeps it ("Chapter four closes at dusk…" to "Night falls on chapter four." once came back as `NightThefalls onchpersecondparagraphofchapterfourfour.`) |

Not covered here: a tab's typing over a pressed change (`by: writer`) needs a socket client, and a
server write with no commit message (a restore, a copy) names no one; both are read in
`overwriters` in `drizzle-press.ts`.
