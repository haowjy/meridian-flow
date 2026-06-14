# Browser smoke runbooks

Manual/agent-executed e2e playbooks for the portless Meridian Flow dev stack.
They complement automated Playwright specs and are useful when an agent needs to
verify real browser behavior, console output, WebSocket state, and database rows.

## Shared setup

1. Start local infra and app stack from the same worktree you will inspect:

   ```bash
   pnpm supabase:start
   pnpm bootstrap
   pnpm dev
   pnpm portless:list
   ```

2. Use the portless app URL printed by `pnpm portless:list`, for example:

   ```bash
   export APP_URL="https://<branch-prefix>.app.meridian.localhost"
   export SERVER_URL="https://<branch-prefix>.server.meridian.localhost"
   export NODE_EXTRA_CA_CERTS="$HOME/.portless/ca.pem"
   ```

3. Login through the dev-login route:

   ```bash
   playwright-cli goto "$APP_URL/dev-login"
   ```

4. Database checks use the worktree's `DATABASE_URL`:

   ```bash
   set -a; . ./.env; set +a
   psql "$DATABASE_URL" -c 'select 1;'
   ```

## Runbooks

| Guide | Covers |
|---|---|
| [`quick-chat-create.md`](quick-chat-create.md) | Bootstrap/default project route materializes a project, work, thread, and document |
| [`thread-streaming.md`](thread-streaming.md) | Project agent composer streams a message through the active runtime |
| [`editor-collab.md`](editor-collab.md) | Agent output reaches the live TipTap/Yjs editor and persists attribution |
