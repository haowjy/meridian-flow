# features/project/dock — Dock view container

## Purpose

The right dock is a **container** that sits in the project shell's `dock` grid
slot and holds one occupant: the chat on Work and Editor, the context rail on
Chat. It owns the header row, the view store and, on Work, the transient file
view. It has no Changes view: each scope of draft review has its own surface
(the chat's composer strip, the document's list in its identity row and the
phone sheet, the Work page's Changes to review), and the dock keeps no draft
review state.

This is NOT the chat surface or the context rail: those are the dock's
*occupants* (`ChatSurface`, `ContextSidebar`), wrapped by `DockShell`.

## Mental model

`DockShell` wraps the dock occupant's native body in both placements:

- **`center` placement**: passthrough, no header. The occupant is a normal
  center pane. This keeps the chat surface at the same tree depth across
  center↔dock moves so React never reconciles it away.
- **`dock` placement**: the caller-supplied header slot renders (`DockHeader`
  on desktop, `mobile/MobileChatSheetHeader` for the phone chat sheet). On Work,
  a Scratch or Uploads file opened from the page adds a transient **File** view;
  the occupant's body **stays mounted**, hidden and inert, while it shows.

The dock's views are a function of the screen (`resolveDockView`): Work `[chat]`,
Chat `[context]`, Editor `[chat]`, plus `file` on Work while a file is open. The
segmented switch exists only when there are two (Work with a file: Chat and
File); otherwise the header is the occupant's own (the chat's, or the context
rail's) and shows no switch.

## Key rules

1. **Surface-parking invariant.** The occupant's native body (`children`) must
   sit at the same React tree depth in both center and dock placements. A
   placement change is a grid-area move, never a remount. If the dock occupant
   relies on a different wrapper for center vs. dock, the invariant is broken.

2. **Primary body stays mounted under the file view.** Do not unmount `children`
   when `view === "file"`: hide it (opacity-0, inert). Chat state and document
   sessions must survive a view switch.

3. **resolveDockView is a pure function.** `resolveDockView(screen, hasFile)`
   has no React dependency and is testable in isolation.

4. **Session-only store.** `useDockViewStore` has no `persist`: the transient
   file slot does not survive a reload. Placement, width, and collapse are owned
   by the surface-prefs store.

5. **One label source.** `DockViewLabel` is the single place dock view labels
   are spelled, and `DockViewSwitch` is the one place that renders the segmented
   switch (`components/ui/segmented-tabs`, shared with the chat index filter).
   The left slot belongs to the occupant: the chat puts its switcher there.
   `DockShell`'s `renderHeader` slot is what lets the phone chat sheet use its
   own header (`mobile/MobileChatSheetHeader`) instead of `DockHeader`, which
   stays desktop-only.

6. **The switch stays inside the dock material.** Its recessed track provides
   a complete boundary. The active segment may use page paper only inside that
   boundary; it never connects to the page like a tab chip.

## Anti-patterns

- **Don't unmount the primary body.** It breaks the surface-parking invariant
  and loses chat state.
- **Don't put draft review state or a Changes list in the dock.** Draft review
  lives in each scope's own surface: the composer strip, the document's identity
  row (the change sheet on the phone), and the Work page.
- **Don't persist the dock view choice.** A stale view across reloads is worse
  than starting fresh.
- **Don't add a tailwind-merge dependency on `border-border-subtle`.** See the
  tailwind-merge trap in `.context/CONTEXT.md`.

## Downlinks

- [`.context/CONTEXT.md`](.context/CONTEXT.md) — contracts, architecture, tailwind-merge trap
- [`../.context/CONTEXT.md`](../.context/CONTEXT.md) — project shell layout, slot topology, surface-prefs store
- [`../../draft-review/AGENTS.md`](../../draft-review/AGENTS.md) — draft review controller, provider, change lists
- [`../../chat/AGENTS.md`](../../chat/AGENTS.md) — the DraftDock composer strip
- [`../work/WorkChanges.tsx`](../work/WorkChanges.tsx) — the Work page's Changes to review
- [`../../editor/DraftReviewBand.tsx`](../../editor/DraftReviewBand.tsx) — the review controls inside the identity row
- [KB: Draft Review Commands Keep Authority on the Server](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-review-command-authority.md)

## Review launch

The selected review, or an admissible launch intent, is the requested review on
both shells: same Work, manuscript scheme, same document. Admission does not
wait for the draft list; the review's fresh entry read owns absence. The launch
and address owners own no paint state. Pane continuity belongs to
[`PaintHold`](../../../components/app/PaintHold.md); navigation stays outside it.

A launch may name `focusOperationIds`. The claimant that enters the review
mounts `FocusOpenedReview`, which focuses and scrolls to the change holding
them once, when that very review has painted and its preview has loaded. A
review being left that is still painted is never focused, and ids no longer in
the preview open the review at the top. The route can settle before the Editor
has mounted the document, with the address already naming the draft: the address
owner restores no review for a draft whose launch is still unclaimed
(`usePendingEditorReviewDraftId`), because a restore is a second launch and the
latest launch decides the focus.
