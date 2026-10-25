# domains/preferences

Owns account display preferences.

- `AccountSettingsRepository` reads and atomically patches language, theme and
  Stats for nerds in `user_preferences.preferences`. Working-set sync remains
  in `users.working_set_sync_enabled`; the same repository owns both, locking
  the account row while patching and reading the resulting snapshot.
- `AccountSettings` is the complete GET/PATCH response. PATCH accepts nonempty
  partial absolute-set changes, validated against shared contract value sets.
- Production uses a Drizzle adapter; an in-memory adapter implements the same
  port.
