# Runbook: default project bootstrap

Verifies the authenticated `/projects` entrypoint provisions the default
Meridian Flow project graph and routes to the agent project.

## Preconditions

- `pnpm supabase:start`, `pnpm bootstrap`, and `pnpm dev` are running.
- `APP_URL` is the portless app origin.
- Browser is logged in through `$APP_URL/dev-login`.

## Steps

### 1. Open projects

```bash
playwright-cli goto "$APP_URL/projects"
```

**Expected:** the URL redirects to `/projects/{projectId}/agent`; the project
shell is visible; thread and Yjs status indicators eventually show `subscribed`.

### 2. Confirm the graph exists

Extract `projectId` from the URL and query Postgres:

```bash
psql "$DATABASE_URL" -c "select id, name, slug from projects where id = '{projectId}';"
psql "$DATABASE_URL" -c "select id, title from works where project_id = '{projectId}';"
psql "$DATABASE_URL" -c "select id, title, status, project_id, work_id from threads where project_id = '{projectId}';"
```

**Pass:** one project exists, at least one work exists, and a primary thread is
attached to both `project_id` and `work_id`.

**Fail:** redirect does not happen, shell does not render, no thread row exists,
or the thread is detached from project/work.
