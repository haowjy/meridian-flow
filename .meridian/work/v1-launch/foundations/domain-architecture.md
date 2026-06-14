# Domain Architecture

| Site | Subdomain | v1 State |
|------|-----------|----------|
| Marketing/landing | `meridian-flow.com` | Simple landing page for launch (not a full marketing site) |
| Studio (the app) | `studio.meridian-flow.com` | The app |
| Published content | TBD | "Coming soon" static page |
| Marketplace | `marketplace.meridian-flow.com` | "Coming soon" static page |

## Deployment

| Component | Platform |
|-----------|----------|
| Backend | Railway |
| Database | Supabase (PostgreSQL) |
| Frontend | Vercel |

## v1 Scope

- **Desktop-first, components responsive** — v1 ships desktop layouts only, but every component is built mobile-ready (responsive sizing, touch-friendly tap targets, fluid typography). Mobile layouts and mobile-specific UX (bottom sheets, gesture navigation) are post-v1.
- No "coming soon" links in nav rail — only show things that work today
