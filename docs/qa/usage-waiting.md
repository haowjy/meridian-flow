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
2. Above the message box, expect the grey note "You're out of usage. Your
   messages will send when you add more." and an Add usage link. Under every
   pending writer message, expect "Waiting for usage", not "Queued".
3. Add usage opens Settings → Usage. The note has no Dismiss X. The message
   box remains editable. Notes stay above DraftDock, not between it and the box.
4. Reload both chats. The note and row statuses survive. Inspect
   `./mf api GET /api/threads/<id>/snapshot --json`: `liveState.pending.blocked`
   is `{ "reason": "credits_exhausted" }`, with the waiting message's id.
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
note and waiting statuses clear at start, before reply completion. Confirm the
saved words are answered and `liveState.pending.blocked` is absent. Leave a
positive balance and stop only this stack with `pnpm dev --stop`.
