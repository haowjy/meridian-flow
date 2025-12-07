---
detail: standard
audience: developer
---

# Classic Jade Theme

Original Meridian theme with jade and gold accents on parchment.

| Property | Value |
|----------|-------|
| ID | `classic-jade` |
| Radius | 8px |

## Colors

### Light Mode

| Variable | Hex | Description |
|----------|-----|-------------|
| bg | `#F7F3EB` | Page background (parchment) |
| surface | `#FFFFFF` | Card/panel background |
| text | `#1C1A18` | Primary text |
| textMuted | `#8A7F6C` | Secondary text |
| border | `#DDD6C8` | Borders |
| accent | `#F4B41A` | Accent (gold) |
| primary | `#356e5b` | Primary action (dark jade) |
| sidebar | `#e8f0ed` | Sidebar background |

### Dark Mode

| Variable | Hex | Description |
|----------|-----|-------------|
| bg | `#2f2f2f` | Page background |
| surface | `#353535` | Card/panel background |
| text | `#EAEAE7` | Primary text |
| textMuted | `#B6B0A2` | Secondary text |
| border | `#2E332F` | Borders |
| accent | `#E3C169` | Accent (warm gold) |
| primary | `#3CC8B4` | Primary action (glow jade) |
| sidebar | `#2a2a2a` | Sidebar background |

## Typography

| Role | Font | Fallback |
|------|------|----------|
| Display | Literata | Georgia, serif |
| Body | Literata | Georgia, serif |
| UI | Inter | system-ui, sans-serif |

### Font Weights

- **Literata**: 400, 500, 700 (with italic)
- **Inter**: 400, 500, 700

## Usage

```typescript
import { useThemeContext } from '@/core/theme';

const { setThemeId } = useThemeContext();
setThemeId('classic-jade');
```
