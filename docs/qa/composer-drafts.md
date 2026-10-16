# Unsent composer drafts

Use the lane's `pnpm dev` stack and URLs from `pnpm portless:list`. Sign in with
dev-login. Seed a document and chat with `./mf seed tools/mf/fixtures/basic.json`
(the optional model send needs `MODEL_PROVIDER=mock`).

1. Open the seeded chat. Type prose and select an `@` reference. Reload right
   away, before the 250ms debounce. Both prose and the reference atom return.
2. Open Editor with this chat in the side panel. Type another draft there,
   reload, and verify it returns. Open the chat on a phone viewport and repeat.
   Dock selection persistence is a separate lane: reopen the chat if needed.
3. On All chats, type into the new-chat composer and insert a reference. Reload.
   The project draft returns. Changing the prospective Work does not strand it.
4. Send a draft. Reload while admission is pending, and after acknowledgement.
   The dispatch journal/transcript owns the message; no unchanged composer draft
   returns. Start another unsent message and reload: the new words do return.
5. Force a proved admission rejection (for example, intercept the send POST with
   a deterministic 403). The original message stays on its failed writer row
   with Retry and Edit, and the composer is empty. Type newer words, then Edit:
   the rejected message comes first and the newer words remain. Reload before
   Edit and verify the rejected row, not a second composer copy, returns.
   After Edit, refuse journal-key deletion and reload in the same tab: the words
   appear once in the draft, the old row reads “Moved to the message box.” without
   Retry/Edit, and restoring deletion then going online finishes retirement.
6. Open the chat in a second independent browser tab (not Duplicate tab or
   Restore closed tab). Type different words in each and reload both. Each
   keeps its own draft. Close one, then open a fresh tab: it starts empty.
7. Save a draft referencing a file, delete that file through `./mf doc rm`,
   then reload. Successful catalog acquisition removes the missing atom while
   keeping prose. Offline/catalog errors must not erase references.
8. Reload during an upload. The in-flight upload atom drops, because its bytes
   existed only in memory. A completed upload reference survives.
9. Deny sessionStorage access. The composer still accepts typing and sends
   through the submission journal (localStorage is a separate boundary).
10. Refused first Send in New chat with an attachment. In New chat attach a PNG
    and type a message, then refuse the chat-creation POST (wrap `fetch` to
    return 400). The message stays on its failed row. Choose Edit, then Send:
    the creation request carries the same chat id, and the transcript shows the
    model reading the attachment at its `uploads://@/c<N>/` address.
    Variant: after the refusal, start a newer New-chat draft with its own upload
    and words. Edit puts only the refused message back in the composer, and the
    newer draft is parked. Send creates the refused chat with its attachment;
    New chat then shows the parked draft, and its Send creates a second chat
    with its own upload. Neither attachment is lost.

Browser Duplicate tab/Restore closed tab may copy sessionStorage by browser
policy. This feature intentionally has no cross-tab store or close/reopen seed.
