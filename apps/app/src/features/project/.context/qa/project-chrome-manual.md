# Project chrome and shell: manual checks

Run these against an owned worktree and stack. Discover URLs with
`pnpm portless:list`. Use the mock model.

## Work rows: the Undo affordance

1. Delete two Work rows. **Undo one.** That row comes back and **the other Undo
   row stays** where it was.
2. Dismiss the remaining Undo row. It goes away without undoing anything else.

## Work rows: filters

3. Open a Work with several change rows and apply one. Then activate a row filter
   and use **Discard all**. Every draft goes and the filter does not cause anything
   to be applied.

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
   and **Stop** returns. Stopping is the button's **spinning ring**, with no text beside it. A failed Stop is
   a red **"Couldn't stop the reply."** card above the box with **Try again**. Type while
   the card shows and it stays, with the button Send. Clear the box and the button is Stop again. Press Escape with the box empty and it **stops the reply**.
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
14. Create a new document. It has **one review door**, and Apply all and Discard all appear
    in chat and in Work rows.

## Project shell and dock

15. Retained document A with B pending, flip the sidebar's Write | Chat switch: the
    **address, main and the dock do not change**, and the sidebar shows the other list.
16. Hide a pane. It **carries nothing** with it.
17. From Work Files, pick a chat row in the Chat list. **Main goes to that chat**; the
    document it replaced is one Back away.
18. Collapse an occupant, then flip the switch. The collapsed occupant stays collapsed
    and **carries nothing**.
19. Cancel a dock intent, and separately supersede one. In both cases the document
    stays and **no failure appears**.
20. Force Open in Editor from the dock to fail. Main **stays where it was**, the dock
    stays, and **Retry clears the failure**.
    - The dock header has no `…` "Document actions" menu: **Open in Editor** is a
      direct button, and **Collapse** is pinned to the right with the review controls
      wrapping or shrinking beside it.
    - When Open in Editor fails, "This view couldn’t open." shows as **a line under
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

25. Open a Work page. It **shows no write-mode control**. Open a chat in it: the
    composer has a **Draft or Auto-apply menu** showing "Drafts (N)" while N changes
    wait for review. Switching one chat's mode leaves the others as they were.

## Creation, Work goals, and account settings

26. Hold a new project's create request. The app navigates to that project's
    Chat screen before the request settles. Refuse the request. The destination
    stays open and offers Retry. Retry uses the same project identity and title.
27. Edit a Work goal, then try to leave before saving. Choose to keep editing;
    the goal remains. Try again and discard it; navigation continues. In one
    client, edit the goal and hold its Save request. Archive the Work from a
    second client, then deliver the Save refusal before the first client receives
    the archive update, while it still shows the Work as active. The draft
    remains without exposing the raw server error.
28. Hold the account-settings request open. Settings that require the account
    record, including Sync, remain disabled until the request settles.

## Rename feedback and hand-off

29. Move a folder whose record is missing locally, then let a fresh receipt arrive.
    The **first folder move shows**.
30. Rename a document, then move it, so the receipt is rebased onto a new identity.
    The feedback appears **at the reminted identity**.

31. Hand a visible document off between panes, draft-only and live. **Review follows
    both hand-offs.**

## Frame hold

32. Trigger a pending hand-off that paints a held frame. The **whole frame holds**,
    then swaps in the ending commit.
33. Move the page with changes warm and unseen. They are **dropped, not painted**,
    and a painted copy is reused across synchronous precursor commits.
34. Move a held copy a second time. The **first copy is kept**, and it releases on a
    terminal surface.

## Account preferences

35. Change language and theme separately, reload, and confirm each choice persists without changing the other. Disable automatic reply resume, reload, and confirm it remains off. Try an unsupported value through the request boundary and confirm the saved preferences remain unchanged.

## Chat list activity

36. Open the project chat list beside two chats with distinct last-message times. Complete a reply in the older chat: it becomes the most recent and previews that conversation. Produce a hidden Work-context update and a background subagent completion: neither moves the chat nor replaces its preview. Move on from a failed reply: the abandoned exchange disappears from the preview. Switch to an earlier sibling response: the chat activity follows the selected response. Trash a direct child chat: it disappears from its parent’s activity, while a fork still shows inherited turns after its source is trashed.
