---
detail: standard
audience: developer
---

# Theme System

Flexible theming system with runtime theme switching via presets for colors, typography, and fonts.

## Architecture

```
ThemeProvider (React Context)
    │
    ├── useTheme() hook
    │   ├── Reads/writes localStorage
    │   ├── Applies CSS variables to :root
    │   └── Loads theme fonts dynamically
    │
    └── Components use CSS variables via Tailwind
```

**Implementation**: `frontend/src/core/theme/`

## Quick Start

### Using Theme in Components

```typescript
import { useThemeContext } from '@/core/theme';

function MyComponent() {
  const { themeId, setThemeId, isDark, setMode } = useThemeContext();

  // Switch theme
  setThemeId('classic-jade');

  // Switch mode: 'light' | 'dark' | 'system'
  setMode('dark');
}
```

### Available Themes

- [`modern-literary`](./modern-literary.md) - Default. Warm paper + antique gold, Cormorant Garamond/Source Serif 4/Manrope
- [`classic-jade`](./classic-jade.md) - Jade + gold on parchment, Literata/Inter
- [`academic`](./academic.md) - Scholarly typography, EB Garamond/Spectral/DM Sans

## CSS Variables

Theme system sets `--theme-*` variables on `:root`. Key variables:

| Variable | Description |
|----------|-------------|
| `--theme-bg` | Page background |
| `--theme-surface` | Card/panel background |
| `--theme-text` | Primary text |
| `--theme-text-muted` | Secondary text |
| `--theme-accent` | Accent color (amber) |
| `--theme-primary` | Primary action color |
| `--theme-sidebar` | Sidebar background |
| `--theme-font-display` | Heading font family |
| `--theme-font-body` | Body text font family |
| `--theme-font-ui` | UI element font family |

Full reference: `_docs/hidden/handoffs/design-system-theme-architecture.md`

## Adding New Themes

1. Define preset in `frontend/src/core/theme/themes.ts`
2. Add to `THEME_PRESETS` record
3. Theme appears automatically in `getAvailableThemes()`

Detailed guide: `_docs/hidden/handoffs/design-system-theme-architecture.md`

## Persistence

- Theme ID: `localStorage` key `meridian-theme-id`
- Mode: `localStorage` key `meridian-theme-mode`
- System preference detected via `prefers-color-scheme`

## File Structure

```
frontend/src/core/theme/
├── index.ts           # Public exports
├── types.ts           # TypeScript interfaces
├── themes.ts          # Theme preset definitions
├── fonts.ts           # Dynamic font loading
├── useTheme.ts        # Core hook
└── ThemeProvider.tsx  # React context
```
