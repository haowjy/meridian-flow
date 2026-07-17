# @meridian/app

Authenticated writing workspace. Keep it a thin React/TanStack Start shell over contracts, client API helpers, stores, and server-owned runtime behavior.

- Use portless URLs for browser/e2e work; do not hard-code raw dev ports.
- Keep product language writer-facing: projects, works, chapters, context, threads, agents, turns.
- No provider/database logic in components; use client API/query layers.
- Server auth/config is WorkOS AuthKit (`wos-session` cookie) and lives under `src/server/`; do not add alternate auth adapters in app code.
- No literal colors in TSX; use design tokens and app CSS utilities.
- UI work starts from existing primitives: `Button`/`IconButton`, `Badge`,
  `SectionLabel`, `PaneTitle`, and shared rail components. Do not add new
  hand-rolled pills, icon buttons, uppercase labels, rail headers, arbitrary
  `text-[...]`/`tracking-[...]`, or feature-specific style recipes unless the
  local component owns genuinely new behavior that the primitive cannot express.
- Preserve TipTap/Yjs document-session boundaries; do not invent a second editor sync path.
- **Local-first invariant**: state a writer authors or arranges renders from
  device-local persistence first — the network only improves it, and
  disconnect is a status, never a blocking failure. Documents already do this
  (Yjs + y-indexeddb); session state does (working-set + desk stores, see
  [src/client/working-set/AGENTS.md](src/client/working-set/AGENTS.md)).
  Catalog state (trees, works, threads) does not yet — refactor toward it,
  never away from it. Inherently-online surfaces (AI runtime, billing, auth)
  are exempt: fail loud and honest instead of faking offline. New persistent
  state must pick a tier (content / continuity / workbench / preference /
  cache) before shipping.
- `/_authenticated` mounts one unconditional provider tree (Query → project → thread → transport → copilot); do not gate providers by pathname.
- Settings is a routed overlay via `?settings=` on any authenticated route (`SettingsDialog` in the layout shell).
