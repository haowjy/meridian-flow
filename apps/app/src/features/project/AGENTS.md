# Project workspace

This feature composes the authenticated project workspace: desktop and phone
shells, route-controlled destinations, shared rails, and project-scoped
screens. Chat, editor, and context domain behavior stays with those features.

- Keep route state and destination ownership in the project route boundary;
  child surfaces render through controlled controllers rather than writing
  URLs.
- Preserve persistent desktop surfaces across destination changes; do not
  reparent, portal, or conditionally remove them to change layout.
- Treat Work as catalog and chat binding as explicit composer-owned state;
  navigation and Work management never rebind a chat implicitly.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing project shell
layout, routing, rails, headers, or project-scoped state.
