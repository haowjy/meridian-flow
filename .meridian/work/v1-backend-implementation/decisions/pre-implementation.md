# Pre-Implementation Decisions

Decisions made during design review, before implementation begins.

### D-0-1: Defer background execution to post-v1

**Context**: Background execution requires `background_tasks` table, goroutine manager, restart recovery, ThreadNotifier, internal turn role, WebSocket events, and `check_background` tool — ~10 steps.

**Decision**: Defer entirely. Ship foreground-only spawning.

**Alternatives**: Build both foreground + background in v1.

**Rationale**: Foreground spawning covers the core orchestrator pattern (spawn coder, wait, use result). No real users need concurrent agents yet. All background infrastructure is additive — doesn't require rewriting foreground code.

**Review later?**: Yes — when users report needing concurrent agent work, or when agent tasks regularly exceed the 5-min spawn timeout.

---

### D-0-2: Defer provider middleware to post-v1

**Context**: Generic ProviderMiddleware + WrapProvider + usage metering designed for meridian-llm-go. Zero v1 functionality — billing settlement already works via direct integration.

**Decision**: Defer. Keep direct billing integration.

**Alternatives**: Ship middleware now as infrastructure investment.

**Rationale**: Adds code with no user-facing value. The architecture reviewer also found that WrapProvider silently breaks hard cancel (optional interface assertion fails on wrapped provider). Better to fix this in the design before implementing.

**Review later?**: Yes — when adding logging, rate limiting, caching, or guardrails middleware. Or when migrating billing to middleware-based approach.

---

### D-0-3: Simplify SSRF to allowlist-only

**Context**: Full DNS-pinning SSRF protection has IPv4-mapped IPv6 bypass, git CLI pinning gap, and clone-size streaming gap. Complex to implement correctly.

**Decision**: Allowlist-only (`github.com`, `gitlab.com`, `bitbucket.org`). Validate HTTPS + hostname. ~15 lines instead of 150+.

**Alternatives**: Build full DNS-pinning protection now.

**Rationale**: No real users. Only admins trigger imports. Avoids shipping subtly broken security code. Full protection is a pre-launch gate.

**Review later?**: Yes — **mandatory before opening agent import to external users**. This is a hard pre-launch gate.

---

### D-0-4: File-only after backfill (drop dual-read)

**Context**: Dual-read bridge (file-first, DB-fallback) exists to avoid breaking existing data during migration. But CLAUDE.md says "No real users. No backwards compatibility needed."

**Decision**: Run backfill at deployment, validate parity, drop `project_skills` table. One write path (files only).

**Alternatives**: Keep dual-read bridge for gradual migration.

**Rationale**: No data to protect. Dual-read adds ~3-4 steps of bridge complexity (shadow refresh, slug reservation for invalid files, eventual bridge removal).

**Review later?**: No — this is a one-way door that simplifies permanently.

---

### D-0-5: Tiktoken-only token estimation

**Context**: Design had 3-level fallback (Anthropic API, tiktoken, heuristic) with caching. Anthropic API has cost amplification risk and adds network round-trips.

**Decision**: Tiktoken-only using `tiktoken-go` with `cl100k_base`. No API calls, no registry, no caching.

**Alternatives**: Full estimator registry with provider-specific APIs.

**Rationale**: 5% variance is fine for autocollapse (60%) and autocompact (80%) thresholds. Triggering at 57% vs 63% has no user-visible difference. We bill on actual usage from provider response, not estimates.

**Review later?**: Yes — when pre-action cost estimates need higher accuracy, or when billing moves to pre-estimate-based pricing.

---

### D-0-6: Decompose turn_creation.go during R1

**Context**: turn_creation.go is 929 lines. Adding persona, work items, and spawning would push it to ~1300L. Architecture reviewer recommended extracting during R1 while already restructuring.

**Decision**: R1 extracts 4-stage pipeline: `gatherContext -> assemblePrompt -> persistTurns -> launchStream`. Each stage is a method on `turnPipeline` struct. `CreateTurn` becomes the orchestrator.

**Alternatives**: Add features to the monolithic function, refactor later.

**Rationale**: Cheapest to extract now while R1 is already restructuring for cold-start reorder. Every subsequent step (P2, SP1) becomes easier with smaller, focused stages.

**Review later?**: No — this is strictly better.

---

### D-0-7: Keep both collapse and compact

**Context**: Simplification reviewer suggested compact-only (skip collapse). Saves ~2-3 steps.

**Decision**: Keep both. `collapsed_content` is pre-computed at tool execution time (near-zero marginal cost). Collapse is much cheaper than compact at runtime (no LLM call).

**Alternatives**: Compact-only, add collapse later.

**Rationale**: The escalation order (collapse first, compact if insufficient) saves LLM costs. The implementation cost of collapse is minimal — it's a column + a marker turn + a MessageBuilder check.

**Review later?**: No.
