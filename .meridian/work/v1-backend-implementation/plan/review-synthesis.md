# Review Synthesis: v1 Backend Implementation

5 reviewers completed. 44 total findings. This document synthesizes across all reviews, groups by decision needed, and recommends action.

## Reviewers

| Reviewer | Model | Focus | Findings |
|----------|-------|-------|:--------:|
| Dependency | opus | Ordering, feasibility, critical path | 8 |
| Security | opus | SSRF, path traversal, data integrity | 11 |
| Architecture | sonnet | Clean arch, SOLID, package design | 10 |
| Completeness | opus | Missing pieces, integration gaps | 15 |
| Simplification | sonnet | Over-engineering, deferral opportunities | 10 |

## Decisions Needed

### Decision 1: Defer Background Execution + ThreadNotifier + Provider Middleware?

**Supporting evidence:**
- Simplification reviewer: "Foreground spawning covers v1 needs" (★★★★★ confidence). Saves ~10-12 steps.
- Simplification reviewer: "Provider middleware adds zero v1 functionality" (★★★★★). Saves ~8-10 steps.
- Dependency reviewer: "Defer BG + TN cuts 2 nodes from critical path tail" — reduces 9 rounds to ~7.
- Completeness reviewer: BG needs graceful shutdown design (#2), check_background tool (#6), WebSocket channel (#7) — all undesigned.
- Architecture reviewer: spawn.go inside streaming is ok short-term but establish extraction boundary.

**Against:**
- Context management auto-triggers use ThreadNotifier for "approaching context limit" warning.
- Background spawning enables concurrent agent work.

**Recommendation**: **DEFER all three.** Replace ThreadNotifier context warnings with plain SSE events. Foreground spawning is sufficient for v1. Saves ~20 steps, cuts plan from 9 rounds to ~6.

### Decision 2: Simplify SSRF to Allowlist-Only?

**Supporting evidence:**
- Simplification reviewer: Saves ~3-4 steps, ★★★★☆ confidence. "No real users, only admins trigger imports."
- Security reviewer: Full SSRF protection has IPv4-mapped IPv6 gap (#1), git CLI pinning gap (#2), clone size streaming gap (#10).

**Against:**
- Creates a hard pre-launch gate — must add full protection before opening to external users.

**Recommendation**: **SIMPLIFY for v1.** Allowlist `[github.com, gitlab.com, bitbucket.org]`. Add full DNS-pinning SSRF protection as a pre-launch gate. Avoids shipping subtly broken security code.

### Decision 3: File-Only After Backfill (Drop Dual-Read)?

**Supporting evidence:**
- Simplification reviewer: "No real users, no data to protect." Saves ~3-4 steps.
- CLAUDE.md: "No backwards compatibility needed. Schema can change freely."

**Against:**
- If backfill fails for some skills, they're lost. But: "idempotent completion tracking handles this."

**Recommendation**: **SIMPLIFY.** Run backfill at deployment, validate parity, drop `project_skills` table. One write path.

### Decision 4: Tiktoken-Only Token Estimation?

**Supporting evidence:**
- Simplification reviewer: 5% variance is fine for 60%/80% thresholds. Saves ~4-5 steps.
- Security reviewer: Anthropic count_tokens API has cost amplification risk (#5).

**Against:**
- Less accurate for billing pre-estimates (but we bill on actual, not estimates).

**Recommendation**: **SIMPLIFY.** Tiktoken-only for v1. No API calls, no caching, no registry. Add Anthropic estimator later as opt-in optimization.

### Decision 5: Compact-Only Context Management (Skip Collapse)?

**Supporting evidence:**
- Simplification reviewer: Saves ~2-3 steps. "Threads reach compaction sooner, not incorrectly."

**Against:**
- Collapse is much cheaper than compact (no LLM call). Without it, we jump straight to LLM summarization.
- `collapsed_content` is pre-computed at tool time (near-zero marginal cost).

**Recommendation**: **KEEP BOTH.** The collapsed_content pre-computation (CM1) is trivial — it's just storing a string at tool execution time. The collapse bookmark is a simple marker turn. The real savings come from deferring background/middleware, not from gutting context management.

### Decision 6: Decompose turn_creation.go During R1?

**Supporting evidence:**
- Architecture reviewer: "Already 929 lines, will reach ~1300L. Extract 4-stage pipeline now while restructuring."
- All reviewers agree R1 is the highest-risk step.

**Against:**
- Adds scope to the already-critical R1 step.

**Recommendation**: **YES, decompose.** R1 is already restructuring CreateTurn. Extracting into `gatherContext → assemblePrompt → persistTurns → launchStream` stages is cheapest now. Makes all subsequent steps (P2, SP1) much easier.

## Blocking Fixes (Must Address in Design)

These must be resolved before implementation starts:

| # | Source | Finding | Action |
|---|--------|---------|--------|
| S1 | Security | IPv4-mapped IPv6 SSRF bypass | Moot if we go allowlist-only for v1. Document for full SSRF implementation later. |
| S3 | Security | TextEditor path traversal via `..` | **Fix design**: mandate canonicalize → namespace detect → isolation check. Add to A5b verification criteria. |
| S6 | Security | Unbounded ephemeral work items | **Fix design**: per-project cap (100 active ephemerals). Add to A4b. |
| A1 | Architecture | WrapProvider breaks hard cancel | **Moot if middleware deferred.** Document for later. |
| A2 | Architecture | PromptContext couples domain/llm → domain/agents | **Fix design**: pass `PersonaBody *string`, not full Persona struct. |
| A3 | Architecture | turn_creation.go decomposition | **Expand R1 scope** to include 4-stage pipeline extraction. |
| A4 | Architecture | WorkItemStore.ListThreads returns llm.Thread | **Fix design**: return workitem-local DTO. |
| C1 | Completeness | Missing billing settlement integration contract | **Moot if middleware deferred.** |
| C2 | Completeness | No graceful shutdown for streaming + spawning | **Add design** for shutdown lifecycle. Required for deploy safety. |
| C3 | Completeness | No structured error codes | **Add error code registry** to domain/errors. |
| C4 | Completeness | Foreground spawn timeout unspecified | **Fix design**: add `spawn_timeout` (5 min default) with `context.WithTimeout`. |

## Should-Fix During Implementation

| # | Source | Finding | When |
|---|--------|---------|------|
| S4 | Security | just-bash isolation | When A5 is implemented |
| S7 | Security | Persona model validation | When P1 is implemented |
| S8 | Security | Spawn depth denormalization | When SP1 is implemented |
| C5 | Completeness | query_history tool design | When CM3 is implemented |
| C8 | Completeness | Concurrent spawn artifact writes | Document as known limitation |
| C10 | Completeness | Thread table naming inconsistency | Fix in design docs now |
| C11 | Completeness | Rate limits on expensive endpoints | Add per-endpoint limits |
| Simp-Bonus | Simplification | Prompt position spec inconsistency | Fix before R2 |

## Updated Plan Shape (Post-Simplification)

If decisions 1-4 are accepted:

| Round | Steps | What |
|:-----:|:-----:|------|
| **1** | R1, R2, R3, A3a | Base refactors (R1 now includes pipeline decomposition) + `.agents/` bootstrap |
| **2** | A4a, A4b, A3b, TB1 | Work items + skill resolver + tiktoken estimator |
| **3** | SM*, AI1*, A5a, A5b | Skill migration (file-only) + git import (allowlist) + agent tools |
| **4** | P1, CM1 | Persona catalog + collapsed_content |
| **5** | P2, P3, P4, P5 | Persona integration (sequential) |
| **6** | CM2, CM3, CM4, TB2, SP1, SP2 | Context management + spawn foundation |
| **7** | SP3, SP4, SP5 | Spawn completion |

**~24 steps across 7 rounds** (down from 34 steps across 9 rounds).

Steps removed:
- PM1, PM2 (provider middleware) — deferred
- BG1, BG2 (background execution) — deferred
- TN1, TN2 (thread notifications) — deferred
- SM simplified (no dual-read bridge)
- AI1 simplified (allowlist, no DNS pinning)
- TB1 simplified (tiktoken only, no registry)

Steps added:
- R1 expanded (pipeline decomposition)
- Graceful shutdown design (new step, attach to Round 1 or 2)
- Error code registry (attach to Round 1)
