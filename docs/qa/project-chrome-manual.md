# Project chrome and shell: manual checks

These checks replace the unit tests that were deleted from `apps/app` for being the
slowest files in the suite. Nine DOM-mounting files (median suite file: 41 ms;
these: 250 to 1100 ms) carried 53 cases and 56% of the `apps/app` test time. Each
case below is a behavior those files asserted, rewritten as something to watch on
screen.

They are manual because a browser is the only thing that can judge them: every one
is about what the writer sees after an action, a reload, a rail or tab switch, or a
refused operation. Judging them needs the durable transcript and the real screen,
not a jsdom render.

Run against an owned worktree and stack. Discover URLs with `pnpm portless:list`.
Use the mock model for everything except the rename check, which needs a real
identity change.

## Work rows: archive, delete, undo

1. Archive a Work row. The row **moves out of the list at the click**, before the
   server answers. Check the list immediately, not after a pause.
2. Force the archive to fail. The row **returns to its old place with an error**, and
   the error sits on that row.
3. Retry the failed archive. It succeeds and the row leaves again.
4. Delete two Work rows. **Undo one.** That row comes back and **the other Undo row
   stays** where it was.
5. Dismiss the remaining Undo row. It goes away without undoing anything else.

## Work rows: change rows, apply and discard

6. Open a Work with several change rows, at least one never opened. **Apply one
   unopened row**, then **Discard all** while a filter is active. Every draft goes,
   and **no prose moves** in the document.

## Phone review sheet

7. On a phone viewport, open a document with review changes. Focus a change through
   the sheet, then **Discard** the whole draft from the sheet. The editor stays
   present through the discard.
8. Review the **last** change in the sheet. The sheet closes and does not repeat the
   attribution line.
9. With two drafts on the phone, one live and one under review, the hint names
   **the other draft**, never the one being reviewed.

## Composer

10. Type a draft and press Escape. The run and the **draft are both left alone**.
11. Send `/compact <instructions>`. It goes as a **command, never as a message**.
12. On a surface that registers no verbs, send text starting with `/compact`. It goes
    as a **message**.
13. Accept a presentation, then check that clearing it does **not publish an empty
    draft over another pane's writing**.
14. Send words the server rejects. The **rejected words stay visible** and the pane
    does not take over their lifecycle.
15. Refuse a recording. It draws as the **failure card**, and the card clears once a
    send is recorded.

## Draft dock and review doors

16. Accept a batch of draft targets, then click apply. **All accepted targets
    disappear at the click**; a refused target restores **independently** of the rest.
17. Create a new document. It has **one review door**, and whole-draft commands appear
    in chat and in Work rows.

## Project shell and dock

18. Retained document A with B pending, switch to Chat: the **retained A** moves to
    Chat, not the pending B.
19. Hide a pane. It **carries nothing** with it.
20. From Work Files, follow the rail to Chat. The document follows.
21. Collapse an occupant, then switch screens. The collapsed occupant **carries
    nothing**.
22. Cancel a dock intent, and separately supersede one. In both cases the document
    stays and **no failure appears**.
23. Force admission to fail. The screen **stays on Editor**, the dock stays, and
    **Retry clears the failure**.
24. Issue a new dock intent while a tab install is in flight. The newer intent wins
    and the tab still installs.
25. Navigate same-screen after a source rail action. The feedback **expires**;
    ordinary opens do not opt into it.
26. Replace document A with B and then back to A. The header feedback **expires
    permanently**.
27. Park an occupant for another project, and separately for Work. Neither receives
    the document; a parked Chat occupant is left alone.

## Rename and move feedback

28. Move a folder whose record is missing locally, then let a fresh receipt arrive.
    The **first folder move shows**.
29. Rename a document, then move it, so the receipt is rebased onto a new identity.
    The feedback appears **at the reminted identity**.

## Hand-off and frame hold

30. Hand a visible document off between panes, draft-only and live. **Review follows
    both hand-offs.**
31. Trigger a pending hand-off that paints a held frame. The **whole frame holds**,
    then swaps in the ending commit.
32. Move the page with changes warm and unseen. They are **dropped, not painted**,
    and a painted copy is reused across synchronous precursor commits.
33. Move a held copy a second time. The **first copy is kept**, and it releases on a
    terminal surface.

## What these checks do not cover

The deleted files also asserted state machines that are hard to drive by hand:
tab-session availability, account stamping and hydration, restore claims across
accounts, `Untitled` restoration against a hydrated local resource, and storage that
throws on read or write. Those live in `apps/app/src/features/project/dock/dock-restoration.test.ts`
and its neighbours, which are still present.

If a check above turns out to be impractical to drive by hand, say so and it should
become a probe recipe instead of quietly staying unrun.
