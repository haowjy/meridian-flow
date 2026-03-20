# Command Palette

Keyboard-driven navigation and command execution.

## Scope

- Cmd+K to open (or alternative — see shortcut collisions below)
- Fuzzy search across: documents, commands, settings, threads
- Recent files list
- Action execution (toggle theme, open settings, create document, switch layout)

## Keyboard Shortcut Policy

Global shortcut namespace must be resolved before implementation. Known collisions:

| Shortcut | Claimed by |
|----------|-----------|
| `Cmd+1/2/3` | Layout mode switching, tab selection, AND editor headings |
| `Cmd+K` | Command palette AND editor links |

Resolution needed: define which context owns which shortcut. Likely approach:
- `Cmd+1-9` → tabs (matches browser/IDE convention)
- `Cmd+Shift+1/2/3` → layout modes
- `Cmd+K` → command palette (editor links use toolbar or different shortcut)
- Editor heading shortcuts → markdown-specific (e.g., `Cmd+Shift+H` cycle)

## Dependencies

- Design system (palette UI, search input)
- Explorer (document search results)
- Settings (command actions)
