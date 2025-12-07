---
detail: standard
audience: developer
---

# Academic Theme

Scholarly aesthetic with classic typography.

| Property | Value |
|----------|-------|
| ID | `academic` |
| Radius | 8px |

## Colors

Same as [Modern Literary](./modern-literary.md) - this theme differentiates through typography only.

## Typography

| Role | Font | Fallback |
|------|------|----------|
| Display | EB Garamond | Georgia, serif |
| Body | Spectral | Georgia, serif |
| UI | DM Sans | system-ui, sans-serif |

### Font Weights

- **EB Garamond**: 400, 500, 600 (with italic)
- **Spectral**: 400, 500, 600 (with italic)
- **DM Sans**: 400, 500, 600

## Usage

```typescript
import { useThemeContext } from '@/core/theme';

const { setThemeId } = useThemeContext();
setThemeId('academic');
```
