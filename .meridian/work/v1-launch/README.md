# v1 Launch

Frontend rebuild + billing + agent infrastructure. Port working patterns from existing frontend, fix what's broken, add what's missing. Desktop-first, components responsive.

## Foundations

Cross-cutting decisions that every feature depends on.

| Doc | Purpose |
|-----|---------|
| [brand.md](foundations/brand.md) | Colors, typography, icons, WCAG |
| [toolchain.md](foundations/toolchain.md) | Vite, React, Tailwind, Storybook, key libraries |
| [data-architecture.md](foundations/data-architecture.md) | Local-first docs, server-auth threads, optimistic flow, IndexedDB split |
| [domain-architecture.md](foundations/domain-architecture.md) | Subdomains, deployment, desktop-first scope |
| [backend-architecture.md](foundations/backend-architecture.md) | Clean arch layers, dependency rule, where concerns live |
| [frontend-architecture.md](foundations/frontend-architecture.md) | Feature modules, Zustand stores, component layers, import rules |

## Feature Map

### Core

| Feature | Design | Status | Notes |
|---------|--------|--------|-------|
| Design system | [features/design-system/](features/design-system/design-system.md) | in progress | Atoms, theme, shared components. Storybook-first. |
| Auth | [features/auth/](features/auth/auth.md) | not started | Supabase Auth (carry forward), free tier guest mode |
| Explorer | [features/explorer/](features/explorer/explorer.md) | not started | File tree, CRUD, drag-and-drop. Hides `.agents/` and `.meridian/`. |
| Editor | [features/editor/](features/editor/) | not started | CM6 live preview, decoration layers, focus mode. Port from existing. |
| Collab | [features/collab/](features/collab/) | not started | Backend done. Port frontend: hunks, suggestions, inline accept/reject. Fix decoration conflicts, undo contract, grouped hunk UX. |
| Threads | [features/threads/](features/threads/threads.md) | not started | CM6 input, streaming via streamdown, tool calls. Fix optimistic send. Server-authoritative. |
| Layouts | [features/layouts/](features/layouts/) | not started | Studio (primary), Converse, Agents shells. Desktop-first, components responsive. |
| Tabs | [features/tabs/](features/tabs/tabs.md) | not started | Multi-tab, hybrid mount (LRU), preview-tab pattern for 100+ chapters. |
| Command palette | [features/command-palette/](features/command-palette/command-palette.md) | not started | Keyboard shortcuts, Cmd+K. Resolve shortcut collisions first. |
| Notifications | [features/notifications/](features/notifications/notifications.md) | not started | Toasts, error surfacing for failed optimistic updates |
| Connectivity | [features/connectivity/](features/connectivity/connectivity.md) | not started | WebSocket reconnect, offline queue, status indicator. Port existing sync. |
| Search | [features/search/](features/search/search.md) | not started | Cross-document, within-project |
| Settings | [features/settings/](features/settings/settings.md) | not started | Theme, editor prefs, per-project settings, agents & skills management |

### Shared Infrastructure

| Feature | Design | Status | Notes |
|---------|--------|--------|-------|
| @mentions | [features/mentions/](features/mentions/mentions.md) | not started | CM6 autocomplete shared across editor + chat. Needs canonical mention entity with stable IDs. Wiki links in editor, @mention chips in chat. |
| CM6 shared extensions | [features/cm6-shared/](features/cm6-shared/cm6-shared.md) | not started | Reusable CM6 plugins. Explicit shared runtime layer, not smeared across features. |
| Optimistic data layer | — | not started | Universal flow (see [data-architecture.md](foundations/data-architecture.md)). Port existing doc patterns, fix threads to match. |

### Platform

| Feature | Design | Status | Notes |
|---------|--------|--------|-------|
| Agents + Skills | [features/agents/](features/agents/file-first-agents-skills.md) | not started | File-first `.agents/` in doc tree, settings UI as view over files, import from git. Replaces DB `project_skills`. |
| Work Items | [features/agents/](features/agents/work-items.md) | not started | Multi-thread work context, shared artifact space. Same model as CLI `meridian work`. |
| Agent Tools | [features/agents/](features/agents/agent-tools.md) | not started | Document-native tools + `just-bash` TS sidecar. Path-based write routing, `$MERIDIAN_WORK_DIR` context. |
| Billing | [features/billing/](features/billing/billing-design.md) | not started | Prepaid credit wallet, Stripe Checkout, per-inference-step billing, credit lots, FIFO consumption. |
| Import / Export | [features/import-export/](features/import-export/import-export.md) | not started | Zip archives, single doc markdown, git import for agents/skills. EPUB deferred. |
| Prose analysis | [features/prose-analysis/](features/prose-analysis/prose-analysis.md) | not started | **Stretch goal.** Client-side: sentence length, passive voice, adverb density. No LLM cost. |
| Onboarding | [features/onboarding/](features/onboarding/onboarding.md) | not started | Free tier flow, sample project, first AI interaction within 2 minutes |

### Future (post-v1)

| Feature | Notes |
|---------|-------|
| Mobile | Mobile layout shells (bottom tab bar, single-pane navigation, bottom sheets). Components are already responsive — this is layout + mobile UX only. |
| Marketplace | Full marketplace with search, ratings. v1 ships "coming soon" placeholder. |
| Writing stats | Session word count, writing streaks, deadline projection. Cut from v1 for timeline. |
| EPUB export | TOC + chapter breaks for reader distribution. Zip export is v1. |
| Full sandboxed runtime | Daytona/E2B for package installs, network, complex pipelines. See [research/](research/). |
| Thread branching | Fork threads into parallel paths within a work item |
| Subagent spawning | LLM-initiated thread creation |
| Compaction | Long thread summarization |
| Agent planning mode | Pre-execution plan review |
| Backlinks | "What references this doc?" panel |
| Publishing stats | Royal Road API integration |
| Named snapshots | Named checkpoints before major revision passes |
| Full marketing site | Expanded landing page, testimonials, feature tours |

## Research

| Doc | Topic |
|-----|-------|
| [research/payment-strategy.md](research/payment-strategy.md) | PAYG vs subscription vs hybrid, competitor pricing, Stripe patterns |
| [research/daytona.md](research/daytona.md) | Daytona sandbox platform evaluation |
| [research/vercel-sandbox.md](research/vercel-sandbox.md) | Vercel Sandbox + just-bash evaluation |

## Reference (prior art / post-v1)

| Doc | Topic |
|-----|-------|
| [reference/agent-framework.md](reference/agent-framework.md) | Full agent framework design (post-v1) |
| [reference/artifact-templates.md](reference/artifact-templates.md) | Template → Instance pattern |
| [reference/skills-packaging.md](reference/skills-packaging.md) | Skills v1.5 packaging (superseded by file-first design) |
| [reference/marketplace-unification.md](reference/marketplace-unification.md) | CLI ↔ Flow marketplace convergence |

## Reviews

10 reviews completed (7 GPT-5.4, 3 Opus). Reports stored in spawn artifacts — use `meridian spawn show <id>` to read.

| Spawn | Focus | Model |
|-------|-------|-------|
| p66 | Billing design | GPT-5.4 |
| p67 | Architecture + billing integration | Opus |
| p68 | Editor + collab + CM6 | GPT-5.4 |
| p69 | Layouts + UX | GPT-5.4 |
| p70 | Agents + marketplace | GPT-5.4 |
| p71 | Scope + feasibility | Opus |
| p72 | Product direction | Opus |
| p73 | Frontend data layer | GPT-5.4 |
| p74 | Frontend DX + toolchain | GPT-5.4 |
| p75 | Accessibility + mobile | GPT-5.4 |

Key themes:
- **Billing:** atomic credit reservation (critical), credit lots, webhook idempotency, multi-round billing
- **Editor/Collab:** decoration conflicts, undo contract drift, grouped hunk UX, large-doc performance
- **Layouts:** Converse context should be thread-scoped, multi-thread navigation contract missing
- **Data:** threads must be server-authoritative, LRU must evict full doc session
- **Accessibility:** jade-teal fails WCAG for text, keyboard shortcut collisions
- **Product:** "Skills are your Salesforce" — user-created configuration is the moat
