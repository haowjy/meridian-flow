# Saved messages waiting for usage

Use an owned worktree with `MODEL_PROVIDER=mock pnpm dev`. Discover its HTTPS
URLs with `pnpm portless:list`. Use `./mf project list --json` to find the dev
account and project, then `./mf thread create` and one successful send to make
an existing chat. Resolve `DATABASE_URL` through `tools/dev/print-worktree-env.ts`;
never use another checkout's database.

## Exhaust usage without removing ledger history

With noninteractive `psql`, pass the account UUID as `-v user_id=<uuid>`:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('credit_fifo'), hashtext(:'user_id'));
SELECT * FROM consume_credit_lots_fifo(
  :'user_id'::uuid,
  (SELECT COALESCE(SUM(remaining_millicredits), 0) FROM credit_lots
   WHERE user_id = :'user_id'::uuid
     AND (expires_at IS NULL OR expires_at > NOW() OR source_type = 'debt'))::bigint,
  gen_random_uuid(), gen_random_uuid()::text, '{"probe":773}'::jsonb);
COMMIT;
```

Do not remove the free-tier entitlement grant: that would make the billing
policy grant it again instead of testing exhausted usage. Use a fresh debit
idempotency key on each drain, as above; replaying a key does not drain again.

## Verify the saved waiting state

1. Send in the existing chat and from New chat. Both keep the writer's words;
   New chat navigates to its created chat immediately.
2. Above the message box, expect a red error card "You're out of usage. Your
   messages will send when you add more." with an Add usage button, in the composer's card
   stack. Each pending writer message is only the dotted queued bubble (accessible name
   "Your message, queued") with no visible label; the card says why.
3. Add usage opens Settings → Usage. The card has no Dismiss X. The message
   box remains editable. Cards stay above DraftDock, not between it and the box.
4. Reload both chats. The card and the queued bubbles survive, and nothing is announced on load. Inspect
   `./mf api GET /api/threads/<id>/snapshot --json`: `liveState.runState.blocked`
   is `{ "reason": "credits_exhausted" }`, with the waiting message's id.
   `./mf thread view <id>` prints the same card: `card usage-blocked on composer [add_usage]
   usage:<thread>:<seq>`.
5. `./mf thread send <id> "Another kept message" --json --timeout 10s`
   exits 1 with `status: "blocked", reason: "credits_exhausted"`, not timeout.
6. Capture existing/new chats at 1280px and a touch-enabled 390px phone viewport,
   light and dark. Crop the desktop sidebar containing the dev account address.

## Restore usage and observe without another send or reload

Append a grant and its matching ledger transaction in one transaction:

```sql
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('credit_fifo'), hashtext(:'user_id'));
WITH lot AS (
  INSERT INTO credit_lots
    (user_id, source_type, original_amount_millicredits,
     remaining_millicredits, grant_reason, metadata)
  VALUES (:'user_id'::uuid, 'grant', 1000000, 1000000,
          'usage_waiting_probe_restore', '{"probe":773}')
  RETURNING id, user_id
)
INSERT INTO credit_transactions
  (user_id, transaction_type, amount_millicredits, lot_id, metadata)
SELECT user_id, 'grant', 1000000, id, '{"probe":773}' FROM lot;
COMMIT;
```

Within the ordinary server wake interval, replies start automatically. The
card and the queued bubbles clear at start, before reply completion. Confirm the
saved words are answered and `liveState.runState.blocked` is null. Leave a
positive balance and stop only this stack with `pnpm dev --stop`.

## Withdrawal and delayed CLI replay regressions

On an existing chat with a completed reply and exhausted usage:

1. Enqueue a compact control through
   `./mf api POST /api/threads/<id>/controls --data '{"id":"<uuid>","control":{"kind":"compact"}}' --json`.
   Wait for `liveState.runState.blocked`.
2. Withdraw it with `./mf api POST /api/threads/<id>/controls/<uuid>/withdraw --json`.
   With no other pending message/control, the card disappears and the bubbles return to ordinary rows.
   Read `threads.inbox_blocked_reason` through the owned database: it must be null,
   even if notices remain. An empty refused wake must leave it null.
3. Restore usage, enqueue a mock reply and send again. Expect exit 0 and a
   completed reply, never a stale `credits_exhausted`.
4. Separately delay delivery of the send POST response to the CLI until the
   message blocks, restore usage and wait for its completed reply, then release
   the response. The CLI must return that completed reply with its turn ID and
   exit 0, even when catch-up contains the old blocked event.
5. Existing blocked sends still exit 1 promptly. Recovery removes the card and
   the queued look at start. No rendering change is expected from this rework.
