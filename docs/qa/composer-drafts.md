# Unsent composer drafts

Use the lane's `pnpm dev` stack and URLs from `pnpm portless:list`. Sign in with
dev-login. Seed a document and chat with `./mf seed tools/dev/cli/fixtures/basic.json`
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
   a deterministic 403). The original live draft stays exactly once. Edit on the
   failed row focuses it without inserting another copy. Reload after the
   rejection and verify the same unsent draft returns.
6. Open the chat in a second independent browser tab (not Duplicate tab or
   Restore closed tab). Type different words in each and reload both. Each
   keeps its own draft. Close one, then open a fresh tab: it starts empty.
7. Save a draft referencing a file, delete that file through `./mf doc delete`,
   then reload. Successful catalog acquisition removes the missing atom while
   keeping prose. Offline/catalog errors must not erase references.
8. Reload during an upload. The in-flight upload atom drops, because its bytes
   existed only in memory. A completed upload reference survives.
9. Deny sessionStorage access. The composer still accepts typing and sends
   through the submission journal (localStorage is a separate boundary).

Browser Duplicate tab/Restore closed tab may copy sessionStorage by browser
policy. This feature intentionally has no cross-tab store or close/reopen seed.
