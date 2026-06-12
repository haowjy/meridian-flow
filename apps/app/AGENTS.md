# @meridian/app

Authenticated writing workbench. Keep it a thin React/TanStack Start shell over contracts, client API helpers, stores, and server-owned runtime behavior.

- Use portless URLs for browser/e2e work; do not hard-code raw dev ports.
- Keep product language writer-facing: projects, works, chapters, context, threads, agents, turns.
- No provider/database logic in components; use client API/query layers.
- No literal colors in TSX; use design tokens and app CSS utilities.
- Preserve TipTap/Yjs document-session boundaries; do not invent a second editor sync path.
