# @meridian/app

The authenticated writing workspace: a thin React/TanStack Start shell over
client contracts, stores and server-owned runtime behavior.

- Navigate first once a public address exists. Where only the server can assign
  the address, wait for it until a real neutral pending destination exists; don't
  mount a fabricated route to navigate early.
- New persistent state picks a tier before it ships ([state tiers][state-tiers]).
- Choose a command's lifecycle before wiring it ([writer commands][commands]).
  Command records that outlive their caller, stack per entity, or share one
  failure across surfaces go in a per-domain record store, as Work commands do.
- `/_authenticated` mounts one unconditional provider tree. Gating a provider by
  pathname drops `ThreadStoreProvider` during transitions.
- When a shadcn primitive fits, adopt or extend its API in `components/ui/` and
  keep any deviation local. Product-specific density stays at the usage site
  until it recurs.
- A new line the writer clicks in a list is a `ListRow` (`components/ui/list-row.tsx`): it
  owns height, fills, focus ring, the current look and the leading `icon` slot, and its list
  owns the inset. The line that stands in for the rows (loading, empty, no matches) is
  `ListLine` beside it, inside the same inset. The file tree's rows are the exception (drag
  targets, rename in place). Not yet moved onto it: `DocumentRow` (`ContextTreeRows.tsx`: the
  trees' files and Trash) and `WorkspaceNavBody`'s rows.
- A new list the writer picks one thing from (a Work, an Agent, a chat) is built from
  `components/ui/picker.tsx`, which owns its keys and ARIA; its rows are
  `<li><ListRow density="menu" /></li>`. A menu of actions
  stays a Radix `DropdownMenu`. Not yet moved onto it: `WorkScopePicker` (a `DropdownMenu`),
  and `FileSuggestionList` and the editor's `SuggestionMenu`, which keep their own listbox
  (the first shares the pickers' keys through `list-keys.ts`).
- Icon-only controls use `IconButton`'s tooltip. A tooltip shouldn't overlap the
  content its button acts on, so the action row under a turn opens its tooltips below the row.

## Writer-facing screens

- Separate adjacent facts with layout, typography, sentences, or parentheses, not
  metadata-style `·`, `•`, `—`, or `|`. A file-detail row may keep `·` with a
  colocated `slop-lint: allow middle-dot file-detail row` comment
  ([copy and feedback][copy-and-feedback]).
- A row or menu shows only the actions that can succeed now; a fixed toolbar
  greys one instead, with the reason on hover. Feedback doesn't push content down
  ([copy and feedback][copy-and-feedback]).
- A list row is one line until it has something to say
  ([copy and feedback][copy-and-feedback]).

Depth: [architecture and contracts](.context/CONTEXT.md),
[performance traps](.context/frontend-perf.md),
[visual conventions](.context/visual-conventions.md),
[deferred work](.context/TODO.md).

[state-tiers]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/state-tier-contract.md
[commands]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/optimistic-commands.md
[copy-and-feedback]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/copy-and-feedback.md
