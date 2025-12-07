---
detail: standard
audience: developer
---

# Modern Literary Theme

**Default theme** - Contemporary literary aesthetic with warm amber accents.

| Property | Value |
|----------|-------|
| ID | `modern-literary` |
| Radius | 8px |

## Colors

### Light Mode

| Variable | Hex | Description |
|----------|-----|-------------|
| bg | `#F9F6F0` | Page background (warm paper) |
| surface | `#FFFDF8` | Card/panel background |
| text | `#2C2418` | Primary text (warm ink) |
| textMuted | `#6B5D4D` | Secondary text |
| border | `#E5DFD4` | Borders |
| accent | `#C8973E` | Accent (antique gold) |
| primary | `#C8973E` | Primary action |
| sidebar | `#F3EFE7` | Sidebar background |

### Dark Mode

| Variable | Hex | Description |
|----------|-----|-------------|
| bg | `#1C1917` | Page background (espresso) |
| surface | `#252220` | Card/panel background |
| text | `#F0EBE3` | Primary text |
| textMuted | `#A89E8E` | Secondary text |
| border | `#3A3530` | Borders |
| accent | `#E4B866` | Accent (warm amber) |
| primary | `#E4B866` | Primary action |
| sidebar | `#14120F` | Sidebar background |

## Typography

| Role | Font | Fallback |
|------|------|----------|
| Display | Cormorant Garamond | Georgia, serif |
| Body | Source Serif 4 | Georgia, serif |
| UI | Manrope | system-ui, sans-serif |

### Font Weights

- **Cormorant Garamond**: 400, 500, 600 (with italic)
- **Source Serif 4**: 400, 500, 600 (with italic)
- **Manrope**: 400, 500, 600

## Usage

```typescript
import { useThemeContext } from '@/core/theme';

const { setThemeId } = useThemeContext();
setThemeId('modern-literary');
```
