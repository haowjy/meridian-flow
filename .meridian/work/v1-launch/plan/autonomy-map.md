# Autonomy Map: What Needs Human Input vs What Doesn't

## Fully Autonomous (concrete verification, no human input needed)

These have clear acceptance criteria — tests pass, API works, migration succeeds. Can be spawned and verified without human review.

### Backend

| Feature | What gets built | Verification |
|---------|----------------|--------------|
| **A1. Billing Backend** | Credit ledger, Stripe webhook, credit-check middleware (check-per-inference-step, no reservations), FIFO lots | Unit tests for atomicity, FIFO ordering, idempotency. Smoke test: Stripe test mode purchase -> credits appear. |
| **A2. Auth Backend** | Free tier grant endpoint, JWKS validation | Signup -> credits granted. JWT validates. |
| **A3. Agents+Skills Backend** | Skill resolver from doc tree, `.agents/` filter, git import endpoint, migration | Skill resolves from file. Explorer API hides `.agents/`. Git import creates documents. Migration preserves data. |
| **A4. Work Items Backend** | DB schema, CRUD API, artifact space, archive/reopen | Full CRUD. Thread grouping. Artifact folder created. Archive makes read-only. |
| **A5. Agent Tools Backend** | Write routing, context variable injection, permission boundaries | Write to doc -> Yjs. Write to `.meridian/work/` -> direct. Write to `.agents/` -> 403. Variables resolve. |
| **A5b. just-bash Sidecar** | TS sidecar, virtual FS mount, internal API | `cat file.md` returns content. `echo > file.md` creates document. No network/package escape. |

### Frontend Infrastructure

| Feature | What gets built | Verification |
|---------|----------------|--------------|
| **C1. Data Layer** | Optimistic flow, Dexie schema, sync service ports | Optimistic render < 16ms. Queue drains on reconnect. Dexie persists across reload. |
| **F1. CM6 Primitives** | Theme, keybindings only (narrowed scope -- markdown decorations owned by Editor F4, mention autocomplete by @Mentions F8) | CM6 renders with theme tokens. Keybindings fire. |
| **F3. Connectivity** | WebSocket manager, offline queue, SSE resilience | Reconnect after drop. Queue drains. Last-Event-ID resumes. |

### Frontend Logic (no UI judgment needed)

| Feature | What gets built | Verification |
|---------|----------------|--------------|
| **F8. @Mentions (data layer)** | Mention entity schema, stable IDs, rename handling, fuzzy search | Mention survives rename. Fuzzy matches. Cross-surface paste preserves. |
| **F18. Prose Analysis (engine)** | Sentence length, passive voice, adverb density, readability algorithms | Correct detection rates on sample texts. No false positives on dialogue. |
| **F17. Writing Stats (computation)** | ~~Cut from v1 scope~~ -- see writing-stats.md | N/A |

**Total: ~15 workstreams that can run fully autonomously.**

## Needs Your Input (UI/UX decisions, visual review)

These involve design judgment — layout, aesthetics, interaction feel, copy. I can build initial Storybook mocks, but you need to review and iterate before integration.

### Design Foundation

| Feature | What needs input | How we work |
|---------|-----------------|-------------|
| **B1. Design System atoms** | Visual appearance of every atom (button states, input variants, dialog sizing, toast positioning, dark mode) | I build Storybook stories -> you review in browser -> we iterate. This gates everything. |
| **Brand: accent-text color** | Exact darker teal that passes WCAG AA but still feels "Meridian" | I propose 3-4 candidates with contrast ratios -> you pick. |
| **Keyboard shortcut resolution** | Who owns Cmd+1/2/3? Tab selection vs layout mode vs headings. | I lay out the collision matrix -> you decide the policy. |

### Core UI

| Feature | What needs input | How we work |
|---------|-----------------|-------------|
| **F4. Editor** | Live preview feel (cursor proximity distance, decoration transitions, toolbar position), block rendering appearance | Storybook stories with different configs -> you try them -> we pick. |
| **F5. Explorer** | Tree component look, context menu items, word count placement | Storybook -> review. Mostly follow existing conventions. |
| **F6. Tabs** | Tab strip visual design, preview tab indicator, overflow behavior | Storybook -> review. |
| **F7. Threads** | Message bubble design, streaming indicator, tool call blocks, chat input height/behavior | Storybook with mock messages -> review. This is a key UX surface. |
| **F10. Collab** | Hunk decoration colors, accept/reject toolbar placement, grouped actions UX | Storybook MockCollab stories -> review in editor context. |
| **F11. Layouts** | Studio/Converse/Agents shell proportions, rail icon design, panel collapse transitions, mode switch feel | Most judgment-heavy feature. Storybook for individual panels -> full layout prototype -> iterate. |
| **F12. Settings** | Settings page layout, agents/skills card design, git import flow UX | Storybook panels -> review. |
| **F13. Work Items** | Dashboard layout, thread list design, artifact browser | Storybook -> review. New feature, no existing patterns. |
| **F14. Billing** | Purchase flow modal, balance display, usage history table, cost estimate popover | Storybook -> review. Revenue-critical UX. |
| **F15. Command Palette** | Palette visual design, result ranking, action grouping | Storybook -> review. |
| **F20. Onboarding** | Wizard flow, tooltip content/placement, sample project content, "Meridian Moment" design | Most human-dependent feature. Every step needs your sign-off. |
| **F21. Landing Page** | Everything — copy, layout, screenshots, CTA | Full design input needed. |

## Recommended Workflow

```
Phase 1: You're NOT needed (backend + infra)
├── I spawn backend coders for A1-A5
├── I spawn frontend infra for C1, F1, F3
├── Concrete tests verify everything
└── You can do other things

Phase 2: Storybook review sessions (design system + core components)
├── I build B1 atoms in Storybook
├── You open Storybook, review, leave feedback
├── We iterate 2-3 rounds per component group
└── This unlocks all feature UI work

Phase 3: Parallel — autonomous backend + human-reviewed frontend
├── Backend features continue autonomously (A3, A4, A5)
├── Frontend features build Storybook stories -> you review periodically
├── I integrate approved components
└── You do batch reviews (not per-component)

Phase 4: Integration review
├── Full layouts composed from approved components
├── You test real flows in dev environment
├── We fix integration issues
└── Polish round

Phase 5: Onboarding + Landing (most human-dependent)
├── Every step needs your eyes
└── Last because everything else must work first
```

## How Reviews Work

For Storybook reviews, I'll deploy Storybook and give you a URL. You browse component stories and tell me what to change. Batch feedback is fine — you don't need to review every component individually.

For integration reviews, I'll set up the dev environment and you'll test real flows. This is where layout proportions, interaction timing, and "feel" get dialed in.

For backend work, you don't need to review unless something architectural changes. I'll verify with tests and report results.
