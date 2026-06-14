# A1-A4 Design Review Synthesis (Round 3)

8 reviewers (6x Opus, 2x Sonnet), each with a different focus area. All 8 returned "request changes."

## Spawn Reference

| Reviewer | Model | Focus | Key Findings |
|----------|-------|-------|--------------|
| R1 | Opus | A1 Billing Correctness | 2 CRITICAL, 4 HIGH, 4 MEDIUM, 2 LOW |
| R2 | Opus | A1 Billing Security & Stripe | 1 CRITICAL, 3 HIGH, 4 MEDIUM, 2 LOW |
| R3 | Opus | A3 Agents+Skills Migration | 2 CRITICAL, 5 HIGH, 5 MEDIUM, 2 LOW |
| R4 | Opus | A4 Work Items Completeness | 5 HIGH, 5 MEDIUM, 2 LOW |
| R5 | Opus | Cross-Workstream Integration | 1 CRITICAL, 4 HIGH, 5 MEDIUM, 1 LOW |
| R6 | Sonnet | Architecture Compliance | 2 HIGH, 3 MEDIUM, 1 LOW |
| R7 | Sonnet | Coder-Readiness Assessment | 4 BLOCKS, 7 SLOWS, 5 MINOR |
| R8 | Opus | Prior Review Resolution | 3 STILL OPEN, 1 PARTIAL, 5 RESOLVED |

**After dedup:** 6 distinct critical/blocking themes, ~18 distinct high findings, ~12 medium findings.

## Coder-Readiness Ratings

| Workstream | Rating | Top Blocker |
|------------|--------|-------------|
| A1 Billing | NEEDS-DESIGN-WORK | No Go interfaces, no streaming integration spec, no API routes |
| A2 Auth | READY | Minor: signup trigger mechanism unspecified |
| A3 Agents+Skills | NEEDS-MINOR-ADDITIONS | YAML frontmatter schema undefined |
| A4 Work Items | NEEDS-MINOR-ADDITIONS | API routes, thread association mechanism |

## CRITICAL / BLOCKING Findings

### B1. FIFO Multi-Lot Deduction Is Unimplementable as Written
**Flagged by:** R1-1, R1-2, R2-5, R5-11 | **Workstream:** A1

The FIFO SQL sketch is pseudocode hiding the hardest part. Multi-lot deduction needs PL/pgSQL or transactional multi-UPDATE with `FOR UPDATE`. Audit trail is lossy (H5 still open) -- single `lot_id` per transaction row can't track multi-lot consumption. Concurrent race is worse than stated: true worst case is `3 streams x 20 tool rounds x 15 credits = 900 credits ($9.00)`, not "one inference step."

**Fix:** PL/pgSQL function with `FOR UPDATE`, `consumption_group_id` on transactions, `CHECK (remaining >= 0)` on lots, FIFO query filters expired lots by `expires_at > NOW()`.

### B2. Stripe Webhook Has No Signature Verification
**Flagged by:** R2-1, R8 (H11 STILL OPEN) | **Workstream:** A1

Zero mention of `stripe.ConstructEvent`, webhook signing secret, or timestamp tolerance. Allows unlimited credit minting via forged webhooks.

**Fix:** Add signature verification, `STRIPE_WEBHOOK_SECRET` env var, JWT middleware exclusion, session verification, transactional lot+transaction insert.

### B3. No Signup-to-Credit-Grant Trigger Mechanism
**Flagged by:** R5-1, R2-9 | **Workstream:** A1+A2

Backend never learns about Supabase signups. No trigger mechanism designed. No grant deduplication (missing `UNIQUE(user_id, grant_reason)`).

**Fix:** Frontend-mediated `POST /api/auth/initialize` with idempotency, or Supabase webhook. Add partial unique index.

### B4. Missing Backend API Contracts (H2 Still Open)
**Flagged by:** R8, R7, R4-7 | **Workstream:** All

No routes defined for billing, work items, or auth. Coders will guess at API surface.

**Fix:** Define routes, methods, request/response JSON shapes, error codes for all Round 0 endpoints.

### B5. Go Interface Contracts Undefined
**Flagged by:** R5-4, R5-2, R7, R6-1 | **Workstream:** A1+A4

`CreditService`, `WorkItemService` interfaces don't exist. Credit-gate insertion into 27-dependency streaming service is ambiguous.

**Fix:** Define domain interfaces. Use `MeteredProviderRegistry` decorator pattern for credit gate. Place `CalculateCreditCost` as pure domain function.

### B6. Git Import Has No Security Controls
**Flagged by:** R3-2 | **Workstream:** A3

No SSRF protection, size limits, submodule handling, symlink protection, or binary filtering for user-supplied git URLs.

**Fix:** HTTPS-only, hostname resolution + RFC 1918 blocking, `--depth 1 --no-recurse-submodules`, size caps, text-only filter, symlink rejection.

## HIGH Findings (18 total)

| ID | Finding | Workstream | Fix |
|----|---------|------------|-----|
| H1 | Dual-read has no conflict resolution | A3 | DB remains sole write path in Phase 1 |
| H2 | Expiration cron races with consumption | A1 | FIFO filters `expires_at > NOW()`, atomic cron CTE |
| H3 | credit_balances view reports stale data | A1 | View filters expired lots |
| H4 | Checkout session allows amount manipulation | A1 | Server-side pack_id mapping |
| H5 | No refund handling | A1 | Defer to post-v1, document explicitly |
| H6 | Work items table missing columns | A4 | Add updated_at, deleted_at, user_id, description, metadata |
| H7 | Thread-to-work-item relationship unspecified | A4 | Nullable FK, ON DELETE SET NULL, optional in CreateThread |
| H8 | Artifact folder creation not transactional | A4 | Use TransactionManager pattern |
| H9 | Status state machine undefined | A4 | active->done (complete), done->active (reopen) |
| H10 | YAML frontmatter schema undefined | A3 | Define required/optional fields for SKILL.md and agent .md |
| H11 | Git import needs domain abstraction | A3 | GitFetcher interface in domain |
| H12 | Backfill has no crash recovery | A3 | Idempotent backfill, normalize names, privileged context |
| H13 | Billing failure mode unspecified | A1 | Fail-closed for check, async reconciliation for deduction |
| H14 | Credit gate not at single boundary | A1 | Two levels: middleware admission + step-level in streaming |
| H15 | Reference file migration strategy missing | A3 | Copy (don't move) in Phase 1 |
| H16 | CalculateCreditCost lossy arithmetic | A1 | High-precision integers, ceiling division, domain layer |
| H17 | Slug generation missing constraints | A4 | UNIQUE partial index, 80 char max, immutable |
| H18 | Auth-to-billing invocation path unspecified | A2 | CreditGranter interface, injected via DI |

## Prior Review Resolution Status

| Finding | Status |
|---------|--------|
| H5 (FIFO audit trail) | STILL OPEN |
| H11 (Stripe webhook signature) | STILL OPEN |
| H2 (missing API contracts) | STILL OPEN |
| H4 (billing gate boundary) | PARTIAL |
| H12 (free credit grant timing) | RESOLVED |
| H14 (.agents/ namespace) | RESOLVED |
| C7 (.work/ paths) | RESOLVED |
| M4 (migration consistency) | RESOLVED |
| Fix 4 (JWT exp claim) | RESOLVED |

## Action Plan

### Must-fix before coding (5-7 hours design work)

1. **Interface contracts (B5)** -- Define Go interfaces for CreditService, CreditStore, WorkItemService, WorkItemStore, SkillResolver, CreditGranter. Place in domain/. 1-2 hours.
2. **API routes (B4)** -- Define routes, methods, request/response shapes, error codes for billing, work items, auth endpoints. 1-2 hours.
3. **Stripe webhook security (B2)** -- Add signature verification, webhook secret, session verification to billing design. 30 min.
4. **Signup trigger mechanism (B3)** -- Design frontend-mediated POST /api/auth/initialize with idempotent credit grant. 30 min.
5. **FIFO deduction algorithm (B1)** -- PL/pgSQL function, consumption_group_id, CHECK constraint, concurrent safety. 1-2 hours.
6. **Git import security (B6)** -- HTTPS-only, SSRF protection, size limits, submodule/symlink rejection. 30 min.
7. **YAML frontmatter schema (H10)** -- Required/optional fields for SKILL.md and agent .md frontmatter. 30 min.

### Should-fix before implementation (2-3 hours)

8. Credit gate design (H14) -- middleware admission + step-level metering
9. Work items columns (H6) -- add missing columns to schema
10. Status machine (H9) -- define allowed state transitions
11. Thread-work-item relationship (H7) -- nullable FK spec
12. Dual-read conflict resolution (H1) -- clarify DB is sole write path
13. Billing failure mode (H13) -- fail-closed check, async deduction reconciliation

### Can fix during implementation

14. Artifact atomicity (H8)
15. Slug constraints (H17)
16. Git domain abstraction (H11)
17. Backfill recovery (H12)
18. Reference migration (H15)
19. Cron atomicity (H2)
20. Checkout validation (H4)
21. Refunds (H5) -- defer to post-v1
22. Cost precision (H16)

### Post-fixes readiness

After must-fix items: A1 READY, A2 READY (unchanged), A3 READY, A4 READY.
