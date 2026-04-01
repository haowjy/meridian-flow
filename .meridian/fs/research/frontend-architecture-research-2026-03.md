# Frontend Architecture Research (React 19, 2025-era patterns)

Date: 2026-03-19
Scope: complex writing platform (CM6 editor, Yjs collaboration, SSE AI chat, multi-panel UI, Zustand, Dexie, Storybook, Tailwind v4)

## Executive recommendation

For this stack, the best-fit architecture is:

1. **Feature modules with strict boundaries** (Bulletproof-style), optionally using **FSD rules** where they help (especially import discipline and page-first decomposition).
2. **Split state by domain type**:
   - CM6 internal editor state for text/view mechanics
   - Yjs for collaborative document truth
   - Zustand (vanilla stores + slices) for app/UI/workspace state
   - TanStack Query (or TanStack DB, if you want deeper local-first reactivity) for server-cache/non-CRDT entities
   - Dexie for persistence/outbox/local projections
3. **Optimistic writes by default**, but with separate strategies for CRDT vs server-authoritative entities.
4. **CM6 extensions organized as capability packages** (base + feature extension bundles), with explicit boundaries between editor plugin code and app stores.
5. **Storybook-first component development plus browser integration testing** for collab/streaming/editor behaviors.

---

## 1) Feature-Sliced architecture vs feature modules

## What the current docs and ecosystem show

- **Feature-Sliced Design (FSD) moved to “pages-first” in v2.1 (Nov 2025)**, explicitly recommending keeping more logic in page/widget slices unless reuse is proven.
- FSD still enforces strong dependency semantics (layer import rule; public APIs; explicit cross-import notation for entities).
- **Bulletproof React** continues to represent the practical “industry default” in many teams: feature folders, avoid cross-feature imports, compose features at app/page level, and enforce with lint rules.

## Practical read

- Pure FSD can be excellent when teams deeply adopt its semantics.
- In many production teams, **feature modules + explicit dependency rules** are adopted faster and with less ceremony.
- 2025 FSD “pages-first” reduces one of the biggest adoption pain points (over-slicing too early).

## Recommendation

- Use **feature modules as the baseline structure**.
- Apply **FSD-inspired constraints** where high leverage:
  - explicit public APIs
  - layer direction/import rules
  - page-first decomposition
- Avoid forcing every concept into `entities/features/widgets` on day 1.

## What goes wrong in practice

- Over-slicing early increases navigation cost and slows onboarding.
- Underspecified boundaries lead to cross-feature imports and architecture drift.
- Barrel misuse can create circular imports and bundling penalties.

---

## 2) State management patterns for complex editors

## Observed patterns

- CM6 is intentionally **functional core + imperative shell**:
  - immutable `EditorState`
  - imperative `EditorView`
  - extension-based state/effects
- Zustand docs emphasize:
  - slices pattern for modular stores
  - `createStore` vanilla stores for DI and context boundaries
  - fine-grained subscriptions (`subscribeWithSelector`)
- Jotai docs emphasize:
  - atom-level granularity for render control
  - `createStore` for non-React/outside-React interactions

## Practical boundary for rich editors

Use a **hard boundary** between:

- **Editor engine state**: selection, decorations, transactions, undo semantics, collab plugin state (CM6/Yjs)
- **Application state**: panel layout, selected document, filters, command palette, AI thread list, connection status, job queues

## Recommendation

- Keep CM6 internals in extension/plugin code; do not mirror every cursor/decor state into Zustand.
- Expose editor state to app via **derived adapters/events** only (minimal projection).
- Use Zustand for UI/workbench orchestration; Dexie for persistence; Yjs for collaborative doc content.

## What goes wrong in practice

- Duplicating editor state in global store causes desync and perf regressions.
- Treating global store as a “single source of truth” for text editor internals breaks CM6 transaction semantics.

---

## 3) Optimistic update patterns

## Current best-practice anchors

- TanStack Query recommends two optimistic strategies:
  - UI-level optimistic rendering via mutation `variables`
  - cache-level optimistic updates via `onMutate` + rollback snapshot
- TanStack Query persister docs explicitly warn:
  - `setQueryData` optimistic updates are not persisted unless you persist explicitly.
- Replicache and local-first systems push optimistic-first UX by taking server round-trip off critical path, then syncing in background.

## Recommendation

- Use **dual optimistic model**:
  - **CRDT domain (document content)**: optimistic by CRDT definition (Yjs), reconcile via merge.
  - **Server-authoritative domain (metadata, permissions, counters)**: mutation queue + rollback or reconcile logic.
- For React Query:
  - standardize `onMutate` / `onError` / `onSettled` contracts
  - persist critical optimistic state if offline/refresh continuity matters

## What goes wrong in practice

- Treating all entities as equally optimistic-safe causes integrity bugs (especially permissions/workflow states).
- Refresh while optimistic leads to apparent data loss if persistence path is missing.

---

## 4) CM6 extension architecture at scale

## What large deployments/documentation show

- CM6 architecture is explicitly modular and extension-driven.
- Official collab example demonstrates a **peer plugin** that manages push/pull loops and version sync.
- CM6 decoration guidance emphasizes state fields/view plugins and viewport-aware decoration sources.
- `y-codemirror.next` separates collaboration concerns (`yCollab`, awareness, undo manager).
- Product examples:
  - Overleaf publicly notes migration to CM6 to accelerate future editor features.
  - Replit’s “Betting on CodeMirror” documents why editor architecture choice is foundational.
  - CodeSandbox Sandpack emphasizes provider/hooks/composable architecture around editor runtime.

## Recommendation

Structure CM6 code as:

- `editor/core`: base setup, common commands, themes, shared utilities
- `editor/extensions/<capability>`: each capability exports an extension factory
- `editor/collab`: Yjs wiring + awareness + persistence
- `editor/bridge`: app-level adapters/events only

## What goes wrong in practice

- Giant monolithic extension arrays become untestable and order-sensitive.
- Mixing app business logic directly inside CM6 plugins makes both brittle.

---

## 5) Real-time + local-first data layer (Yjs + server authority)

## Strong signals from current systems

- Yjs model: shared types + pluggable network providers + `y-indexeddb` offline persistence.
- Notion offline architecture (Dec 2025):
  - explicit offline availability model
  - robust local storage invariants
  - push-based page updates and reconnect catch-up
  - CRDT migration for predictable conflict resolution
- Replicache model: local mutators, push/pull sync, poke notifications, canonical server datastore.
- Electric + TanStack DB trends: reactive client-first stores with sync pipelines.

## Recommended sync-engine pattern

- **Two data planes**:
  - collaborative document plane (Yjs CRDT)
  - server-authoritative entity plane (API + cache + durable local projection)
- **Sync coordinator**:
  - connection state
  - retry/backoff
  - per-entity conflict strategy
  - hydration ordering guarantees
- **Durable local persistence** (Dexie) for:
  - document metadata projections
  - mutation outbox
  - AI thread/event logs

## What goes wrong in practice

- One-size-fits-all sync model across CRDT and non-CRDT entities causes complexity and correctness issues.
- Missing explicit “why is this local/offline” metadata leads to cache drift and hard-to-debug offline behavior.

---

## 6) Service layer patterns in React

## Current trend

- Modern React apps still commonly keep an explicit **API/service layer**; they do not rely on component-level fetches alone.
- Bulletproof React pattern remains practical:
  - single API client instance
  - request declarations per endpoint/feature
  - hooks on top (Query/SWR/etc.)

## Recommendation

- Keep a **thin service layer** between UI and transport.
- Co-locate feature-specific request modules in feature folders unless shared heavily.
- Keep domain mapping/validation in service boundary, not in components.

## What goes wrong in practice

- Hook-only API logic without shared request contracts causes duplicated retry/auth/error behavior.
- Fat “god services” become another monolith; keep services feature-scoped with shared infra primitives.

---

## 7) Import/dependency rules for large codebases

## Mature options

- FSD import rule (layer direction + public APIs)
- Nx `@nx/enforce-module-boundaries` with tag-based constraints and allow/deny patterns
- `eslint-plugin-boundaries` for architecture-aware linting in JS/TS
- `import/no-restricted-paths` for direct zone restrictions

## Recommendation

- Use **Nx tag constraints** (or equivalent) as the primary guardrail.
- Add focused ESLint rules for local restrictions and exceptions.
- Enforce public API imports only (no deep internal imports across modules).

## What goes wrong in practice

- Boundary rules without automated lint checks fail quickly.
- Too many ad-hoc exceptions erode architecture guarantees; exception policy needs ownership.

---

## 8) Testing strategy for editor + streaming + collaboration

## Current practice signals

- Storybook now positions stories as executable component tests, with Vitest addon as primary path.
- Storybook documents interaction tests (`play` function), CI integration, and browser-backed execution.
- Storybook test-runner exists but is now documented as superseded by Vitest addon for Vite projects.

## Recommendation (test pyramid for this stack)

1. **Unit tests**
   - CM6 extension logic (transaction transforms, state fields)
   - sync reducers/conflict policies
   - optimistic mutation reducers
2. **Integration tests**
   - editor + collab plugin wiring
   - AI streaming parser/renderer (chunking, cancellations, reconnect)
3. **Browser E2E (Playwright)**
   - multi-peer collab scenarios
   - offline/online transitions
   - multi-panel workflow with long sessions
4. **Storybook tests**
   - component behavior and interaction contracts
   - visual and accessibility checks in CI

## What goes wrong in practice

- Snapshot-heavy testing misses collaborative race conditions.
- Single-client tests miss ordering bugs in real-time flows.

---

## Suggested target architecture for your app

- **Structure**: feature modules + strict import boundaries (+ optional FSD semantics)
- **State**:
  - CM6/Yjs for editor-collab core
  - Zustand slices for workbench/app state
  - Dexie for persistence and outbox
  - TanStack Query for server cache (or TanStack DB if you want stronger reactive local-first model)
- **Data flow**:
  - command/mutation layer for writes
  - optimistic-first UX with explicit rollback/reconcile paths
- **Testing**:
  - Storybook-first component verification
  - browser-level multi-peer and offline tests

---

## Sources

- FSD releases and docs:
  - https://github.com/feature-sliced/documentation/releases
  - https://raw.githubusercontent.com/feature-sliced/documentation/main/src/content/docs/docs/reference/layers.mdx
  - https://raw.githubusercontent.com/feature-sliced/documentation/main/src/content/docs/docs/reference/public-api.mdx
  - https://raw.githubusercontent.com/feature-sliced/documentation/main/src/content/docs/docs/guides/migration/from-v2-0.mdx
  - https://raw.githubusercontent.com/feature-sliced/documentation/main/src/content/docs/docs/guides/issues/cross-imports.mdx
- Bulletproof React:
  - https://github.com/alan2207/bulletproof-react
  - https://raw.githubusercontent.com/alan2207/bulletproof-react/master/docs/project-structure.md
  - https://raw.githubusercontent.com/alan2207/bulletproof-react/master/docs/api-layer.md
  - https://raw.githubusercontent.com/alan2207/bulletproof-react/master/docs/state-management.md
  - https://raw.githubusercontent.com/alan2207/bulletproof-react/master/docs/testing.md
- Zustand / Jotai:
  - https://raw.githubusercontent.com/pmndrs/zustand/main/docs/learn/guides/slices-pattern.md
  - https://raw.githubusercontent.com/pmndrs/zustand/main/docs/learn/guides/initialize-state-with-props.md
  - https://raw.githubusercontent.com/pmndrs/zustand/main/docs/reference/apis/create-store.md
  - https://raw.githubusercontent.com/pmndrs/zustand/main/docs/reference/middlewares/subscribe-with-selector.md
  - https://raw.githubusercontent.com/pmndrs/jotai/main/docs/core/store.mdx
  - https://raw.githubusercontent.com/pmndrs/jotai/main/docs/guides/performance.mdx
  - https://raw.githubusercontent.com/pmndrs/jotai/main/docs/guides/using-store-outside-react.mdx
- TanStack Query / DB:
  - https://raw.githubusercontent.com/TanStack/query/main/docs/framework/react/guides/optimistic-updates.md
  - https://raw.githubusercontent.com/TanStack/query/main/docs/framework/react/plugins/createPersister.md
  - https://tanstack.com/db/latest
  - https://raw.githubusercontent.com/TanStack/query/main/examples/react/chat/src/chat.ts
- CodeMirror:
  - https://raw.githubusercontent.com/codemirror/website/main/site/docs/guide/index.md
  - https://raw.githubusercontent.com/codemirror/website/main/site/examples/collab/index.md
  - https://raw.githubusercontent.com/codemirror/website/main/site/examples/collab/collab.ts
  - https://raw.githubusercontent.com/codemirror/website/main/site/examples/collab/worker.ts
  - https://raw.githubusercontent.com/codemirror/website/main/site/examples/decoration/index.md
- Yjs:
  - https://docs.yjs.dev/getting-started/a-collaborative-editor
  - https://docs.yjs.dev/getting-started/allowing-offline-editing
  - https://raw.githubusercontent.com/yjs/y-codemirror.next/master/README.md
- Local-first / sync engines:
  - https://doc.replicache.dev/concepts/how-it-works
  - https://electric-sql.com/docs/intro
  - https://linear.app/now/scaling-the-linear-sync-engine
  - https://app-2025.localfirstconf.com/schedule/talks-day-1/linear
  - https://www.notion.com/en-gb/blog/how-we-made-notion-available-offline
- Editor product references:
  - https://blog.replit.com/codemirror
  - https://www.overleaf.com/blog/towards-the-future-a-new-source-editor
  - https://sandpack.codesandbox.io/
- Boundaries tooling:
  - https://raw.githubusercontent.com/nrwl/nx/master/astro-docs/src/content/docs/features/enforce-module-boundaries.mdoc
  - https://raw.githubusercontent.com/nrwl/nx/master/astro-docs/src/content/docs/technologies/eslint/eslint-plugin/Guides/enforce-module-boundaries.mdoc
  - https://raw.githubusercontent.com/javierbrea/eslint-plugin-boundaries/master/README.md
  - https://raw.githubusercontent.com/import-js/eslint-plugin-import/main/docs/rules/no-restricted-paths.md
- Storybook testing:
  - https://raw.githubusercontent.com/storybookjs/storybook/main/docs/writing-tests/index.mdx
  - https://raw.githubusercontent.com/storybookjs/storybook/main/docs/writing-tests/interaction-testing.mdx
  - https://raw.githubusercontent.com/storybookjs/storybook/main/docs/writing-tests/integrations/test-runner.mdx
