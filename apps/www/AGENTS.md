# @meridian/www

Public marketing site. TanStack Start (React 19, Vite, Nitro) with Tailwind v4.

## Owns
- Marketing pages (landing, about, investor relations)
- Public docs (when promoted from the KB / external docs surface)
- SEO + sitemap + OG tags

## Does NOT own
- Authentication. Public site is unauthenticated. Auth lives in `@meridian/app`.
- Domain logic. No imports from domain/runtime packages. Marketing copy is the
  payload; nothing to compose. **`@meridian/design-tokens` is the only runtime
  package import** — shared Warm Organic CSS variables.

## Constraints
- **Pure presentation** — if a route needs runtime packages, it belongs in `@meridian/app`.
  This site is public and unauthenticated; domain logic doesn't belong here.
- **Static-ish content** — server functions are available but should be used sparingly
  (form posts, analytics ping). Marketing pages should be fast and cacheable.

## Layout
- `src/routes/` — file-based routes
- `src/components/` — local UI bits
- `src/styles/app.css` — Tailwind entry

## Seeded from
TanStack `start-basic` example, pruned to the bare frame (kept `__root.tsx`,
`index.tsx`, `router.tsx`, `routeTree.gen.ts`, error/not-found components,
seo util). All demo routes (posts, users, deferred, nested layouts) removed.

## Related
- [api-and-frontend-surface](../../.meridian/git/meridian-bio-docs/kb/decisions/api-and-frontend-surface.md)

## Depth
→ [../../.context/CONTEXT.md](../../.context/CONTEXT.md) — app layer architecture
