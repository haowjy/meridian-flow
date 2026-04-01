# Settings

Theme, editor preferences, and per-project configuration.

## Scope

### Global Settings
- Theme toggle (light/dark)
- Editor font size
- Default model selection
- Keyboard shortcut customization

### Per-Project Settings
- **Agents & Skills management** — dedicated panel that reads `.agents/` folder, see [file-first-storage.md](../agents/file-first-storage.md)
  - List installed agents and skills
  - Toggle enabled/disabled
  - Edit model selection, description, permissions (writes YAML frontmatter)
  - Import from git button
- Default persona for new threads
- Project-level model preferences

### Account Settings
- Profile (name, email)
- Credit balance and usage history (links to billing)
- Connected accounts (Google OAuth)

## Carry Forward

- Existing `useUIStore.ts` — theme, UI state (persist middleware)
- Existing theme system in `frontend/src/core/theme/`

## Dependencies

- Design system (settings page layout, form components)
- Agents + Skills (settings UI is the primary interface for `.agents/`)
- Billing (credit balance display)
- Auth (account management)
