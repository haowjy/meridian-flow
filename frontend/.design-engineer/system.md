# Meridian Design System

## Direction
- **Personality**: Warmth & Sophistication (literary, writer-focused)
- **Foundation**: Warm neutrals (cream #F9F6F0, warm ink #2C2418)
- **Accent**: Antique gold (#C8973E light, #E4B866 dark)
- **Depth**: Layered shadows with subtle gold glow in dark mode

## Tokens

### Heights (4-step scale)
| Size | Value | Usage |
|------|-------|-------|
| xs | 24px | Compact inline controls |
| sm | 32px | Small buttons, inputs |
| md | 36px | Default buttons, inputs |
| lg | 40px | Prominent actions, auth forms |

### Spacing (8pt grid)
| Token | Value | Usage |
|-------|-------|-------|
| 1 | 4px | Micro (icon gaps) |
| 2 | 8px | Standard (within components) |
| 3 | 16px | Comfortable (sections) |
| 4 | 24px | Generous (major divisions) |
| 5 | 32px | Large containers |
| 6 | 48px | Layout sections |

### Border Radius
| Token | Value | Usage |
|-------|-------|-------|
| sm | 6px | Inputs, ghost buttons |
| default | 8px | Cards |
| md | 10px | Medium elements |
| lg | 12px | Large cards, modals, messages |
| xl | 16px | Extra large containers |
| full | 9999px | Pill buttons (primary, secondary, outline) |

### Shadows (3 levels)
- **shadow-1**: Subtle (cards, list items) - dual layer warm
- **shadow-2**: Medium (dropdowns, popovers)
- **shadow-3**: Prominent (modals) - with accent glow in dark

### Animation
| Token | Value |
|-------|-------|
| fast | 150ms |
| medium | 200ms |
| slow | 250ms |
| easing | cubic-bezier(0.4, 0, 0.2, 1) |

## Patterns

### Button System (Claude-style Modern)

**Variants:**
| Variant | Fill | Text | Shape | Use Case |
|---------|------|------|-------|----------|
| default | `bg-foreground` | `text-background` | pill | Main CTAs (Sign in, Send, Create) |
| secondary | `border` | `text-foreground` | pill | Secondary actions (Cancel, Back) |
| outline | `border + bg` | `text-foreground` | pill | Standalone secondary |
| ghost | transparent | `text-foreground` | rounded-md | Toolbars, dropdown triggers |
| destructive | `bg-error` | `text-error-fg` | pill | Dangerous actions (Delete) |

**Sizes:**
| Size | Height | Padding | Icon | Use Case |
|------|--------|---------|------|----------|
| xs | 28px | 12px | 12px | Compact inline (dropdown triggers) |
| sm | 32px | 16px | 14px | Small buttons |
| default | 36px | 20px | 16px | Standard buttons |
| lg | 40px | 24px | 20px | Prominent actions, auth forms |
| icon-xs | 24px | - | 12px | Minimal icon buttons (rounded square) |
| icon-sm | 28px | - | 14px | Small icon buttons (rounded square) |
| icon | 32px | - | 16px | Standard icon buttons (rounded square) |
| icon-lg | 36px | - | 20px | Large icon buttons (rounded square) |

**Focus:** 3px outer + 2px inner ring (gold-tinted)

### Inline Toolbar Buttons (TurnActionBar)
- Use raw `<button>` not `<Button>` component
- Minimal: `p-1 rounded hover:bg-muted`
- Icons: 14px (`size-3.5`)
- No visible background until hover

### Input Default
- Height: 36px (md)
- Padding: 12px horizontal, 4px vertical
- Radius: 4px (rounded-sm)
- Border: 1px solid border color
- Shadow: shadow-1
- Focus: Inset ring (offset 0)

### Input Large (Auth)
- Height: 40px (lg)
- Same padding/radius as default

### Card
- Padding: 24px (py-6 px-6)
- Radius: 8px
- Gap between sections: 24px
- Shadow: shadow-1

### List Item (Sidebar)
- Padding: 10px horizontal, 6-8px vertical (responsive)
- Gap: 8px
- Radius: 4px (rounded-sm)
- Hover: 8% accent wash

### Panel Header
- Padding: 12px horizontal
- Gap: 4px
- Height: 48px (editor), 40-48px responsive (thread)

### Focus Ring
- Outer: 3px solid, 28-35% accent opacity, 2px offset
- Inner: 2px shadow, 12-15% accent opacity
- Use `.focus-ring` utility class

## Typography

### Fonts
- **Display**: Cormorant Garamond (serif)
- **Body**: Source Serif 4 (serif)
- **UI**: Manrope (sans-serif)

### Scale
| Class | Size | Weight | Line Height |
|-------|------|--------|-------------|
| type-display | 20px | 600 | 1.3 |
| type-section | 18px | 600 | 1.35 |
| type-body | 15px | 400 | 1.5 |
| type-label | 13px | 500 | 1.4 |
| type-meta | 12px | 400 | 1.4 |

## Colors

### Light Mode
| Role | Hex |
|------|-----|
| Background | #F9F6F0 |
| Surface | #FFFDF8 |
| Text | #2C2418 |
| Text Muted | #6B5D4D |
| Border | #E5DFD4 |
| Accent | #C8973E |
| Success | #3D8B5F |
| Warning | #DB9A30 |
| Error | #B54425 |

### Dark Mode
| Role | Hex |
|------|-----|
| Background | #1C1917 |
| Surface | #252220 |
| Text | #F0EBE3 |
| Text Muted | #A89E8E |
| Border | #3A3530 |
| Accent | #E4B866 |
| Success | #5CB87A |
| Warning | #F0B042 |
| Error | #E8735A |

## Anti-Patterns
- No spring/bouncy animations
- No thick borders (2px+) for decoration
- No cold grays (use warm tones)
- No dramatic shadows (keep subtle)
- Don't mix font roles (serif for content, sans for UI)
