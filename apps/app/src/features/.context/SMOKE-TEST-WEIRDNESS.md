# Smoke-Test Findings — flagged for human review

Recorded during Phase-2 end-to-end browser smoke test (2026-06-05).
These are observations OUTSIDE the 5 implementation tracks (T1–T5). Tracks
themselves are covered separately.

## 🔴 PRE-EXISTING BUG (not caused by Phase-2 tracks): home→project create never persists

**Symptom:** Typing a message in the Home composer and pressing Send navigates
to `/project/{id}` but the project is **never created on the server**. The route
loader then 404s on `/api/projects/{id}/threads` and `/works` ("Project not found"),
and the project view renders empty. DB confirms 0 projects after the flow.

**Root cause (suspected):** `apps/app/src/features/chat/useThreadHandoff.ts`
performs the deferred `createProject()` + `createThread()` only when a **thread
view** mounts and consumes the `pendingStream.deferredSend`. The Home "Send"
navigates to the **project home** route (`/project/{id}`), which does not mount
that thread view, so the deferred create never fires. The SSR loader
(`apps/app/src/client/query/project-route-data.ts`) runs first and 404s.

**Scope:** NONE of these files are in the Phase-2 diff
(`useThreadHandoff.ts`, `project-route-data.ts`, `projects-api.ts`, Home composer).
Confirmed pre-existing. The backend `POST /api/projects` works correctly (verified
201 + persisted via in-browser fetch). So the defect is purely the client-side
navigate-then-create handoff ordering / wrong navigation target.

**Suggested fix direction (for later):** either (a) navigate Home-send to the
thread route that owns the handoff, or (b) make the project-home route also
consume `deferredSend`, or (c) create the project synchronously before
navigating instead of optimistically.

## 🟡 Observed: SSR route loader treats first-load 404 as a hard console error

`loadProjectRouteData` logs "Failed to load project data during SSR" as an error
for a not-yet-existent project. Even after the create flow is fixed, consider
treating "project not found" as a soft/empty state rather than a thrown SSR error.

## ✅ Verified working
- Auth + user provisioning (login as Test Dev, user row auto-provisioned).
- `POST /api/projects` → 201, persisted.
- Project view header, workspace nav, installed-extensions rail all render.
- Zero console errors on the Home screen itself.

## 🟡 Provisioning not robust to unstable user ids (intermittent 500)

**Symptom:** On a fresh page-load burst after a DB reset, `GET /api/projects`
intermittently 500s with `duplicate key value violates unique constraint
"users_email_unique"`. Self-heals on the next request.

**Root cause:** `apps/server/server/domains/projects/adapters/user-repository/drizzle.ts`
`ensureUser()` upserts with `onConflictDoUpdate({ target: users.id })`. The
conflict target is `id`, but the violated constraint is `email`. So if a session
ever presents a NEW id with an ALREADY-EXISTING email, the id-targeted conflict
clause misses and Postgres throws on the email unique constraint.

**Why it's not fixed here:** Under the production contract (auth provider returns
a stable id per email), `target: id` is correct and an email can never collide
with a different id. The instability comes from dev-auth (`apps/app/src/server/dev-auth.ts`,
dev tooling owned by another agent) regenerating user ids. Fixing `ensureUser`
to also guard `email` would mask a dev-tooling identity bug rather than fix it.

**Recommended (for later):** make dev-auth mint a STABLE id per dev email. If you
want defense-in-depth in prod too, change provisioning to be email-keyed
(resolve existing id by email, or `onConflictDoNothing` on email then re-select).

## 🔴 REGRESSION (fixed in this session): Yjs WS "opened before authenticated upgrade"

**Introduced by:** the auth-gate migration (p1262) of
`apps/server/server/routes/ws/yjs/[documentId].ts`.

**Symptom:** Editor sync status stuck on "Syncing local copy"; browser console
`WebSocket connection to '.../ws/yjs/{id}' failed: closed before the connection
is established`; server log spams `[unhandledRejection] Error: Yjs WebSocket
opened before authenticated upgrade`. Server→client Yjs sync never completes
(client→server update persistence still worked, so it was easy to miss).

**Root cause:** p1262 introduced a per-connection closure variable
`servicesPromise` set ONLY inside the `upgrade()` hook, and made
`open()`/`message()`/`close()` call `getAuthedServices()` which throws if it's
null. In the portless-proxied dev WS path the `upgrade` hook does not reliably
populate that closure before `open()` fires. The ORIGINAL (pre-p1262) code
resolved services from the module-global `getApp()` — independent of `upgrade` —
and only took `userId` from `peer.context` (set by upgrade's return). Services
are app-global and never needed the per-connection auth closure.

**Fix applied:** decoupled service resolution from the upgrade closure (restored
module-global resolution), kept the auth-gate call (`resolveAppUserFromRequest`)
for 401 + `canAccessDocument` 404 + setting `peer.context.userId`.

**✅ VERIFIED FIXED (2026-06-05, p1264) — full browser round-trip:**
- WS connects through portless → vite proxy → nitro (`open` + sync frames received).
- Typed text persists client→server (`document_yjs_updates` grew 2 → 44 rows).
- `markdown_projection` updates via `afterPersist` → `readAsMarkdown` →
  `updateDocumentProjectionById` (projection matched the typed text exactly).
- Server→client round-trip proven by **clearing IndexedDB + reloading**: the editor
  re-rendered the typed text sourced purely from the server, and the WS log showed
  the surviving socket receiving the content frames. Sync badge: "Saved locally".

## 🟢 Benign (dev-only): one "WebSocket closed before connection established" warning per editor mount

React StrictMode double-invokes the EditorView mount effect in dev. The throwaway
first `DocumentSession` opens a Yjs socket, then StrictMode's immediate cleanup
calls `transport.destroy()` → `socket.close()` before the handshake completes,
emitting the browser warning (seen as `yjs#3 CREATE → .close() → CLOSE 1006` in the
instrumented WS log). The **second** (surviving) session's socket (`yjs#4`) opens
and syncs normally. Cosmetic dev-only noise — does not occur in production (no
StrictMode double-mount). Not worth touching the cursor-stability-sensitive
session-recreation code to silence it.

## ⚠️ Dev-stack fragility (operational, not a code defect)

`apps/server` (nitro dev) crashed because the **pre-p1262** unhandledRejection
(`Yjs WebSocket opened before authenticated upgrade`) tore the process down, and
`pnpm dev`/`pnpm dev:restart` cannot relaunch it: `prepare-db` runs
`db:migrate` which fails on stale migrations (schema is applied via `db:push`).
Worked around by relaunching the server directly:
`direnv exec . pnpm exec portless run --name api.meridian pnpm --filter @meridian/server dev`.
The app's vite WS proxy also needed a restart afterward. `tools/dev/**` is owned by
another agent — flagging the migrate-vs-push mismatch for them to reconcile.

## 🔧 FIXED THIS SESSION (p1266): independent quick-chat created an empty title → server 400

**Symptom:** Home → "Start a quick chat without a project" navigates to
`/chat/{threadId}`, then `POST /api/projects` returns **400 "title is required"**
and `/api/threads/{id}/snapshot` 404s — the chat never materializes.

**Root cause:** `startIndependentChat()` in `apps/app/src/lib/optimistic-project.ts`
set `const title = trimmed ? deriveTitleFromMessage(trimmed) : ""`. The `: ""`
branch emitted an empty title for the no-first-message case, which the server's
`projects/index.post.ts` rejects. `deriveTitleFromMessage("")` already returns the
canonical localized default ("New chat"), so the short-circuit was both redundant
and the bug.

**Decision (tech-lead):** This is a clearly-broken core flow, not a design choice
(the path DOES create a real project+thread via the deferred handoff), and the fix
honors the existing server contract using the existing canonical helper. In-scope
per the goal's "stuff isn't wired up → fix it." **Fix:** call
`deriveTitleFromMessage(trimmed)` unconditionally.

**NOTE — still flagged, NOT fixed:** the *other* create bug (Home composer send →
`/project/{id}`, where the thread view never mounts so the deferred create never
fires) is a distinct navigation/architecture issue and remains a 🔴 finding above
for human review. It needs a design call (navigate to the thread surface, or have
the project-home route consume `deferredSend`, or create synchronously).

## 🧪 Final review triage (2026-06-05) — two reviewers (thermo-nuclear + improve-architecture)

Both reviewers independently raised the same two items (high signal). Tech-lead triage:

### ✅ FIXING (p1270): package conformance test validated a SHADOW schema
Both flagged `domains/packages/adapters/__conformance__/drizzle-package-repository.test.ts`
hand-clones production DDL and masks the `ordinal` columns with
`ALTER ... ADD COLUMN IF NOT EXISTS` — false-green on a test whose job is to catch
schema drift. Fix: consume the canonical `@meridian/database` schema via `db:push`
(mirroring the collab document-store conformance test), delete the hand-cloned DDL.

### ⚪ FLAGGED, deliberately NOT auto-fixed (tech-lead judgment)
1. **Auth seam boots `getApp()` before resolving auth** (`lib/auth-gate.ts:27-30`).
   Reviewers called it a blocker citing "every 401 pays full app bootstrap." But
   `getApp()` is **memoized** (singleton via `globalThis` store in `lib/app.ts`),
   so the cost is paid once, not per request — the stated impact is overstated.
   The residual valid point (auth conceptually coupled to app composition; an
   app-init failure surfaces as 500 instead of 401) is minor: a server that can't
   compose can't serve anyway. The fix requires splitting `requireUser` into
   session-resolve (no deps) + provision (needs `app.users`) — a real refactor of a
   **verified-working** auth/provisioning path (login, provisioning, chat all green
   in smoke). Not worth the regression risk now. **Recommended later:** make
   `auth-gate` compose `resolveSession(request)` → 401-early → `getApp()` + provision.
2. **Thread WS keeps an in-band `"auth"` message whose token is ignored**
   (`routes/api/threads/ws.ts`, `lib/ws-thread-handler.ts`). Real auth is the
   upgrade-request cookie; the message branch is vestigial. Cleaner shape: move
   thread WS auth to an `upgrade` hook like the Yjs route and delete the message
   branch. This is a protocol/scope change touching the client too; chat streaming
   is verified working (smoke: assistant replied "PONG"). **Flagged for a dedicated
   follow-up**, not folded into this ship.

### 🟡 Noted nice-to-haves (no action this ship)
- Yjs route reaches `getDb()` directly for the markdown projection write instead of
  going through `AppServices` (`routes/ws/yjs/[documentId].ts`). Minor layer
  fragmentation; consider an app-level `afterPersistDocument` port later.
- Checked-in Drizzle migration SQL (`packages/database/drizzle/*.sql`) lacks the
  `ordinal` columns that the TS schema has. The repo provisions via `db:push` (the
  migration set is known-stale per AGENTS.md), so this is not the deploy path — but
  the migration artifacts should eventually be regenerated or removed. Owned by
  whoever manages the migration set, not this track.


## 🔴→✅ FIXED (2026-06-05, p1273+p1274): WS upgrade crashed the nitro dev server

**Symptom:** The api dev server (`apps/server`, nitro dev) booted, served HTTP,
then **exited 1 within ~1s of a WebSocket connect** with
`httpxy: Upstream server did not upgrade the connection`. A browser reconnect
storm on `/api/threads/ws` (or any unauth `/ws/yjs/*`) crash-looped it, so the
app shell loaded but every `/api/*` and `/ws/*` call 404'd.

**Root cause (confirmed):** nitro dev runs a parent httpxy proxy in front of the
worker. `proxyWs` REJECTS (unhandled → process exit) whenever a WS `upgrade` hook
yields a **non-101** response. Both WS routes did exactly that on auth/authz
failure: the thread route lacked an `upgrade` hook and the yjs route
`throw new Response(..., {status: 401/404})`. (My earlier assumption that the yjs
route "survived" was wrong — it is a latent crasher on any unauth probe.)

**Fix:** Authenticate in the `upgrade` hook and, on failure, **accept the socket
then close it from `open()`** with a close code — never return a non-101 response.
Extracted the shared mechanic into `apps/server/server/lib/ws-upgrade-auth.ts`;
both `routes/api/threads/ws.ts` and `routes/ws/yjs/[documentId].ts` use it. The
in-band thread `"auth"` message protocol is preserved (client still sends `auth`,
gets `connected`), now reusing upgrade-resolved context.

**✅ VERIFIED:** 30s unauth WS load on BOTH endpoints — hundreds of open→close
cycles, 0 errors, **zero** new `did not upgrade` crashes, zero supervisor
restarts; `GET /api/projects` stays 401; typecheck + biome + server lib tests
(16/16) green.

**⚠️ Operational note (dev-tooling, flag for tools/dev owner):** the underlying
fragility is that nitro dev's httpxy proxy turns ANY transient non-101 WS upgrade
(including a worker mid-HMR-rebuild) into a fatal unhandled rejection. Our routes
no longer trigger it, but a dev-time rebuild race could still surface it. A
supervisor/auto-restart or catching that rejection in the dev preset would make
`pnpm dev` robust. (During this session the api was kept alive by an ad-hoc
`/tmp/api-supervisor.sh` restart loop.)


## ✅ E2E SMOKE RUN (2026-06-05, tech-lead via playwright-cli) — all 3 runbooks PASS

Ran `tests/smoke/guides/browser/*` against the live portless stack after the WS
hardening. **0 server crashes / 0 supervisor restarts** during the entire run.

- **quick-chat-create** ✅ — Home → "Start a quick chat without a project" →
  `/chat/{id}`, title "New chat", composer enabled; thread persisted in DB with a
  backing project. (Finding below: initial snapshot 404 race.)
- **thread-streaming** ✅ — sent "Reply with exactly the word PONG."; assistant
  streamed reasoning + `PONG`; DB shows user+assistant turns both `complete`,
  thread back to `idle`. Proves thread-WS upgrade + in-band auth + subscribe +
  orchestrator/gateway streaming all work post-hardening.
- **editor-collab** ✅ (load-bearing) — created KB `notes.md`, typed
  `SMOKE-roundtrip-20260605-A`; `document_yjs_updates` 2→29; `markdown_projection`
  contains the marker; **cleared IndexedDB + reloaded → marker re-rendered purely
  from the server**; badge "Saved locally". Only the documented benign StrictMode
  WS warning, no errors.

## 🟡 Finding (quick-chat): initial `GET /api/threads/{id}/snapshot` 404 race
On landing at `/chat/{id}` from the quick-chat button, the snapshot fetch fires
before the deferred project+thread create completes server-side, logging one 404
in the console. The thread DOES materialize (verified in DB moments later:
`New chat | idle`, project_id set). Cosmetic race, not a broken flow — but the
loader could treat a first-load 404 as a soft "not yet created" state, or the
deferred create could be awaited before the first snapshot fetch. The
quick-chat-create runbook asserts snapshot==200, so it is slightly optimistic
about timing; the DB assertion is the reliable one.

## 🔴→🛠️ Finding (FIXING, p1275): Context screen (KB editor) unreachable via nav
**Symptom:** On a project that has any chat thread, clicking the **Context** nav
button (or navigating to `?screen=context`) does not open the Context/KB screen —
the URL is rewritten to `?thread=<id>` and the app bounces to **Chat**. The T1
editor is only reachable by manually putting the active thread in the URL
(`?screen=context&thread=<activeThreadId>`).

**Root cause (confirmed):** `apps/app/src/features/project/chat/ChatDockPanel.tsx`
(the persistent chat dock shown beside the KB editor) has a mount effect that
calls `onSelectThread(primaryThreads[0].id)` when no thread is active. Entering the
Context screen clears `thread` (route `handleSelectScreen` drops it for non-chat
screens), so the dock immediately re-selects a thread via `onSelectThread` →
`handleSelectThread` → `patchSearch({ screen: undefined, thread })`, which clobbers
`screen=context` and collapses `resolvedScreen` back to `chat`.

**Fix direction (p1275):** make the dock's thread fallback display-only (no
mount-time URL navigation) and give the dock a screen-preserving thread setter so
switching the dock thread keeps you on the Context screen. Verified via playwright
that Context nav opens the editor with a thread present.

**Note:** This makes a Phase-2 deliverable (the T1 editor surface) unreachable
through normal UI, so it is in-scope to fix this ship.
