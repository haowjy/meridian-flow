# @meridian/www

The public marketing site: TanStack Start (React 19, Vite, Nitro) with
Tailwind v4. It is unauthenticated and pure presentation.

## Owns

- Marketing pages (landing, about, investor relations).
- Public docs, when promoted from the KB or an external docs surface.
- SEO, sitemap and OG tags.

## Rules

- `@meridian/design-tokens` (the shared CSS variables) is the only runtime
  package import. A route that needs domain or runtime packages belongs in
  `@meridian/app`, as does anything authenticated.
- Keep pages fast and cacheable. Use server functions sparingly (form posts,
  analytics pings).

## Layout

- `src/routes/`: file-based routes.
- `src/components/`: local UI pieces.
- `src/styles/app.css`: the Tailwind entry.

Root architecture: [`../../.context/CONTEXT.md`](../../.context/CONTEXT.md).
