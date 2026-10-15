# @meridian/app

Authenticated writing workspace. This is a thin React/TanStack Start shell over
client contracts, stores, and server-owned runtime behavior; business logic stays
in packages or server domains.

## Rules that shape the shell

- Use Portless HTTPS routes for browser and end-to-end work; never hard-code raw
  dev ports. Keep writer-facing vocabulary: projects, Works, chapters, context,
  threads, agents, and turns.
- Components do not own provider/database logic. Use public client APIs and
  query/store seams. Server auth is WorkOS AuthKit; do not add an app-local auth
  adapter.
- Preserve TipTap/Yjs document-session boundaries and the local-first contract:
  local content and continuity paint first, while inherently-online AI, billing,
  and auth fail honestly. A chat submission witness is not a thread replica.
  Works and threads have no offline contract yet. New persistent state picks a
  tier (content, continuity, workbench, preference, or cache) before it ships.
- Navigate first once a public address exists. Persist and connect in the
  background, and show failure on the destination rather than bouncing back. A
  server-assigned public address stays P0 until a real neutral pending
  destination exists; never mount a fabricated route just to navigate early.
- Define command authority, immediate state, rejection/ambiguity behavior,
  overlap and account fences, and reload promise before wiring mutations. Use
  TanStack Query for transient commands; no Meridian mutation wrapper, global
  optimistic store, or universal rollback rule. Command records that outlive
  their caller, stack per entity, or share one failure across surfaces belong in
  an explicit per-domain record store (as Work commands do), not the mutation
  cache.
- `/_authenticated` mounts one unconditional provider tree; never gate
  providers by pathname. Settings is the routed `?settings=` overlay. Account
  settings and working-set sync have one account-lifetime owner; appearance
  libraries only project its values.
- Use design tokens and existing shared UI primitives. No literal colors in
  TSX, parallel shadcn-like controls, or feature-local tooltip/keyboard chrome.
  When a shadcn primitive fits, adopt or extend its canonical API in
  `components/ui/`; deviate only for a concrete behavioral or design reason, and
  keep the deviation local. Product-specific density or variants stay at the
  usage site until they recur.
- Icon-only controls expose `IconButton` tooltips; tooltips label rather than
  contain controls, and never cover what their trigger acts on (a turn's action
  row opens them below). The one exception is `<Tooltip hoverable>`, for an
  explanation whose words appear nowhere else on a trigger with no dense
  neighbours: the pointer can move onto it so a magnified reader can read it,
  and it still holds no controls.

## Local references

- Architecture and cross-layer contracts: [.context/CONTEXT.md](.context/CONTEXT.md)
- Performance traps: [.context/frontend-perf.md](.context/frontend-perf.md)
- Shell patterns: [.context/source-app-shell-patterns.md](.context/source-app-shell-patterns.md)
- Visual conventions: [.context/visual-conventions.md](.context/visual-conventions.md)
- Deferred work: [.context/TODO.md](.context/TODO.md)
- Client seams: [client/chat-submissions](src/client/chat-submissions/AGENTS.md),
  [client/recents](src/client/recents/AGENTS.md),
  [client/working-set](src/client/working-set/AGENTS.md)
- Feature seams: [features/chat](src/features/chat/AGENTS.md),
  [features/draft-review](src/features/draft-review/AGENTS.md),
  [features/agents](src/features/agents/AGENTS.md),
  [features/links](src/features/links/AGENTS.md),
  [features/billing](src/features/billing/AGENTS.md),
  [features/change-trail](src/features/change-trail/AGENTS.md)
- Shared component seams: [components/app/composer](src/components/app/composer/AGENTS.md),
  [components/app/composer-toolbar](src/components/app/composer-toolbar/AGENTS.md),
  [components/app/link-chip](src/components/app/link-chip/AGENTS.md)
- Test fixtures: [test-support](src/test-support/AGENTS.md)

Server config, route grammar, transport, and detailed query/store contracts are
in the context reference; do not restate them here.
