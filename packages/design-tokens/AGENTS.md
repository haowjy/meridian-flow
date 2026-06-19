# @meridian/design-tokens

Shared Ink & Jade design tokens. Canonical theme file: `src/ink-jade.css` (import as `@meridian/design-tokens/ink-jade.css`). Put reusable colors, typography, spacing, radius, and primitive variables here before consuming them in apps.

- Semantic `@theme` tokens only — no raw hex outside this package.
- Components should use semantic tokens, not literal values.
- If a visual decision appears in multiple places, promote it here or to an app-level utility.
