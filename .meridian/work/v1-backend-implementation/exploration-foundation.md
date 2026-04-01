# Foundation Systems Exploration

Date: 2026-03-25
Scope: backend foundation systems only (no FS mirror docs updated)

## Files Covered

Read all files in:
- `backend/internal/domain/errors/`
- `backend/internal/domain/billing/`
- `backend/internal/service/billing/`
- `backend/internal/service/llm/tools/` (including `external/`)
- `backend/internal/domain/auth/`
- `backend/internal/service/auth/`
- `backend/internal/handler/auth_handler.go`

Also traced cross-layer flow through middleware/repositories/streaming/job code where needed.

---

## 1) Error System: `DomainError`, code mapping, middleware/handler behavior

### Core shape
- Structured domain error type is `*domainerrors.DomainError` with `{Code, Status, Message, Detail}` (`backend/internal/domain/errors/errors.go:18`).
- Canonical machine codes live in `codes.go` (e.g. `SPAWN_DEPTH_EXCEEDED`, `PATH_TRAVERSAL_DENIED`) (`backend/internal/domain/errors/codes.go:23`, `backend/internal/domain/errors/codes.go:34`).
- Constructors own HTTP status (callers do not map status themselves), e.g. `SpawnDepthExceeded -> 429` (`backend/internal/domain/errors/errors.go:113`), `PathTraversalDenied -> 403` (`backend/internal/domain/errors/errors.go:164`).

### HTTP rendering path
- `handleError` prioritizes `*DomainError` first and returns JSON payload:
  - `{code, message, detail}` via `RespondJSON` (`backend/internal/handler/helpers.go:93`, `backend/internal/handler/helpers.go:98`).
- If not `DomainError`, it falls back to legacy typed errors (`*domain.NotFoundError`, `*domain.ValidationError`, etc.) and maps status in `domainErrorStatusCode` (`backend/internal/handler/helpers.go:39`).
- Legacy path emits RFC7807 problem responses (`application/problem+json`) via `RespondError` / `RespondErrorWithExtras` (`backend/internal/httputil/response.go:58`, `backend/internal/httputil/response.go:81`).

### Current state (important)
- Two error systems coexist:
  - New structured `internal/domain/errors` for v1 conditions.
  - Legacy `internal/domain/errors.go` typed/sentinel errors for most repository/service flows (`backend/internal/domain/errors.go:7`).
- This means response envelope can differ by code path:
  - New: `{code,message,detail}`.
  - Legacy: RFC7807 (`type/title/status/detail` + extras).

---

## 2) Error flow: repository -> service -> handler -> HTTP

### Typical flow pattern
1. Repository emits domain typed error or wrapped infra error.
2. Service may validate/translate and often wraps with context.
3. Handler calls `handleError` and maps to HTTP status/shape.

### Concrete examples
- Project lookup by owner:
  - Repo `GetByID` filters by `p.user_id = $2`; missing row => `domain.NewNotFoundError("project", ...)` (`backend/internal/repository/postgres/docsystem/project.go:76`, `backend/internal/repository/postgres/docsystem/project.go:82`, `backend/internal/repository/postgres/docsystem/project.go:103`).
  - Authorizer transforms project not found into forbidden for resource-hiding (`backend/internal/service/auth/owner_authorizer.go:51`, `backend/internal/service/auth/owner_authorizer.go:53`).
  - Handler returns 403 through legacy mapping (`backend/internal/handler/helpers.go:55`).

- Billing insufficient credits:
  - FIFO store maps anchor-missing DB error to `domain.NewInsufficientCreditsError` (`backend/internal/repository/postgres/billing/credit_store.go:354`).
  - Handler maps to 402 and includes balance/required/shortfall extras (`backend/internal/handler/helpers.go:118`).
  - For `POST /api/turns`, middleware `CreditGate` performs early admission and emits 402 directly (`backend/internal/middleware/credit_gate.go:22`, `backend/internal/middleware/credit_gate.go:25`).

---

## 3) Billing/Credits: credit lots, FIFO, millicredits, purchase vs grant

### Accounting model
- Unit is `millicredits` (`int64`) across balances, transactions, lots (`backend/internal/domain/billing/types.go:38`, `backend/internal/domain/billing/types.go:58`, `backend/internal/domain/billing/types.go:71`).
- Source types: `purchase` vs `grant` (`backend/internal/domain/billing/types.go:15`, `backend/internal/domain/billing/types.go:16`).
- Ledger transaction types include `purchase`, `grant`, `consumption`, `expiration`, `refund` (`backend/internal/domain/billing/types.go:22`).

### Schema invariants
- `credit_lots` constraints enforce mutually-exclusive purchase/grant fields (`backend/migrations/00030_billing_credit_system.sql:24`).
- Idempotency uniqueness:
  - `stripe_session_id` unique (purchase) (`backend/migrations/00030_billing_credit_system.sql:36`).
  - `(user_id, grant_reason)` unique (monthly grant) (`backend/migrations/00030_billing_credit_system.sql:40`).

### FIFO consumption details
- Implemented in SQL function `consume_credit_lots_fifo(...)` (`backend/migrations/00030_billing_credit_system.sql:113`).
- Concurrency guard: advisory transaction lock on `consumption_group_id` (`backend/migrations/00030_billing_credit_system.sql:132`).
- Idempotency: if a transaction already exists with same `consumption_group_id`, function returns without duplicate debit (`backend/migrations/00030_billing_credit_system.sql:139`).
- Spend order: soonest expiring positive lots first, then creation order (`backend/migrations/00030_billing_credit_system.sql:155`).
- Overspend behavior:
  - If positive funds insufficient, debits remaining amount from anchor lot (can go negative => debt) (`backend/migrations/00030_billing_credit_system.sql:220`).
  - If no anchor lot exists, raises `credit_anchor_missing` (`backend/migrations/00030_billing_credit_system.sql:215`).
- Go store maps anchor-missing to `InsufficientCreditsError` (`backend/internal/repository/postgres/billing/credit_store.go:354`).

---

## 4) Stripe integration: session flow + idempotency

### Endpoint and auth behavior
- Webhook handler: `POST /api/billing/webhooks/stripe` (`backend/internal/handler/billing.go:121`).
- Global auth middleware explicitly bypasses this path (`backend/internal/middleware/auth.go:26`).

### Validation and event routing
- Service validates payload/signature and constructs event via Stripe SDK webhook verification (`backend/internal/service/billing/credit_service.go:136`, `backend/internal/service/billing/stripe_client.go:69`, `backend/internal/service/billing/stripe_client.go:74`).
- Handles:
  - `checkout.session.completed`
  - `charge.refunded`
  - `charge.dispute.created`
  (`backend/internal/domain/billing/stripe.go:9`, `backend/internal/service/billing/credit_service.go:149`).

### Checkout completion
- Retrieves authoritative session from Stripe (`backend/internal/service/billing/credit_service.go:168`).
- Requires paid payment mode and validates metadata (`user_id`, `pack_id`) + exact amount match (`backend/internal/service/billing/credit_service.go:176`, `backend/internal/service/billing/credit_service.go:185`, `backend/internal/service/billing/credit_service.go:194`).
- Persists purchase lot with expiration and purchase transaction (`backend/internal/service/billing/credit_service.go:198`).

### Idempotency mechanisms
- Purchase insert uses `ON CONFLICT DO NOTHING` (unique `stripe_session_id`) (`backend/internal/repository/postgres/billing/credit_store.go:152`).
- Refund path is idempotent by checking existing `refund` transaction before insert (`backend/internal/repository/postgres/billing/credit_store.go:285`, `backend/internal/repository/postgres/billing/credit_store.go:298`).

---

## 5) Generation billing: authoritative settlement and deferred retry

### Costing and IDs
- Billing namespace is fixed UUID; comment says it must never change for idempotency (`backend/internal/domain/billing/pricing.go:22`).
- `usageEventID = "<turnID>:<requestIndex>"` and `consumptionGroupID = SHA1(namespace, usageEventID)` (`backend/internal/service/billing/credit_settler.go:62`, `backend/internal/service/billing/credit_settler.go:63`).
- Cost computed with integer-only math + markup (`backend/internal/domain/billing/pricing.go:113`).

### Write-ahead settlement flow
- `SettleAuthoritativeRequest` first writes deterministic billing fields to turn metadata, then runs FIFO consume (`backend/internal/service/billing/credit_settler.go:78`, `backend/internal/service/billing/credit_settler.go:94`).
- On consume failure, status becomes `pending`; on success, `settled` (`backend/internal/service/billing/credit_settler.go:95`, `backend/internal/service/billing/credit_settler.go:108`).

### Retry/reconciliation
- `RetryPendingSettlement` reuses persisted fields, increments retry count, and eventually marks `failed` at max retries (`backend/internal/service/billing/credit_settler.go:173`, `backend/internal/service/billing/credit_settler.go:175`).
- Pending query intentionally skips placeholder rows without complete write-ahead data (`backend/internal/repository/postgres/billing/generation_billing_store.go:259`).

### Deferred mode in enrichment job
- Enrichment job calls `settleIfDeferred` after generation stats finalize, and retries on settlement failures (`backend/internal/jobs/enrich_generation.go:399`, `backend/internal/jobs/enrich_generation.go:435`).

---

## 6) Tool registry: registration, filtering, execution

### Registry behavior
- Thread-safe map with RW lock (`backend/internal/service/llm/tools/registry.go:37`).
- Registers tools with metadata for prompt section generation (`backend/internal/service/llm/tools/registry.go:49`, `backend/internal/service/llm/tools/registry.go:94`).
- `Prune` removes tools post-registration (used by persona policy) (`backend/internal/service/llm/tools/registry.go:148`).

### Execution
- Single-call execution returns structured `ToolResult` (`backend/internal/service/llm/tools/registry.go:163`).
- Multi-call executes in goroutines and preserves call order by index (`backend/internal/service/llm/tools/registry.go:198`, `backend/internal/service/llm/tools/registry.go:231`).

---

## 7) Tool builder: option pattern and composition

`ToolRegistryBuilder` composes registry in stages (builder pattern):
- Namespace service (`WithNamespaceService`) (`backend/internal/service/llm/tools/builder.go:35`)
- Mutation strategy (`WithMutationStrategy`) (`backend/internal/service/llm/tools/builder.go:42`)
- Work item slug isolation (`WithWorkItemSlug`) (`backend/internal/service/llm/tools/builder.go:51`)
- Document tools (`str_replace_based_edit_tool`, `doc_search`) (`backend/internal/service/llm/tools/builder.go:60`)
- Web search (`WithWebSearch`) (`backend/internal/service/llm/tools/builder.go:89`)
- Spawn tool gated on invoker+work item (`backend/internal/service/llm/tools/builder.go:104`, `backend/internal/service/llm/tools/builder.go:111`)
- Skill tools (`skill_invoke`, `skill_list`) (`backend/internal/service/llm/tools/builder.go:125`)
- Persona allow/deny filtering (`WithPersonaToolFilter`) (`backend/internal/service/llm/tools/builder.go:166`)

Key architectural detail: tools package depends on service interfaces, not repos directly (`backend/internal/service/llm/tools/builder.go:10`).

---

## 8) Text editor tool: mutation strategy, namespace isolation, path handling

### Commands and behavior
- Unified `str_replace_based_edit_tool` supports `view`, `str_replace`, `insert`, `create` (`backend/internal/service/llm/tools/text_editor.go:83`, `backend/internal/service/llm/tools/text_editor.go:107`).
- `view` can read `.meridian/**`; write operations enforce namespace checks (`backend/internal/service/llm/tools/text_editor.go:127`, `backend/internal/service/llm/tools/text_editor.go:267`).

### Mutation strategy (collab vs direct)
- Text editor itself is strategy-driven (`mutationStrategy.Apply`) (`backend/internal/service/llm/tools/text_editor.go:320`).
- Current collab strategy converts text diffs to Yjs updates, creates proposal, and broadcasts accepted/pending events (`backend/internal/service/llm/tools/mutation_strategy_collab.go:49`, `backend/internal/service/llm/tools/mutation_strategy_collab.go:107`, `backend/internal/service/llm/tools/mutation_strategy_collab.go:161`).

### Namespace isolation rules (write path)
- Canonicalize then inspect namespace; explicit `..` segment yields `PathTraversalDenied` (`backend/internal/service/llm/tools/text_editor.go:519`, `backend/internal/service/llm/tools/text_editor.go:529`).
- Rules:
  - `.meridian/work/<slug>/` only current `workItemSlug`
  - `.meridian/fs/` allowed
  - `.agents/` allowed
  - other `.meridian/` denied
  - `.session/` denied
  (`backend/internal/service/llm/tools/text_editor.go:512`).
- Errors become structured tool results with domain codes (`backend/internal/service/llm/tools/text_editor.go:586`).

---

## 9) Skill invoke tool: runtime execution model

### Source of truth
- Runtime skill interface states file-only source: `.agents/skills/<slug>/SKILL.md` (`backend/internal/domain/agents/interfaces.go:13`).
- Resolver reads/parses file frontmatter and returns `SkillNotFound` / `SkillInvalid` domain errors (`backend/internal/service/agents/skill_resolver.go:67`, `backend/internal/service/agents/skill_resolver.go:73`, `backend/internal/service/agents/skill_resolver.go:85`).

### Tool behavior
- `skill_invoke` parses `skill_name`, optional `arguments`, resolves skill, substitutes `$ARGUMENTS` (`backend/internal/service/llm/tools/skill_invoke.go:94`, `backend/internal/service/llm/tools/skill_invoke.go:116`, `backend/internal/service/llm/tools/skill_invoke.go:136`).
- Enforces `ModelInvocable` unless invocation is explicit user slash call (`backend/internal/service/llm/tools/skill_invoke.go:125`).

---

## 10) Web search, thread context, and search tools

### Web search
- `web_search` tool validates `query`, optional `max_results` and `topic` (`general/news/finance`) (`backend/internal/service/llm/tools/web_search.go:50`, `backend/internal/service/llm/tools/web_search.go:78`).
- Uses provider-agnostic `SearchClient`; Tavily implementation posts to API and normalizes result fields (`backend/internal/service/llm/tools/external/client.go:12`, `backend/internal/service/llm/tools/external/tavily_client.go:50`).

### Thread context propagation
- Streaming executor injects `threadID/turnID/userID` into context before parallel tool execution (`backend/internal/service/llm/streaming/tool_executor.go:118`, `backend/internal/service/llm/streaming/tool_executor.go:123`).
- Tools can extract this context for provenance (`backend/internal/service/llm/tools/thread_context.go:18`, `backend/internal/service/llm/tools/thread_context.go:27`).

### Internal document search constraints
- `doc_search` denies `.meridian/` and `.session/` namespaces (`backend/internal/service/llm/tools/search.go:80`, `backend/internal/service/llm/tools/search.go:88`).

---

## 11) Auth: Supabase JWT validation + project membership model

### JWT validation
- Global `AuthMiddleware` validates bearer token and injects user + auth claims into request context (`backend/internal/middleware/auth.go:34`, `backend/internal/middleware/auth.go:50`, `backend/internal/middleware/auth.go:64`).
- Exclusions: `/health`, Stripe webhook endpoint, websocket entrypoints (`backend/internal/middleware/auth.go:25`).
- `SupabaseJWTVerifier` uses JWKS (`keyfunc`), checks token validity, algorithm allowlist (`RS256|ES256`), `sub`, and role `authenticated` (`backend/internal/auth/jwt_verifier.go:33`, `backend/internal/auth/jwt_verifier.go:64`, `backend/internal/auth/jwt_verifier.go:87`).

### Membership semantics (current implementation)
- There is no multi-member project membership model in this path.
- Authorization is ownership-based:
  - Project queries scoped by `project.user_id` (`backend/internal/repository/postgres/docsystem/project.go:82`).
  - `OwnerBasedAuthorizer` checks project ownership and derives access for folder/document/thread/turn (`backend/internal/service/auth/owner_authorizer.go:45`, `backend/internal/service/auth/owner_authorizer.go:85`, `backend/internal/service/auth/owner_authorizer.go:97`).
- Security behavior: missing project in ownership check is rewritten to forbidden to avoid existence leaks (`backend/internal/service/auth/owner_authorizer.go:52`).

---

## 12) Auth flow: middleware -> handlers -> services

### End-to-end path
1. `AuthMiddleware` validates JWT and populates context (`backend/internal/middleware/auth.go:50`, `backend/internal/middleware/auth.go:65`).
2. Handlers read user/claims from context (`httputil.GetUserID`, `httputil.GetAuthClaims`) (`backend/internal/handler/auth_handler.go:40`, `backend/internal/handler/auth_handler.go:46`).
3. Service layer executes domain operation (e.g., monthly credit initialization via `CreditGranter`) (`backend/internal/handler/auth_handler.go:52`).
4. Errors funnel through `handleError` and map to typed HTTP responses (`backend/internal/handler/auth_handler.go:61`, `backend/internal/handler/helpers.go:93`).

### `POST /api/auth/initialize`
- Requires authenticated user and claims (`backend/internal/handler/auth_handler.go:41`, `backend/internal/handler/auth_handler.go:47`).
- Calls `InitializeSignupCredits`; if email unverified, no grant (`backend/internal/service/billing/credit_granter.go:40`).
- Monthly grant idempotency keyed by `monthly_refresh_YYYY_MM` (`backend/internal/service/billing/credit_granter.go:77`).

---

## Cross-System Observations

1. Error envelope inconsistency is intentional transitional state (new `DomainError` vs legacy RFC7807), but clients must handle both.
2. Billing idempotency is implemented at multiple layers:
   - DB uniqueness and `ON CONFLICT`
   - consumption-group lock/idempotency in SQL function
   - deterministic usage/consumption IDs in settler
3. Tooling architecture is modular and policy-driven:
   - Builder composes capabilities per request context.
   - Registry and persona filters enforce dynamic least-privilege tool sets.
   - Namespace isolation in text editor is explicit and defensive.
4. Auth is strong on JWT verification and ownership checks, but currently does not model shared project membership.

---

## Requested Topic Checklist

1. DomainError system: covered
2. Error flow repo->service->handler->HTTP: covered
3. Credit lots FIFO/millicredits/purchase-vs-grant: covered
4. Stripe session handling/idempotency: covered
5. Generation billing path: covered
6. Tool registry: covered
7. Tool builder options/composition: covered
8. Text editor mutation + namespace + path resolution: covered
9. Skill invoke as tool: covered
10. Web search + thread context + search tools: covered
11. Supabase JWT + membership model: covered
12. Auth middleware/handler/service flow: covered
