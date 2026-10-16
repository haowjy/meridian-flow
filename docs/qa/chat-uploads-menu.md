# Chat uploads menu

The dropdown in the chat's top bar lists the files attached in this chat. Use the
lane's `pnpm dev` stack and URLs from `pnpm portless:list`; sign in with
dev-login. Drive it with `agent-browser` under one session name. Attach through
the composer's Attach file input (`agent-browser upload`), since the files must
come in through the real intake.

1. In a New chat, attach `outline.txt` and send. The chat's top bar now shows a
   paperclip and "1 file" beside the subagents control. A chat with no files
   shows no control.
2. Attach two more files without sending. The trigger reads "3 files". Open it
   (Enter or Space on the trigger): rows are newest first, each with the name, the
   type ("PDF", "Markdown") and when it was attached ("2 min ago") on separate
   lines. The file the sent message used has no delete action.
3. Arrow Down and Up move between rows, Arrow Right reaches a row's actions,
   Escape closes the menu and focus returns to the trigger.
4. Click a row: the menu closes, the same chip the `@` picker inserts lands in the
   composer, and the caret is in the composer.
5. Delete an unused file: its row goes at once, the trigger count drops, and its
   chip leaves the composer. Reload: the count stays. Intercept the DELETE with
   `agent-browser network route "**/context/uploads/upload*" --body '{"kind":"already_used"}'`
   and delete another: the row returns with "A sent message used this file, so it
   can’t be deleted."
6. "Open" on a row opens the file in the dock beside the chat (Chat screen with the
   right rail expanded). Reload: the dock tab comes back. This also holds for a chat
   created with its first attachment (its cached file spells no handle until the server
   names it). On the Work and Editor screens, where the chat is the dock, rows offer no
   Open, and the sent message's attachment is not a link. There is no viewer there yet.
7. Open a second chat in the same Work: no trigger. Fork the first chat: the fork's
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
