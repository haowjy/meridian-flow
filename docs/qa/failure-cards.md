# Failure cards

Browser checks for the cards `chatCards` decides: the failed reply, a refused and a lost Retry, a
failed compaction, the handoff brief's failures, and the live region that announces them. Every
chat failure is a `FailureCard` drawn where it is anchored; none is a bare red line, and one
announcer speaks each card once. These steps were run as F27 to F29 in
[#849](https://github.com/haowjy/meridian-flow/pull/849) and live here so they outlast that work. A
step is not a claim that it passed on the current commit: record the commit, date, provider and
evidence path after each run, in the active work directory.

## Setup

Follow [Runtime probes](README.md) and [Queue controls](queue-controls.md#setup):
`MODEL_PROVIDER=mock pnpm dev --no-tailscale`, `MF_APP_URL` and `MF_SERVER_URL` passed explicitly,
sign in at `/api/auth/dev-login` in `agent-browser --session cards`, open `/p/<projectId>/chats/<threadId>`
at 1280 wide. `T` is a new thread (`./mf thread create`). Fault injection is the `fetch` wrapper
from queue controls; the Retry route ends in `/retry` and a brief Stop's in `/cancel`.

Selectors: `[data-chat-card=<copy>]` is a card's sentence (`reply-failed`, `reply-declined`,
`compaction-failed`, `brief-failed`, `retry-refused`, `retry-refused-another-reply`, `retry-lost`,
`brief-retry-lost`, `brief-stop-failed`, `stop-failed`, `usage-blocked` and the queue's), and
`[data-chat-card-action=<retry|try_again|add_usage|dismiss>]` its button. The live region is
`[aria-live=assertive]`. Read it and the page text with
`agent-browser eval "document.querySelector('[aria-live=assertive]').textContent"` and
`document.body.innerText`. `./mf thread view T` prints a `card ...` line for each card the durable
facts give (the latest failed reply and usage; `./mf` holds no local command state, so it never
shows a lost Retry or a failed Stop).

## FC-01: the failed reply

`./mf thread send "$T" "write" --mock '[{"error":{"status":500,"message":"boom"}}]'`. The latest
reply shows "This response failed." with Retry (a provider decline reads "The AI provider turned this
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

The divider reads "Couldn't compact" and its card says "This conversation couldn't be compacted. Try
again." with a Try again button. Clear both scripts (`./mf mock clear --id`) and press Try again: a new
compaction runs and completes, the failed one and its card go. An autocompaction's failure shows no
card (the failed reply under the newest message carries it).

## FC-05: the handoff brief

Hand off from a reply with the same two scripts queued. The brief card shows "Handoff brief"
with Retry in its header and a card with the server's words ("This handoff brief couldn't be
generated. Try again."). Replace the scripts with a delayed brief (`"delayMs":60000`), wrap `fetch` to
throw on `/cancel`, press Retry then Stop: "Couldn't stop the brief." with Try again sits on the
generating brief. Restore `fetch` and press Try again: the brief stops and the card goes.

## FC-06: the live region clears with its card

- **Stop:** drop the chat's `stop` POST and press Stop on a running reply: "Couldn't stop the reply."
  appears above the box and in the live region. Restore `fetch` and press Try again. The card goes;
  `document.body.innerText` and every `[aria-live]` hold no "Couldn't stop the reply."
- **A reply failure:** fail a reply while the chat is open: the live region says "This response
  failed." once. Send another message: it is empty.
- **On load:** reload a chat whose latest reply failed. The card shows and the live region stays empty.

## Review boundaries

- **Outstanding compaction:** after FC-04 fails, block usage as in
  [usage waiting](usage-waiting.md) and press Try again. The replacement is queued;
  both the browser and `./mf thread view` must omit the old `compaction-failed`
  card. Drop the replacement's withdrawal: only `compact-withdraw-failed` has
  Try again. A lost replacement enqueue likewise leaves recovery on the queued
  command, never a second enqueue button on the old divider.
- **Superseded brief:** lose the brief Retry's `POST /handoff/brief` response,
  then create a newer brief from another client. Neither `brief-retry-lost` nor
  historical failure copy or Retry may remain on the old seed.
- **Unsaved switch:** temporarily make `Storage.prototype.setItem` throw only
  for `meridian:chat-submissions:` keys. Switch write mode. Expect one queued
  failure card and recovery action, not an unowned alert. Retry twice, restore
  storage, and retry or withdraw; the card and its alert disappear. Restore the
  original method in a `finally` block.
- **Batch:** cause two watched failures in one projection (for example FC-03's
  reply failure and lost Retry). Both sentences must reach the assertive region
  together. Ending one card must not rewrite the region to the surviving
  sentence and announce it again. Reloaded cards stay silent.
- **Occurrences across reload:** lose a message send and its Retry. Read the
  journal's `occurrence` before reload; re-drive after reload and fail again.
  The saved attempt increases and the new card key differs. The idempotent
  `submissionId` need not change. Repeat with a failed write-mode switch.

- **Two-tab replay:** open the same chat in two tabs, locally fail message POSTs
  and admission lookups, and send once. After the initial attempts settle, saved
  occurrence counters and request counts must stop increasing without a Retry,
  reconnect or reload. One tab publishing attempt metadata must not wake the
  other into another replay or announce that in-flight attempt as failed.

Restore credits, fetch/storage wrappers and scripts after each injected failure.
Raw `./mf` error lines are diagnostic; compare the `card` lines and anchors, not
provider error strings, with the app's cards.
