# Failure cards

Browser checks for the cards `chatCards` decides: failed replies, Retry failures,
failed compaction, handoff-brief failures and their live-region announcements.
Every chat failure is a `FailureCard` drawn where it is anchored.

## Setup

Follow [Runtime probes](../../../../../../../docs/qa/README.md) and [Queue controls](queue-controls.md#setup):
`MODEL_PROVIDER=mock pnpm dev --no-tailscale`, `MF_APP_URL` and `MF_SERVER_URL` passed explicitly,
sign in at `/api/auth/dev-login` in `agent-browser --session cards`, open `/p/<projectId>/chats/<threadId>`
at 1280 wide. `T` is a new thread (`./mf thread create`). Fault injection is the `fetch` wrapper
from queue controls; the Retry route ends in `/retry` and a brief Stop's in `/cancel`.

Selectors: `[data-chat-card=<copy>]` is a card's sentence (`reply-failed`, `reply-declined`,
`compaction-failed`, `brief-failed`, `retry-refused`, `retry-refused-another-reply`, `retry-lost`,
`brief-retry-lost`, `brief-stop-failed`, `stop-failed`, `usage-blocked` and the queue's), and
`[data-chat-card-action=<retry|try_again|add_usage>]` its action button. A refused card's Dismiss icon is `button[aria-label="Dismiss"]`. The live region is
`[aria-live=assertive]`. Read it and the page text with
`agent-browser eval "document.querySelector('[aria-live=assertive]').textContent"` and
`document.body.innerText`. `./mf thread view T` prints a `card ...` line for each card the durable
facts give (the latest failed reply and usage; `./mf` holds no local command state, so it never
shows a lost Retry or a failed Stop).

## FC-01: the failed reply

`./mf thread send "$T" "write" --mock '[{"error":{"status":500,"message":"boom"}}]'`. The latest
reply has a card anchored on it, "This response failed." with Retry (a provider decline reads "The AI provider turned this
request down."). Send another message: the card and the failed row are gone, and the live region is
empty. `./mf thread view` printed `card reply-failed on turn <id> [retry] <id>` before.

## FC-02: a refused Retry

With a failed reply open, wrap `fetch` to answer the `/retry` POST with 409 and press Retry. A second
card, "Couldn't retry. Another reply started first.", sits on the failed reply under its own card
(plain "Couldn't retry." for another refusal). Make the next message fail: the refusal stays alone on
the past reply. Make the next reply complete: it goes. Pressing Retry or sending also clears it.

## FC-03: a lost Retry

Wrap `fetch` to throw `TypeError('Failed to fetch')` on `/retry` and press Retry. The failed reply
shows again with "Couldn't start the retry." and Try again, and there is no error row and no stand-in.
Restore `fetch` and press Try again: the new reply starts, the cards go.

## FC-04: a failed compaction

Needs a chat with one completed reply. Queue sticky errors for the summary call, then type `/compact`
and press Enter twice:

```bash
./mf mock script '[{"error":{"status":500,"message":"summary boom"}}]' --match 'system_update'
./mf mock script '[{"error":{"status":500,"message":"summary boom"}}]' --match 'Conversation transcript'
```

The divider keeps its neutral "Compaction" label and fold icon; only its card says "This conversation couldn't be compacted. Try
again." with a Try again button. Clear both scripts (`./mf mock clear --id`) and press Try again: a new
compaction runs and completes, the failed one and its card go. An autocompaction's failure shows no
card (the failed reply under the newest message carries it).

## FC-05: the handoff brief

Hand off from a reply with the same two scripts queued. The brief card shows "Handoff brief"
with Retry in its header and a card with the server's words ("This handoff brief couldn't be
generated. Try again."). Keep this case free of later replies: once a later
reply completes, the old brief's failure card and Retry disappear. Test that
separately by queueing a message during a delayed failing brief and confirming
that it runs after failure. For the Retry/Stop case, replace the scripts with a
delayed brief (`"delayMs":60000`), wrap `fetch` to throw on `/cancel`, press Retry
then Stop: "Couldn't stop the brief." with Try again sits on the
generating brief. Restore `fetch` and press Try again: the brief stops and the card goes.

## FC-06: the live region clears with its card

- **Stop:** drop the chat's `stop` POST and press Stop on a running reply: "Couldn't stop the reply."
  appears above the box and in the live region. Restore `fetch` and press Try again. The card goes;
  `document.body.innerText` and every `[aria-live]` hold no "Couldn't stop the reply."
- **A reply failure:** fail a reply while the chat is open: the live region says "This response
  failed." once. Send another message: it is empty.
- **On load:** reload a chat whose latest reply failed. The card shows and the live region stays empty.

## FC-07: unavailable feed and correlated diagnostics

On a loaded chat, use browser fault injection to close its WebSocket with 4401.
Expect one composer card: “Chat updates disconnected”, “Reload to see the latest
replies.” and Reload, with no “Session expired” banner. Type and Send: HTTP
admission must still work. Click Reload: history catches up and the card goes.
A recoverable disconnect or retryable subscription error must not create this
card. Refuse one subscribe while another chat stays live: only the refused chat
gets a card; retain it until that thread's subscribe acknowledgment.

After a card appears, read its `[data-failure-id]` and the assertive live region.
Exercise Retry, Dismiss, target completion/removal and pane unmount for a failed
Stop, Send now, brief Stop, Retry and queued control. Each failure announces once;
reloads stay silent. Restore credits, fetch wrappers and mock scripts after each
injected failure.
