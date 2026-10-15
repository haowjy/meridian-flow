# Chat uploads menu

The dropdown in the chat's top bar lists the files attached in this chat. Use the
lane's `pnpm dev` stack and URLs from `pnpm portless:list`; sign in with
dev-login. Drive it with `agent-browser` under one session name. Attach through
the composer's Attach file input (`agent-browser upload`), since the files must
come in through the real intake.

1. In a New chat, attach `outline.txt` and send. The chat's top bar now shows a
   paperclip and "1 files" beside the subagents control. A chat with no files
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
   right rail expanded). Reload: the dock tab comes back.
7. Open a second chat in the same Work: no trigger. Fork the first chat: the fork's
   trigger reads "Files" and its menu says "No files attached in this chat yet."
   under "Continues from <source title>". The link opens the source chat.
8. Narrow the viewport to 390 px and set `data-ui-theme="dark"` on the root: the
   trigger stays on the top bar's row and the menu fits the screen.

The phone shell needs a coarse pointer, which `agent-browser set device` does not
give; check its two hosts (the Chat screen's top bar and the chat sheet header) on
a touch device.
