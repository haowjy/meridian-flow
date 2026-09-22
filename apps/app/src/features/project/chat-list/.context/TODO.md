# Project chat row TODO

- **OPT-004: Show favorite failure on the affected chat row.** `thread-user-state-commands.ts` already owns a correct P1 projection, serialized per-entity queue, stale-feed barrier, and `favoriteError`. Shared `ProjectChatRow.tsx` renders pending but ignores the stored error, leaving Home and Work with only a live announcement. Render a visible row-scoped failure with Retry without replacing the command owner.
