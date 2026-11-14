# Sidebar version: the Live/Draft toggle

The shell's one version state above a single document (`features/project/tree-version.tsx`).
It decides which tree every sidebar source shows and acts on, and main's page follows it when
it is flipped. Change the code and this page together.

## State

- **choice** (`live` | `draft`): the writer's, kept per (account, project) in this browser tab
  and seeded from the device (`client/project-shell/store.ts`, `tree-version`).
- **offered**: the picked Work (or, under None, the chat on screen's: its Work's drafts, or its
  own when it has no Work) has an active branch with something pending: a drafted document in its list, or a pending tree record in the browser's
  copy (a folder change alone lists no document).
- **showing** = `draft` when offered and choice is `draft`, else `live`. Nothing else reads the
  choice.

```mermaid
stateDiagram-v2
    [*] --> Live
    Live --> Draft: toggle, Show draft, the Work's draft picked in the chip, or one of its drafts opened
    Draft --> Live: toggle, or Live picked in the chip
    Draft --> Live: Work picked (choice reset)
    Draft --> ShownLive: nothing pending (choice kept)
    ShownLive --> Draft: something pending again
    ShownLive --> Live: Work picked
```

## Rules

- On **Draft** the sidebar's trees are the Work's view, replayed in the browser
  (`TreeListSession.replay(view, pendingText)`), and every `TreeActions` record carries the
  Work's branch as `draft`. On **Live** they are live. Trash restore stays live: Trash lists
  live's Trash.
- **Flipping** moves main's document to the Work's draft of it (a pin, as the version menu
  does) or back to Live; a document live has no version of keeps its draft.
- **The page's version chip is the same state.** Picking the Work's draft or Live in its menu
  sets the toggle, and opening any of the Work's drafts (a Changes row, the chat's dock, a
  review link: `review-launch.tsx`) puts it on Draft. The chip on Live is neutral with a jade
  dot while a draft waits, jade on Draft.
- **On Live** each row the Work changes carries a jade dot, and a page the Work drafts says
  what the draft does to it with Show draft (`LiveDraftNotice`). A page the draft created stays
  on its draft and says live has no version of it; its chip reads Draft.
- **The Work chip** under None names the chat's Work when its drafts drive the toggle, with the
  count Changes shows; the pick itself stays None.
- **A Work pick** returns the toggle to Live with every page (`returnDraftsToLive`).
- **An archived or deleted Work stays picked** (`use-work-scope.ts`): only the writer's pick
  changes the scope, here or on another device. The chip says Archived or Deleted with Unarchive
  or Restore in its menu; Changes and the Draft view show its draft read-only (`TreeVersion.ended`
  refuses every tree action there with its reason).
- The sidebar's **Ctrl+Z** takes back the latest step of the source on screen made in the view
  showing (`core/project-tree/tree-undo.ts`). The stack is record ids per list copy, in memory;
  a reload empties it. A step `undoChange` refuses is dropped with a notice and the press goes
  on to the one before it. A change since applied is taken back live. An Apply is one step in
  either view: the press asks the server's Un-Apply, and a refusal (the tree changed since) is
  skipped the same way; on the Changes tab a press takes the latest step of any source.

A wrong edit here shows one tree in the sidebar while actions write into another.
