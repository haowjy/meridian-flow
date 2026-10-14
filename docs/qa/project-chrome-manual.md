# Project chrome and shell: manual checks

These are the screen checks that replaced the unit tests deleted from `apps/app`
for being the slowest files in the suite: nine DOM-mounting files at 250 to 1100
ms against a 41 ms median.

Only the parts that are genuinely about what the writer sees live here. The
durable halves of those same files moved to [`runtime-probes.md`](runtime-probes.md)
as **RP-13** (apply one change row then Discard all, no prose moves) and **RP-14**
(Work archive, unarchive and delete are durable, reversible and idempotent),
because `./mf` reads durable state directly and a runnable probe beats a
checklist. Do not re-check those two by hand; run the probes.

Run these against an owned worktree and stack. Discover URLs with
`pnpm portless:list`. Use the mock model.

## Work rows: the Undo affordance

1. Delete two Work rows. **Undo one.** That row comes back and **the other Undo
   row stays** where it was.
2. Dismiss the remaining Undo row. It goes away without undoing anything else.

(Durability of the delete itself is RP-14. Undo is client-side, which is why it
stays here.)

## Work rows: filters

3. Open a Work with several change rows and apply one. Then activate a row filter
   and use **Discard all**. Every draft goes and the filter does not cause anything
   to be applied.

(RP-13 proves no prose moves. This check is only about the filter's effect on the
row list, which a document read cannot see.)

## Phone review sheet

4. On a phone viewport, open a document with review changes. Focus a change through
   the sheet, then **Discard** the whole draft from the sheet. The editor stays
   present through the discard.
5. Review the **last** change in the sheet. The sheet closes and does not repeat the
   attribution line.
6. With two drafts on the phone, one live and one under review, the hint names **the
   other draft**, never the one being reviewed.

## Composer

7. While a reply runs, the composer has **one button**. With the box empty it is
   **Stop**. Type text and it becomes **Send**, with the running ring. Clear the box
   and **Stop** returns. Stopping and "Couldn't stop. Try again." show **on the Stop
   button**. Type while the failure shows and the button is Send. Clear the box and
   the failed Stop returns. Press Escape with the box empty and it **stops the reply**.
   Press Escape with text in the box and the run and the **draft are both left alone**.
8. Send `/compact <instructions>`. It goes as a **command, never as a message**.
9. On a surface that registers no verbs, send text starting with `/compact`. It goes
   as a **message**.
10. Accept a presentation, then check that clearing it does **not publish an empty
    draft over another pane's writing**.
11. Send words the server rejects. The **rejected words stay visible** and the pane
    does not take over their lifecycle.
12. Refuse a recording. It draws as the **failure card**, and the card clears once a
    send is recorded.

## Draft dock and review doors

13. Accept a batch of draft targets, then apply. **All accepted targets disappear at
    the click**; a refused target restores **independently** of the rest.
14. Create a new document. It has **one review door**, and whole-draft commands appear
    in chat and in Work rows.

## Project shell and dock

15. Retained document A with B pending, switch to Chat: the **retained A** moves to
    Chat, not the pending B.
16. Hide a pane. It **carries nothing** with it.
17. From Work Files, follow the rail to Chat. The document follows.
18. Collapse an occupant, then switch screens. The collapsed occupant **carries
    nothing**.
19. Cancel a dock intent, and separately supersede one. In both cases the document
    stays and **no failure appears**.
20. Force admission to fail. The screen **stays on Editor**, the dock stays, and
    **Retry clears the failure**.
    - The dock header has no `…` "Document actions" menu: **Open in Editor** is a
      direct button, and **Collapse** is pinned to the right with the review controls
      wrapping or shrinking beside it.
    - When Open in Editor fails, "This view couldn't open." shows as **a line under
      the header**, tied to the button, and Collapse comes before the review controls
      in tab order.
21. Issue a new dock intent while a tab install is in flight. The newer intent wins
    and the tab still installs.
22. Navigate same-screen after a source rail action. The feedback **expires**;
    ordinary opens do not opt into it.
23. Replace document A with B and then back to A. The header feedback **expires
    permanently**.
24. Park an occupant for another project, and separately for Work. Neither receives
    the document; a parked Chat occupant is left alone.

## Write mode

Work has no Work-level write-mode control and no "Apply it now or keep them for
review?" confirmation; each chat owns its write mode.

31. Open a Work page. It **shows no write-mode control**. Open a chat in it: the
    composer has a **Draft or Auto-apply menu** showing "Draft (N)" while N changes
    wait for review. Switching one chat's mode leaves the others as they were.

## Rename feedback and hand-off

25. Move a folder whose record is missing locally, then let a fresh receipt arrive.
    The **first folder move shows**.
26. Rename a document, then move it, so the receipt is rebased onto a new identity.
    The feedback appears **at the reminted identity**.

    (The durable identity claim is still covered by
    `document-address-canonical.test.ts`, which was not deleted.)
27. Hand a visible document off between panes, draft-only and live. **Review follows
    both hand-offs.**

## Frame hold

28. Trigger a pending hand-off that paints a held frame. The **whole frame holds**,
    then swaps in the ending commit.
29. Move the page with changes warm and unseen. They are **dropped, not painted**,
    and a painted copy is reused across synchronous precursor commits.
30. Move a held copy a second time. The **first copy is kept**, and it releases on a
    terminal surface.

## What these checks do not cover

State machines that are neither screen behavior nor `./mf` durable state:
tab-session availability, account stamping and hydration, restore claims across
accounts, `Untitled` restoration against a hydrated local resource, and storage
that throws on read or write. Those live in
`apps/app/src/features/project/dock/dock-restoration.test.ts` and its neighbours,
which are still present.

If a check here turns out to be impractical to drive by hand, say so and it should
become a probe recipe instead of quietly staying unrun.
