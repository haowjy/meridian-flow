# @meridian/app

The authenticated writing workspace: a thin React/TanStack Start shell over
client contracts, stores and server-owned runtime behavior.

- Navigate first once a public address exists. Where only the server can assign
  the address, wait for it until a real neutral pending destination exists; don't
  mount a fabricated route to navigate early.
- New persistent state picks a tier before it ships ([state tiers][state-tiers]).
- Choose a command's lifecycle before wiring it ([writer commands][commands]).
  A command the server may not have received is a kind on the command driver
  (`client/commands/`, `@meridian/command-driver`), as Work commands are: the driver
  delivers it, the domain projects its unsettled records over its own data.
- `/_authenticated` mounts one unconditional provider tree. Gating a provider by
  pathname drops `ThreadStoreProvider` during transitions.
- When a shadcn primitive fits, adopt or extend its API in `components/ui/` and
  keep any deviation local. Product-specific density stays at the usage site
  until it recurs.
- A new line the writer clicks in a list is a `ListRow` (`components/ui/list-row.tsx`): it
  owns height, fills, focus ring, the current look and the leading `icon` slot, and its list
  owns the inset. The line that stands in for the rows (loading, empty, no matches) is
  `ListLine` beside it, inside the same inset. Drop handlers go through `frameProps`, actions through `menu`,
  rename in place through `ListRowField`.
- A new list the writer picks one thing from (a Work, an Agent, a chat) is built from
  `components/ui/picker.tsx`, which owns its keys and ARIA; its rows are
  `<li><ListRow density="menu" /></li>`. A menu of actions
  stays a Radix `DropdownMenu`.
- Icon-only controls use `IconButton`'s tooltip. A tooltip shouldn't overlap the
  content its button acts on, so the action row under a turn opens its tooltips below the row.

## Writer-facing screens

- Separate adjacent facts with layout, typography, sentences, or parentheses, not
  metadata-style `·`, `•`, `—`, or `|`; `pnpm check:slop-lint` fails on a middle dot and
  allows no exception ([copy and feedback][copy-and-feedback]).
- A row or menu shows only the actions that can succeed now; a fixed toolbar
  greys one instead, with the reason on hover. Feedback doesn't push content down
  ([copy and feedback][copy-and-feedback]).
- A pill (`notifyFailure`, `EditorNoticePill`) or an inline notice is one short line naming the failure's category,
  one wording per category: "Couldn't <verb>" for the writer's action (save, open, create, copy,
  apply, discard, undo, redo, restore, import, upload, download, log out), "Sign-in expired",
  "Can't drop here", "File too large", "Not an image". No cause, consequence or instruction:
  the cause goes to the console (`detail`), except a two-to-four-word `reason` where Retry would
  fail the same way ("Couldn't import" with "Too many imports"). No pill when the screen
  already shows the state, the thing settles by itself, or the writer has nothing to do about it.
  The only other pills are the editor's: "Copied" and "Downloaded" for a verb that leaves nothing
  on screen, and "Passage changed". A pill never carries words or a Copy:
  what could not be saved is lost, and the pill says so. A drag hint at the pointer is not a pill: it says why that spot refuses
  ("Can't put that inside code"), so the writer can pick another.
- A list row is one line until it has something to say
  ([copy and feedback][copy-and-feedback]).

Depth: [architecture and contracts](.context/CONTEXT.md),
[performance traps](.context/frontend-perf.md),
[visual conventions](.context/visual-conventions.md),
[deferred work](.context/TODO.md).

[state-tiers]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/state-tier-contract.md
[commands]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/architecture/optimistic-commands.md
[copy-and-feedback]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/product/copy-and-feedback.md
