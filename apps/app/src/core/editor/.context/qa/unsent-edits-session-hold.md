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
3. Close the document's tab, wait 10 s (the grace is 3 s).
4. `set offline off` without reopening. Wait 15 s. `./mf doc read` shows the second word.
5. Exit, removal: repeat 1 to 3, then `./mf doc rm <uri>` before going back online.
   The held session must go (`drainDocument` runs; nothing stays held). A removal clears
   the unsent local edits: after Restore the second word is gone from the editor and from
   `./mf doc read`. Reproduced on `ux-v1` at `0957566d12` (review of #1304). Whether it
   should keep them until Restore or a purge is an open owner question, https://github.com/haowjy/meridian-flow/issues/1385.
6. Control: revert the registry change and repeat 2 to 4. The second word never arrives.

## Last run: 2026-11-11, `ux-v1` (harvest PR), `pnpm dev`, mock provider

- Steps 1 to 4: both words reached the server after going back online. Holds.
