---
detail: standard
audience: developer
---

# Modern Literary Theme

**Default theme** - Contemporary literary aesthetic with sage green primary and gold favorites.

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
| favorite | `#F4B41A` | Favorite/special (gold) |
| primary | `#5F8575` | Primary action (sage green) |
| success | `#3D8B5F` | Success feedback |
| successForeground | `#FFFFFF` | Text on success background |
| warning | `#DB9A30` | Warning feedback |
| warningForeground | `#2C2418` | Text on warning background |
| error | `#B54425` | Error feedback (terracotta) |
| errorForeground | `#FFFFFF` | Text on error background |
| sidebar | `#F3EFE7` | Sidebar background |

### Dark Mode

| Variable | Hex | Description |
|----------|-----|-------------|
| bg | `#1C1917` | Page background (espresso) |
| surface | `#252220` | Card/panel background |
| text | `#F0EBE3` | Primary text |
| textMuted | `#A89E8E` | Secondary text |
| border | `#3A3530` | Borders |
| favorite | `#E3C169` | Favorite/special (warm gold) |
| primary | `#7BA391` | Primary action (lighter sage) |
| success | `#5CB87A` | Success feedback |
| successForeground | `#1C1917` | Text on success background |
| warning | `#F0B042` | Warning feedback |
| warningForeground | `#1C1917` | Text on warning background |
| error | `#E8735A` | Error feedback (coral) |
| errorForeground | `#1C1917` | Text on error background |
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
