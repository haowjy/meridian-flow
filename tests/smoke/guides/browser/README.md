# Browser smoke runbooks

Manual/agent-executed e2e playbooks for the Meridian Flow dev stack.
They complement automated Playwright specs and are useful when an agent needs to
verify real browser behavior, console output, WebSocket state, and database rows.

## Shared setup

1. Start local infra and app stack from the same worktree you will inspect:

   ```bash
   pnpm dev:infra
   pnpm bootstrap
   pnpm dev
   pnpm dev:urls
   ```

2. Use the URLs printed by `pnpm dev:urls`, for example:

   ```bash
   export APP_URL="http://localhost:<app port>"
   export SERVER_URL="http://localhost:<server port>"
   ```

3. Open the app. With `DEV_AUTH_BYPASS=1` in `.env` there is no login step; you are the dev user:

   ```bash
   playwright-cli goto "$APP_URL/"
   ```

4. Database checks go through `tools/dev/psql`, which targets the worktree's database:

   ```bash
   tools/dev/psql -c 'select 1;'
   ```

## Runbooks

| Guide | Covers |
|---|---|
| [`quick-chat-create.md`](quick-chat-create.md) | Bootstrap/default project route materializes a project, work, thread, and document |
| [`thread-streaming.md`](thread-streaming.md) | Project agent composer streams a message through the active runtime |
