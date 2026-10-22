# Chat Files menu

The Files dropdown combines shared Scratch and files attached in this chat. Use the
lane's `pnpm dev` stack and URLs from `pnpm portless:list`; sign in with
dev-login. Drive it with `agent-browser` under one session name. Attach through
the composer's Attach file input (`agent-browser upload`), since the files must
come in through the real intake.

1. In a New chat, attach `outline.txt` and send. The chat's top bar now shows a
   Files control beside the subagents control. A materialized chat with no uploads
   still offers Files for its Scratch.
2. Attach two more files without sending. The trigger stays "Files". Open it
   (Enter or Space on the trigger): the Uploads section has newest-first rows, each with the name, the
   type ("PDF", "Markdown") and when it was attached ("2 min ago") on separate
   lines. The file the sent message used has no delete action.
3. Within Uploads, Arrow Down and Up move between rows and Arrow Right reaches
   a row's actions. Scratch uses the shared tree's Tab stops and Enter/Space
   activation, not upload-arrow navigation. Escape closes the menu and returns
   focus to the trigger. Expand enough Scratch folders to overflow the menu;
   scrolling must still reach Uploads.
4. Click a row: the menu closes, the same chip the `@` picker inserts lands in the
   composer, and the caret is in the composer.
5. Delete an unused file: its row goes at once, and its
   chip leaves the composer. Reload: it stays deleted. Intercept the DELETE with
   `agent-browser network route "**/context/uploads/upload*" --body '{"kind":"already_used"}'`
   and delete another: the row returns without its delete action and with no message.
   Measure the menu content's height (`getBoundingClientRect().height`) before and
   after: it does not change. Replace the route with
   `agent-browser network unroute`, then `network route "**/context/uploads/upload*" --abort`
   (a failed request), and delete another: the row returns, its second line reads
   "Couldn’t delete this file. Try again." in place of the type and time, and the height
   is unchanged. The line clears
   when the menu closes or on the next delete of that row.
6. "Open" on a row opens the file in the dock beside the chat (Chat screen with the
   right rail expanded). Reload: the dock tab comes back. This also holds for a chat
   created with its first attachment. On the Work and Editor screens, where the chat is
   the dock, rows offer no Open, and the sent message's attachment is not a link: those
   screens have no viewer ([#884](https://github.com/haowjy/meridian-flow/issues/884)).
7. Open a second chat in the same Work: Files shows the same shared Scratch and
   no uploads from the first chat. Fork the first chat: the fork's
   trigger reads "Files" and its menu says "No files attached in this chat yet."
   under "Continues from <source title>". The link opens the source chat.
8. Narrow the viewport to 390 px and set `data-ui-theme="dark"` on the root: the
   trigger stays on the top bar's row and the menu fits the screen.

The phone shell needs a coarse pointer, which `agent-browser set device` does not
give (it sets the width but `matchMedia('(pointer: coarse)')` stays false). Get it by
holding a CDP session open against the browser (`agent-browser get cdp-url`) that sends
`Emulation.setDeviceMetricsOverride {width: 390, height: 844, deviceScaleFactor: 2,
mobile: true}` and `Emulation.setTouchEmulationEnabled {enabled: true, maxTouchPoints: 5}`
for the page target, then reload the chat. The override ends when that session closes, so
leave the script running while you drive. The Chat screen's top bar then shows the files
menu fitting 390 px (light and dark); rows offer no Open there. Check the chat sheet header
host the same way.

`agent-browser upload "input[type=file]"` is unreliable here: with a dock open the page has
two hidden file inputs (the dock editor's figure input and the composer's), and the first
match may attach to another chat's composer draft. Upload with the ref of the composer's
"Choose File" button, one file per call.

## Shared Scratch and nested trees

Seed a Work note at `scratch://notes/research/timing` through `./mf doc put`
with that Work selected. Open Work Files, expand both folders, then open the
same Work chat's Files menu and sidebar Scratch. All three show the actual
`notes → research → timing` tree, with matching guide lines and folder actions.
Use the phone coarse-pointer setup above to verify Work Files, the chat drawer,
and Editor's nested project tree. Folder disclosure expands in place; opening a
file navigates. There are no thread-folder badges or Open chat actions.

Search Work Files for `timing`: both ancestors remain visible. Collapse/reopen a
search result, clear the query, and confirm normal saved expansion is unchanged.
Rename to an existing *filtered-out* sibling: collision validation still refuses.
Search for a nonmatching name, click New note, and name the new note in place;
its pending/error row and rename field must remain visible during the search.

Rename, move and delete a note from each surface, reload, and compare the other
surfaces. An archived Work permits browsing but offers no mutation actions.
A failed refresh keeps already loaded rows, with Retry below them. Before chat
ownership resolves, the menu must not fetch a global Scratch catalog. Two No Work
lineages show different Scratch; forks/subagents retain their lineage's Scratch,
and an actual handoff starts fresh. Rebinding changes the source, never copies
notes. Uploads remain attached to their source primary chat throughout.

## Tree guides, spacing and row actions

Compare expanded Manuscript in the sidebar with nested Scratch in Work Files
and the phone browser. Each visible expandable parent has one continuous guide
through its children, aligned with its disclosure arrow. Hover and select a
child: the guide stays above the fill, without blocking clicks or focus.
Standalone lists start flush at their first depth (no phantom parent indent);
real nesting adds one step. Check inline creation, rename, and filtered Work
Files too. On both page and sidebar, hovering the ellipsis has a distinct fill
from the hovered row. Repeat in light and dark themes, with a fine pointer;
phone coarse-pointer rows and action targets remain at least 44px tall.
