# Meridian Flow Database Layer — Orientation Map

> **Map last regenerated:** 2026-06-18
> **Database layer last changed:** 2026-06-16 (`d864bab9`)
>
> "Database layer last changed" is derived from
> `git log -1 --date=short --format=%cd -- packages/database/src` (the schema /
> layer **source**, not these `.context/` docs — we want the last meaningful
> schema change, not the doc move).
>
> **Regenerated on demand, not auto-maintained.** If "database layer last
> changed" is newer than "map last regenerated", treat this map as **stale** and
> regenerate. To regenerate: re-derive this orientation text and the interactive
> view ([`schema-map/index.html`](schema-map/index.html)) from the current
> [`../src/schema/*.ts`](../src/schema) definitions.

---

## Mental model

Meridian Flow splits database concerns into two layers. **`@meridian/database`** owns the Postgres contract: Drizzle schema, generated migrations, PL/pgSQL functions, and a thin `createDb(DATABASE_URL)` factory (postgres-js + drizzle-orm). It has **no** business logic and **no** ambient transaction context. **`apps/server`** owns persistence adapters: each domain exposes **ports** (`domain/` + `ports/`) and **adapters** (`adapters/drizzle/`, `adapters/in-memory/`). The composition root (`apps/server/server/lib/compose.ts` → `app.ts`) creates one lazy singleton `Database` from `DATABASE_URL` and injects it into all production Drizzle adapters.

Cross-cutting transaction propagation lives in **`apps/server/server/shared/drizzle-transaction.ts`**: `runInDrizzleTransaction` + `currentDrizzleDb` via `AsyncLocalStorage`. Adapters that must participate in a shared app-level transaction call `currentDrizzleDb(db)` on every query. Many other code paths still open their own `db.transaction()` without touching ALS — those are separate, non-nested scopes.

The only runtime configuration seam for the main app is **`DATABASE_URL`**. Dev Postgres is a plain `postgres:16` Docker container on port **54422**; schema is applied via Drizzle migrations + a post-migrate `db:apply-functions` step.

---

## 1. Package layout & seam

### `@meridian/database` structure

| Path | Role |
|------|------|
| `../src/connection.ts` | `createDb()` — postgres-js client + Drizzle instance |
| `../src/index.ts` | Public exports: `createDb`, schema re-exports, `event-journal` helpers |
| `../src/schema/` | All table/view definitions |
| `../src/schema/drizzle.ts` | drizzle-kit entry (re-exports schema modules) |
| `../src/schema/index.ts` | Runtime `schema` object passed to Drizzle client |
| `../src/migrations/` | Generated SQL + `meta/_journal.json` |
| `../src/functions/` | PL/pgSQL source (applied separately) |
| `../scripts/apply-functions.ts` | Applies function SQL via raw postgres-js |
| `../drizzle.config.ts` | drizzle-kit config (`schemaFilter: ["public"]`) |
| `../src/__test-support__/db-fixtures.ts` | Throwaway-DB guards for `RUN_DB_TESTS` |

Package exports (from `package.json`): `.`, `./schema`, `./schema/*`, `./__test-support__/db-fixtures`.

### `DATABASE_URL` → client creation

```13:22:../src/connection.ts
export function createDb(databaseUrl: string, options?: CreateDbOptions) {
  const client = postgres(databaseUrl, {
    max: options?.max ?? 10,
    ...options?.postgres,
  });
  const db = drizzle(client, { schema });
  return Object.assign(db, {
    close: () => client.end(),
  });
}
```

- **Driver:** `postgres` (postgres-js), default pool `max: 10`
- **Schema:** full runtime schema from `schema/index.ts` registered on the Drizzle client
- **Tests** often pass `{ max: 1 }` to avoid pool contention

Server singleton:

```7:14:../../../apps/server/server/lib/db.ts
export function getDb(): Database {
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required once server domains start using the database.");
  }
  if (!dbClient) {
    dbClient = createDb(env.DATABASE_URL);
  }
  return dbClient;
}
```

Wiring at startup:

```19:23:../../../apps/server/server/lib/app.ts
async function createAppServices(): Promise<AppServices> {
  const db = getDb();
  const eventSink = getOrBindProcessEventSink(createEventSinkFromEnv);
  const ports = await createProductionAppPorts({ db, eventSink, environment: process.env });
  return composeAppServices(ports);
}
```

### Other consumers

| Consumer | How it uses DB |
|----------|----------------|
| `apps/server/**` | Primary — imports `@meridian/database` + schema tables |
| `apps/www` | Separate client (`WEB_DATABASE_URL ?? DATABASE_URL`), `prepare: false`; schema re-exports only `waitlistEmails` from `@meridian/database/schema` |
| `tools/dev/*` | Admin/postgres-js for ensure/create/reset; delegates migrate to `pnpm db:migrate` |
| `packages/database` tests | Direct `createDb(DATABASE_URL)` |
| CI | `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/meridian_test` (`.github/workflows/ci.yml`) |

---

## 2. Schema

### Module map (`packages/database/src/schema/`)

| File | Tables / views |
|------|----------------|
| `_shared.ts` | Shared column helpers: `idColumn`, `createdAt`, `updatedAt`, `softDeleteAt`, `millicredits`, `byteaColumn` |
| `users.ts` | `users` — app-owned identity (`external_id` = WorkOS) |
| `content.ts` | `projects`, `works`, `context_sources`, `folders`, `documents` |
| `agent-threads.ts` | `threads`, `thread_works`, `turns`, `model_responses`, `turn_blocks`, `event_journal`, `thread_user_state`, `thread_documents` |
| `agent-packages.ts` | `agent_definitions`, `skills`, `user_installed_skills`, `agent_skills`, `agent_subagents` |
| `billing.ts` | `user_subscriptions`, `credit_lots`, `credit_transactions`, **`credit_balances` view** |
| `user.ts` | `user_preferences`, `user_project_favorites` |
| `preferences.ts` | `project_user_preferences` |
| `provenance.ts` | `turn_document_touches` |
| `results.ts` | `project_results` |
| `yjs.ts` | `document_yjs_checkpoints`, `document_yjs_updates`, `document_yjs_heads`, `document_restore_points` |
| `waitlist.ts` | `waitlist_emails` |
| `threads.ts`, `turns.ts` | Compatibility re-exports → `agent-threads.ts` |

Runtime schema aggregate:

```25:38:../src/schema/index.ts
export const schema = {
  users,
  ...billing,
  ...content,
  ...agentThreads,
  ...agentPackages,
  ...provenance,
  ...preferences,
  ...results,
  ...user,
  ...waitlist,
  ...yjs,
};
```

### Key relationships

```
users
 ├── projects (user_id, soft-delete)
 │    ├── works (project_id)
 │    ├── threads (project_id)
 │    ├── context_sources (project_id OR work_id — exactly one scope)
 │    │    ├── folders (parent_id self-FK in migration SQL)
 │    │    └── documents (folder_id nullable = root)
 │    └── agent_definitions / skills
 ├── credit_lots / credit_transactions / user_subscriptions
 └── thread_user_state (per user per thread)

threads ←M:N→ works  via thread_works (composite PK, one primary per thread)
threads → turns → turn_blocks / model_responses
threads → event_journal (monotonic seq per thread)
documents → document_yjs_* (collab)
```

**Deferred FKs** (added in migration SQL, not inline Drizzle): `threads.parent_thread_id`, `threads.origin_turn_id`, `threads.active_leaf_turn_id`, `turns.parent_turn_id`, `folders.parent_id`, agent self-FKs (`base_definition_id`, etc.). See comment at bottom of `agent-threads.ts` lines 346–347.

### ID strategy

- **Primary keys:** `uuid` via `idColumn<T>()` → `.defaultRandom()` with branded `$type<T>()` from `@meridian/contracts` (`_shared.ts` lines 10–11)
- **YJS tables:** `bigserial` for checkpoint/update sequence IDs
- **Waitlist:** `serial`
- **Composite PKs:** `thread_works`, `thread_user_state`, `thread_documents`, junction tables

### Enums

No PostgreSQL `ENUM` types. Constraints are **`text` columns + `CHECK (... IN (...))`** throughout (e.g. `threads.status`, `credit_lots.source_type`, `documents.file_type`).

### Timestamp columns & Drizzle `mode`

**Default behavior:** `_shared.ts` helpers omit `mode`, so Drizzle returns **`Date`** objects:

```13:19:../src/schema/_shared.ts
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const softDeleteAt = () => timestamp("deleted_at", { withTimezone: true });
```

**Explicit `mode: "string"`** (returns ISO strings):

| Table | Column | Lines |
|-------|--------|-------|
| `users` | `created_at`, `updated_at` | `users.ts:23–28` |
| `thread_works` | `created_at` | `agent-threads.ts:133–135` |

#### Full timestamp column table

| Table | Column | Drizzle mode | Notes |
|-------|--------|--------------|-------|
| **users** | `created_at`, `updated_at` | **string** | Explicit |
| **projects** | `last_activity_at` | Date | Inline |
| **projects** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared` |
| **works** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared` |
| **context_sources** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared` |
| **folders** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared` |
| **documents** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared`; CAS revisions use `::text` round-trip in adapter |
| **user_subscriptions** | `current_period_start`, `current_period_end` | Date | Inline |
| **user_subscriptions** | `created_at`, `updated_at` | Date | Via `_shared` |
| **credit_lots** | `expires_at` | Date | Nullable |
| **credit_lots** | `created_at` | Date | Via `_shared` |
| **credit_transactions** | `created_at` | Date | Via `_shared` |
| **threads** | `created_at`, `updated_at`, `deleted_at` | Date | Via `_shared` |
| **thread_works** | `created_at` | **string** | Explicit |
| **turns** | `created_at` | Date | Via `_shared` |
| **turns** | `completed_at` | Date | Inline, nullable |
| **model_responses** | `created_at` | Date | Via `_shared` |
| **model_responses** | `completed_at` | Date | Inline, nullable |
| **turn_blocks** | `created_at` | Date | Via `_shared` |
| **event_journal** | `created_at` | Date | Via `_shared` |
| **thread_user_state** | `last_opened_at` | Date | Inline, nullable |
| **thread_documents** | `first_touched_at`, `last_touched_at` | Date | Inline |
| **agent_definitions**, **skills**, **user_installed_skills** | `created_at`, `updated_at` | Date | Via `_shared` |
| **user_preferences**, **user_project_favorites** | `created_at` / `updated_at` | Date | Via `_shared` |
| **project_user_preferences** | `updated_at` | Date | Inline |
| **turn_document_touches** | `touched_at` | Date | Inline |
| **project_results** | `created_at` | Date | Via `_shared` |
| **document_yjs_checkpoints/updates/restore_points** | `created_at` | Date | Via `_shared` |
| **document_yjs_heads** | `updated_at` | Date | Inline |
| **waitlist_emails** | `created_at` | Date | Inline |

#### Implications (Date ↔ postgres-js binding bug)

- **postgres-js rejects raw `Date` objects** embedded in `sql\`...\`` fragments (`ERR_INVALID_ARG_TYPE`).
- **Safe — typed comparators:** Drizzle encodes `Date` through the column type:

```45:56:../../../apps/server/server/domains/billing/adapters/drizzle/subscription-store.ts
function monotonicUpdateWhere(input: SubscriptionUpsertInput) {
  // Typed comparators (lt/eq) encode the Date through the timestamp column so
  // postgres-js receives an ISO string; a raw `sql` fragment would bind the
  // Date object directly and throw ERR_INVALID_ARG_TYPE.
  const inputStart = new Date(input.currentPeriodStart);
  return or(
    lt(userSubscriptions.currentPeriodStart, inputStart),
    and(
      eq(userSubscriptions.currentPeriodStart, inputStart),
      ...
```

- **Safe — explicit cast for string tokens:** ContextFS CAS compares string revisions:

```321:327:../../../apps/server/server/domains/context/adapters/context-fs/drizzle-store.ts
function documentRevisionWhere(revision: string) {
  return revision ? [sql`${documents.updatedAt} = ${revision}::timestamptz`] : [];
}
```

  Reads revision as text for stable microsecond precision:

```445:449:../../../apps/server/server/domains/context/adapters/context-fs/drizzle-store.ts
    const [row] = await currentDrizzleDb(this.db)
      .select({
        id: folders.id,
        updatedAt: sql<string>`${folders.updatedAt}::text`,
      })
```

- **Safe — `.values()` / `.set()`** with `new Date(...)` on Date-mode columns (e.g. credit lot `expiresAt`, subscription upsert).
- **Inconsistent string mode** on `users` and `thread_works` only — most of the schema uses Date mode.

---

## 3. Transaction model

### Core mechanism

```9:22:../../../apps/server/server/shared/drizzle-transaction.ts
const transactionStorage = new AsyncLocalStorage<DrizzleDb>();

export function currentDrizzleDb(db: DrizzleDb): DrizzleDb {
  return transactionStorage.getStore() ?? db;
}

export async function runInDrizzleTransaction<T>(
  db: DrizzleDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  const active = transactionStorage.getStore();
  if (active) return operation();
  return db.transaction((tx) => transactionStorage.run(tx, operation));
}
```

| Behavior | Detail |
|----------|--------|
| **Scope** | One ambient `tx` per outer `runInDrizzleTransaction` call |
| **Nested `runInDrizzleTransaction`** | Reuses existing store — no nested PG savepoint |
| **`currentDrizzleDb(db)`** | Returns ALS store if set, else base `db` |
| **Type union** | `DrizzleDb = DrizzleDatabase \| DrizzleTransaction` |

### Entry points using ALS

| Location | Usage |
|----------|-------|
| `threads/adapters/drizzle/repositories.ts:36–38` | `repos.transaction(op)` → `runInDrizzleTransaction` |
| `billing/adapters/drizzle/credit-ledger.ts:169` | `grant()` wrapped |
| `context/adapters/context-fs/drizzle-store.ts:98, 366` | All tree mutations |
| `context/adapters/thread-uploads/internal-upload-document-store.ts:89` | Upload doc ops |
| `threads/adapters/drizzle/thread-works-repository.ts:15` | `addMembership()` |

### Domain flows that call `repos.transaction()`

Thread creation/handoff/fork routes, runtime loop persistence (`persistence.ts`), checkpoint registry, child-run coordinator spawn, thread upload import (nested: `uploadDocuments.transaction` → `repos.transaction`).

### Parallel pattern: direct `db.transaction()` (no ALS)

These open **independent** PG transactions. Adapters using `currentDrizzleDb(baseDb)` inside them **do not** automatically join unless already in an ALS scope:

| Location | Notes |
|----------|-------|
| `threads/runtime-service.ts:226+` | `sendMessage` — raw `tx` queries, not via repos |
| `threads/adapters/drizzle/event-writer.ts:46` | Own tx when not in ALS; joins ALS when `activeDb !== db` |
| `threads/adapters/drizzle/usage-recorder.ts:44` | Same pattern as event-writer |
| `projects/index.ts:305` | Bootstrap `ensureDefaultBootstrap` |
| `projects/adapters/work-repository/drizzle.ts:65` | Work creation |
| `collab/adapters/drizzle/document-store.ts:93` | Passes `tx` to inner store factory |
| `runtime/tool-registry.ts` | Tool side effects |
| `packages/database/src/event-journal.ts:33` | Package-level journal helper (separate from server event-writer) |

**`credit-ledger.debit()`** uses `activeDb(db)` but does **not** wrap in `runInDrizzleTransaction` — relies on PL/pgSQL `consume_credit_lots_fifo` for atomicity/idempotency.

---

## 4. Adapter / ports pattern

### Layout convention (server domains)

```
apps/server/server/domains/<domain>/
  domain/           # pure logic, types
  ports/            # interfaces (CreditLedger, ThreadRepository, ContextTreeMutationStore, …)
  adapters/
    drizzle/        # Postgres implementations
    in-memory/      # test/smoke implementations
  index.ts          # public factory exports
```

### Composition root (production DI)

`createProductionAppPorts({ db })` in `compose.ts` lines 210–297 wires:

| Port | Drizzle factory |
|------|-----------------|
| Thread repos | `createDrizzleRepositories(db)` |
| Event journal | `createDrizzleEventJournalReader/Writer(db)` |
| Credit ledger | `createDrizzleCreditLedger(db)` → wrapped by `createGrantingCreditLedger` |
| Subscriptions | `createDrizzleSubscriptionStore(db)` |
| Projects/users/works | `createDrizzleProjectRepository`, `createDrizzleUserRepository`, etc. |
| Context FS | `createProductionUnifiedContextPortFactory({ db, documentSync })` → `DrizzleContextTreeMutationStore` |
| Collab | `createDocumentSyncService({ db })` |
| Preferences | `createDrizzleProjectPreferencesRepository({ db })` |
| Packages | `createDrizzlePackageStore({ db })` — **currently delegates to in-memory stub** |

In-memory swap for tests/smoke: `createInMemoryAppServices()` in `compose.ts:455+` replaces thread repos, credit ledger, subscription store, context ports, etc.

Config-driven boundaries: payment provider (`createPaymentProviderFromEnv`), object store (`createObjectStoreFromEnv`), gateway (`createGatewayFromEnv`), model-request debug store — env-selected, not DB-selected.

### Example port → adapter mapping

**CreditLedger** (`billing/ports` implicit via domain interface) → `billing/adapters/drizzle/credit-ledger.ts` using `credit_lots`, `credit_transactions`, raw SQL call to `consume_credit_lots_fifo`.

**ContextTreeMutationStore** → `context/adapters/context-fs/drizzle-store.ts` on `folders` + `documents` tables.

**UserRepository** → `projects/adapters/user-repository/drizzle.ts` on `users`.

---

## 5. Migrations & dev DB

### drizzle-kit

```8:15:../drizzle.config.ts
export default defineConfig({
  schema: "./src/schema/drizzle.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  schemaFilter: ["public"],
});
```

### Migration files (today)

| File | Content |
|------|---------|
| `0000_careless_rockslide.sql` | Full baseline schema + extensions (`pg_trgm`) + functions/triggers |
| `0001_tidy_siren.sql` | `ALTER TABLE user_preferences DROP COLUMN onboarding_state` |
| `meta/_journal.json` | Two entries (idx 0 and 1) |

### `pnpm db:*` scripts (repo root `package.json`)

| Script | Action |
|--------|--------|
| `pnpm db:generate` | `drizzle-kit generate` in `@meridian/database` |
| `pnpm db:migrate` | `drizzle-kit migrate` |
| `pnpm db:apply-functions` | Re-applies PL/pgSQL from `src/functions/` |
| `pnpm db:studio` | drizzle-kit studio |
| `pnpm db:migration-lint` | `tools/dev/migration-lint.ts --all` |
| `pnpm db:reset` | Drop/recreate `public` + `drizzle` schemas, then `prepare-db` |
| `pnpm bootstrap` | Start Docker, ensure DB, migrate, apply-functions |
| `pnpm dev:infra` | Docker compose up (postgres:16 → host **54422**) |
| `pnpm dev:db:prepare` | ensure DB + extensions + migrate + apply-functions |
| `pnpm dev:db:ensure` | Validate/create DB only |

### Dev flow

1. **`pnpm dev:infra`** — start container (`tools/dev/docker-compose.yml`)
2. **`.env`** — `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54422/meridian`
3. **`pnpm bootstrap`** — creates DB if missing (local only), `pg_trgm`, migrate, apply-functions
4. **`pnpm dev`** — calls **`assertDevInfraReady()`** first (`dev-tmux.ts:382`) — read-only ping; does **not** start Docker or migrate

`assertDevInfraReady` (`tools/dev/lib/dev-infra.ts:25–47`): fails fast if `DATABASE_URL` unset or unreachable.

### Seeding

No DB seed on bootstrap. Identity row created on first WorkOS sign-in; personal project via `ensureDefaultBootstrap` (`projects/index.ts`). Package defaults seeded per-project via `defaultPackageSeeder` at runtime.

### PL/pgSQL functions (`src/functions/`)

Applied by `db:apply-functions` after migrate:

- `update_updated_at.sql` — trigger function for `updated_at`
- `consume_credit_lots_fifo.sql` — billing FIFO debit
- `validate_turn_thread_integrity.sql`, `validate_credit_lot_purchase.sql`

Also referenced in `packages/database/src/schema/sql/` for view/trigger SQL embedded in baseline migration.

### Test DB safety

`packages/database/src/__test-support__/db-fixtures.ts`: `RUN_DB_TESTS` requires DB name containing `"test"`, refuses `meridian` dev DB unless `TEST_DB_ALLOW_DESTRUCTIVE=1`.

---

## 6. Raw SQL usage & hazards

### Safe patterns (canonical)

| Pattern | Where | Why safe |
|---------|-------|----------|
| **`eq`/`lt`/`gt`/`lte` on timestamp columns** | `subscription-store.ts:45–56, 80, 96` | Drizzle binds ISO string through column encoder |
| **`${revision}::timestamptz` in `sql` fragment** | `context-fs/drizzle-store.ts:323, 327` | String param cast in SQL, not raw Date |
| **`${column}::text` in SELECT** | `drizzle-store.ts:448, 474` | Stable CAS token string |
| **`.values({ expiresAt: new Date(...) })`** | `credit-ledger.ts:186` | Typed insert binding |
| **PL/pgSQL function calls with typed params** | `credit-ledger.ts:308–316` | Primitives/uuid/jsonb, not Date in sql template |
| **`sql\`now()\`` in `.set()`** | `collab/.../document-store.ts:127` | SQL expression, not JS Date |

### Hazardous patterns

| Pattern | Risk |
|---------|------|
| **`sql\`... ${someDate} ...\``** | postgres-js `ERR_INVALID_ARG_TYPE` |
| **Mixing ALS tx with direct `db.transaction()`** | `currentDrizzleDb(baseDb)` sees base pool, not inner `tx` — split-brain writes |
| **`sql.unsafe()` in dev-db** | Admin scripts only; not used in domain adapters |
| **Debit without outer transaction** | `credit-ledger.debit` autocommits unless caller already in ALS scope |

### Other raw SQL hotspots

- Advisory locks: `context-fs/drizzle-store.ts:381`, `projects/.../work-repository/drizzle.ts:67`, bootstrap in `projects/index.ts:65`
- `pg_notify`: `event-writer.ts:34`
- JSON path filters: `credit-ledger.ts` metadata queries, `event-reader.ts:90`
- Balance aggregations: `billing.ts` view + inline `sql` in credit-ledger

---

## Dependency direction

```
@meridian/contracts  (branded ID types, domain DTOs)
        ↑
@meridian/database   (schema, migrations, createDb, event-journal helper)
        ↑
apps/server/domains/*/adapters/drizzle   (port implementations)
        ↑
apps/server/server/lib/compose.ts + app.ts   (composition root, getDb())
        ↑
apps/server routes / runtime / tools

tools/dev  ──(DATABASE_URL)──►  postgres:16 Docker
apps/www   ──(WEB_DATABASE_URL)──►  same or separate DB; only waitlist table from package schema
```

**Rule:** Domain logic depends on **ports**, never on `@meridian/database` directly (except adapters and a few composition-adjacent modules like `projects/index.ts` bootstrap).

---

## Invariants a DB change must preserve

1. **`DATABASE_URL` is the only app DB seam** — no hardcoded connection strings in domain code.
2. **Identity is app-owned `public.users`** — WorkOS `external_id`; no Supabase/auth schema coupling.
3. **Credit lots are balance truth** — FIFO via `consume_credit_lots_fifo`; `usage_event_id` idempotency; one debt lot per user.
4. **Soft deletes** — `deleted_at IS NULL` partial indexes on projects/works/context tree; queries must filter active rows.
5. **Thread seq monotonicity** — `threads.next_seq` + `event_journal(thread_id, seq)` unique; journal append must be transactional with seq bump.
6. **ContextFS CAS** — revision tokens are `updated_at::text`; mutations use advisory locks per source + `runInDrizzleTransaction`.
7. **Timestamp binding** — never pass JS `Date` into raw `sql` fragments; use typed comparators or explicit PG casts.
8. **Test isolation** — DB tests target throwaway `*test*` databases, not shared dev `meridian`.
9. **Post-migrate functions** — schema changes affecting PL/pgSQL require updating `src/functions/` and running `db:apply-functions`.
10. **Migration discipline** — run `pnpm db:migration-lint` on new SQL; baseline uses squashed history — prefer additive migrations.

---

## Doc drift / open questions

| Item | Notes |
|------|-------|
| **Missing `packages/database/.context/CONTEXT.md`** | qi-layer expects it; only `AGENTS.md` + `README.md` exist today |
| **`AGENTS.md` says "squashed to single baseline"** | Journal has **two** migrations (`0000` + `0001`); wording is stale |
| **`billing/.context/CONTEXT.md` references `lib/` shared** | Actual path is `apps/server/server/shared/drizzle-transaction.ts` |
| **`users` + `thread_works` use `mode:"string"`** | Rest of schema uses Date mode — intentional or legacy? Inconsistent for mappers |
| **`createDrizzlePackageStore` is a stub** | Returns in-memory store despite production wiring (`drizzle-package-store.ts:3–5`) |
| **Dual transaction systems** | ALS (`runInDrizzleTransaction`) vs direct `db.transaction()` coexist; no single documented rule for when to use which |
| **`credit-ledger.debit` not wrapped in ALS** | Works via PL/pgSQL atomicity, but won't join an outer app transaction if one is added later |
| **`packages/database` event-journal vs server event-writer** | Two append implementations; server path is production, package helper may be legacy/test |
| **No `.context/CONTEXT.md` under `packages/database`** | High-value addition for timestamp-mode policy and migration workflow |

---

## Quick “next DB change” checklist

1. Edit schema in `packages/database/src/schema/*.ts`
2. `pnpm db:generate` → review SQL in `src/migrations/`
3. `pnpm db:migration-lint`
4. If functions/triggers changed → update `src/functions/` + `pnpm db:apply-functions`
5. Update adapters if port contracts or column modes shift
6. For timestamp comparisons in adapters: **typed `eq`/`lt`/…** or **`::timestamptz` cast**, never raw `Date` in `sql`
7. For multi-table domain ops: use **`repos.transaction()`** or **`runInDrizzleTransaction`** + **`currentDrizzleDb`** consistently
8. Run conformance tests with `RUN_DB_TESTS=1 DATABASE_URL=...meridian_test...`
