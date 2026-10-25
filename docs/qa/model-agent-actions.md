# Model-owned chat actions

Verify that an edit Agent can switch its chat's Work, queue its chat's write
mode, and send a background message to an unrelated chat. A read Agent must
still be denied the two `work` changes. Run the stack with
`MODEL_PROVIDER=mock pnpm dev`, discover its Portless URLs with
`pnpm portless:list`, and open the chats through `/dev-login`.

Use `./mf mock script '<steps>' --match '<message>'` for browser sends, or pass
the same steps to `./mf thread send <id> '<message>' --mock '<steps>'`. Each
tool call is a mock step; a later text step lets the model finish after reading
the result.

## Work switch during a reply

1. Create two Works and an edit-Agent chat in the first Work. Put a manuscript
   document into that chat's draft review, then type an unsent composer draft.
2. Script a delayed `work` call with `{ "command": "switch", "work": "w2" }`.
   While the reply is running, send another writer message so it waits in the
   queue.
3. The tool result names `w2`. The chat's Work chip changes to the second Work,
   while the unsent composer draft and the first Work's existing document draft
   remain intact. The Work-switch notice precedes the queued writer message in
   the durable transcript; the queued message's reply uses the second Work.
4. Repeat the call with an unknown Work, an archived Work, and the current Work.
   Each returns its specific precheck result and leaves membership unchanged.
   No switch row or notice offers Undo.

## Write mode at the next reply

1. Start an auto-apply chat and seed a manuscript document. Script one reply
   that calls `work` with `{ "command": "write_mode", "mode": "draft" }`, then
   writes to the seeded document before ending.
2. The command result says Draft applies from the next reply. The write made
   later in this same reply lands live: the running execution stayed in its
   starting mode.
3. Send another message scripted to write the document. This write appears in
   draft review and leaves the live document unchanged.
4. Inspect a sibling chat and create a new chat in the Work. The sibling's mode
   is unchanged, and the new chat still uses the writer-owned Work default.
   Queue Direct and then Draft from model calls before either applies; the queue
   shows at most one switch and cancel-out leaves the final requested mode.

## Background message outside the lineage

1. Create two independent edit-Agent chats in the same project and note their
   refs from `./mf thread view <id> --json`.
2. In the first chat, script `thread_message` with the second chat's ref,
   `mode: "background"`, and distinctive text. The first chat shows **Sent a
   message to …** naming the destination by title and handle, with that text in
   the expanded row.
3. The second chat wakes. Its transcript shows the distinctive message as sent
   by the first chat's title and handle, even when it had no earlier assistant
   row to hold the delivery. Its reply remains in the second chat. Confirm both
   sides after reload with `./mf thread view <id> --full --json` and in the browser.
4. A foreground call to the same unrelated chat is still refused. A background
   call to another user's chat or another project's ref is not found.

## Read permission

Bind a read-only Agent to a fresh chat. Calls to `work switch` and
`work write_mode` both return `permission_denied` with `action_denied`; the
chat's Work, applied write mode, pending controls, and Work default do not
change. `work list` and `work show` still succeed.

## Evidence and cleanup

Capture the tool result and Work chip after the switch, the live-versus-draft
document result across the two write-mode replies, both message transcripts,
and both read-Agent refusals. Record the commit, stack URL, mock scripts and
`./mf` JSON in the active work directory. Close the named browser session and
stop only this worktree's stack with `pnpm dev --stop`.
