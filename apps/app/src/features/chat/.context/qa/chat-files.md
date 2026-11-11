# Chat Files menu

The Files dropdown combines shared Scratch and files attached in this chat. Use an
owned `pnpm dev` stack and URLs from `pnpm portless:list`; the stack runs with
`DEV_AUTH_BYPASS=1`, so the app opens signed in. Drive it with `agent-browser` under one session name. Attach through
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
6. Rows offer no Open: uploads have no editor address, so no chat door opens one
   on desktop, and the sent message's attachment is not a link. This also holds for a chat
   created with its first attachment.
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

`agent-browser upload "input[type=file]"` is unreliable here: with a document open the page has
two hidden file inputs (the document editor's figure input and the composer's), and the first
match may attach to another chat's composer draft. Upload with the ref of the composer's
"Choose File" button, one file per call.
