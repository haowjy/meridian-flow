# Live sessions hold unsent edits

The live registry (`document-session-registry-implementation.ts`) keeps a session with
unacknowledged edits after its last host leaves, until the server acknowledges them or
an exit applies: the room was refused, reset or admitted read-only, the document was
removed or access revoked, the account's session ends, or it has stayed connected for 10 minutes without an acknowledgement (offline time does not count). The exits
are listed in `../CONTEXT.md` (Live session teardown); `document-session-live-hold.test.ts`
guards them. Recipe and the last run's results.

## Recipe (browser, `agent-browser`, stack from `pnpm dev`)

1. Open a document, click into the editor, type a word online. `./mf doc read` shows it.
2. `agent-browser set offline on`, type a second word. `./mf doc read` lacks it.
3. Close the document's tab (it is then neither main, side nor kept), wait 10 s (the grace is 3 s).
4. `set offline off` without reopening. Wait 15 s. `./mf doc read` shows the second word.
5. Exit, removal: repeat 1 to 3, then `./mf doc rm <uri>` before going back online.
   The held session must go (`drainDocument` runs; nothing stays held).
6. Control: revert the registry change and repeat 2 to 4. The second word never arrives.

## Last run: 2026-11-10, commit after aa811f7 (phase 0), `pnpm dev` with deepseek-flash

- Step 4: the word reached the server. Holds.
- Step 6 control: the word stayed on the device. The probe fails without the change.
- Step 5: the session was held after the grace, then released by `drainDocument` when the
  document was removed. Holds.
- Acknowledged exit: an offline edit, document left, back online: the session was held, then
  retired once the server had the text.

## Other phase 0 probes

- **Two hosts, each Apply settles its own room (plan §10.4).** Two drafts on two
  documents from one chat (write mode Draft). Applying one from the chat's draft dock settled that
  room only: the other document kept its draft and its "Apply". Two *hosts* on two
  different drafts at once is not reachable today (the chat's draft dock acts on one document), so the new case is unconfirmed; it needs per-host review.
- **Untitled document (plan §10.6).** Write in a New document, open another document, leave the
  untitled one, reload: the text is on the server as `unfiled://Untitled 1` and the
  replica's metadata database holds its handle record. Holds for the data. The sidebar
  has no Unfiled list yet, so findability by a writer is still to build (phase 7).
