---
detail: standard
audience: developer
---

# Theme System

Single theme architecture with **Modern Literary** as the only theme. Users can toggle between light/dark modes, but cannot switch theme presets.

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

## Design System Overview

### Color Hierarchy

```mermaid
flowchart TB
    subgraph Foundation["Foundation Colors"]
        direction LR
        bg["background<br/>#F9F6F0 / #1C1917"]
        surface["surface<br/>#FFFDF8 / #252220"]
        text["text<br/>#2C2418 / #F0EBE3"]
        border["border<br/>#E5DFD4 / #3A3530"]
    end

    subgraph Interactive["Interactive Colors"]
        direction LR
        primary["primary (sage)<br/>#5F8575 / #7BA391"]
        favorite["favorite (gold)<br/>#F4B41A / #E3C169"]
    end

    subgraph Feedback["Feedback Colors"]
        direction LR
        success["success<br/>#3D8B5F / #5CB87A"]
        warning["warning<br/>#DB9A30 / #F0B042"]
        error["error<br/>#B54425 / #E8735A"]
    end

    style Foundation fill:#2d5a4a,color:#fff
    style Interactive fill:#5a4a3a,color:#fff
    style Feedback fill:#6a5a2a,color:#fff
```

### Spacing Scale (8pt Grid)

```mermaid
flowchart LR
    S1["4px<br/>spacing-1"]
    S2["8px<br/>spacing-2"]
    S3["16px<br/>spacing-3"]
    S4["24px<br/>spacing-4"]
    S5["32px<br/>spacing-5"]
    S6["48px<br/>spacing-6"]

    S1 --> S2 --> S3 --> S4 --> S5 --> S6

    style S2 fill:#5F8575,color:#fff
```

**Standard unit**: 8px (`spacing-2`). All spacing should be multiples of 4px.

### Typography Stack

| Role | Font | Usage | Fallback |
|------|------|-------|----------|
| Display | Source Serif 4 | Headings, titles | Georgia, serif |
| Body | Source Serif 4 | Document content | Georgia, serif |
| UI | Inter | Buttons, labels, nav | system-ui, sans-serif |
| Mono | JetBrains Mono | Code/plaintext surfaces | ui-monospace, monospace |

### Shadow Elevation

| Level | Name | Usage |
|-------|------|-------|
| 1 | `shadow-sm` | Subtle lift (cards at rest) |
| 2 | `shadow-md` | Interactive hover states |
| 3 | `shadow-lg` | Modals, dropdowns, overlays |

### Component Heights

| Component | Height |
|-----------|--------|
| WorkspaceRail | 48px width |
| MobileBottomBar | 64px |
| Touch targets | min 44px |

## Quick Start

### Using Theme in Components

```typescript
import { useThemeContext } from '@/core/theme';

function MyComponent() {
  const { isDark, setMode } = useThemeContext();

  // Switch mode: 'light' | 'dark' | 'system'
  setMode('dark');

  // Note: setThemeId is available but disabled (single theme)
}
```

### Available Themes

- [`modern-literary`](./modern-literary.md) - Only theme. Warm paper + sage green + gold, browser default sans + JetBrains Mono for mono surfaces

**Design Decision**: Single theme simplifies the UX and ensures consistent visual identity. Theme switching can be re-enabled in the future if needed by reversing these changes.

## CSS Variables

Theme system sets `--theme-*` variables on `:root`. Key variables:

| Variable | Description |
|----------|-------------|
| `--theme-bg` | Page background |
| `--theme-surface` | Card/panel background |
| `--theme-text` | Primary text |
| `--theme-text-muted` | Secondary text |
| `--theme-favorite` | Favorite/special marking color (gold) |
| `--theme-primary` | Primary action/interactive color (sage) |
| `--theme-sidebar` | Sidebar background |
| `--theme-font-display` | Heading font family |
| `--theme-font-body` | Body text font family |
| `--theme-font-ui` | UI element font family |

## Color Semantics

Theme v3+ uses semantic color naming with clear intent:

**`favorite`** (#F4B41A gold): Special markings
- Stars, bookmarks, featured content
- "I want this to stand out as special"

**`primary`** (#5F8575 sage): Interactive UI elements
- Buttons, focus rings, hover states, selection
- "This is the main action color"

**Migration from v2**: The legacy `accent` color was split for clearer intent:
- `accent` -> `favorite` for starred items, special markings
- `accent` -> `primary` for interactive UI elements

## Adding New Themes

1. Define preset in `frontend/src/core/theme/themes.ts`
2. Add to `THEME_PRESETS` record
3. Theme appears automatically in `getAvailableThemes()`

Detailed guide: `_docs/hidden/handoffs/design-system-theme-architecture.md`

## Persistence

- Mode: `localStorage` key `meridian-theme-mode`
- System preference detected via `prefers-color-scheme`
- Theme ID persistence removed (single theme architecture)

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
