# domains/preferences

Owns account display preferences and the per-project runtime auto-resume policy.

- `AccountSettingsRepository` reads and atomically patches language, theme and
  Stats for nerds in `user_preferences.preferences`. Working-set sync remains
  in `users.working_set_sync_enabled`; the same repository owns both, locking
  the account row while patching and reading the resulting snapshot.
- `AccountSettings` is the complete GET/PATCH response. PATCH accepts nonempty
  partial absolute-set changes, validated against shared contract value sets.
- `ProjectPreferencesRepository` retains `read` / `upsert` for `autoResume`.
  The runtime orchestrator consumes it. GET/PUT project preference routes have
  no current client reader; they remain available for this runtime policy.
  Thread grouping and pinned thread IDs are retired, not compatibility fields.
  Migration 0036 transfers visible, project-owned pins to canonical Favorites
  without clearing existing favorites; invalid/orphaned IDs are discarded.
- Production uses Drizzle adapters; in-memory adapters implement the same ports.
  Domain copy/merge helpers keep auto-resume defaults independent.
