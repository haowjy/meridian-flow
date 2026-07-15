# @meridian/design-tokens

Shared Ink & Lacquer design tokens. Canonical theme file: `src/ink-jade.css`
(the stable import path is `@meridian/design-tokens/ink-jade.css`). Put reusable
colors, typography, spacing, radius, and primitive variables here before
consuming them in apps. The file header owns the palette story and designed-but-
unshipped dark ladder; do not duplicate it in a `.context/` file.

- Semantic `@theme` tokens only — no raw hex outside this package.
- Components should use semantic tokens, not literal values.
- If a visual decision appears in multiple places, promote it here or to an app-level utility.
- A value shared by several role tokens is defined once as a package-private
  `:root` `--ink-jade-*` atom that the roles reference; a value with one role
  stays literal in that role. Never consume atoms outside `ink-jade.css` —
  components use role tokens only. Dark mode overrides `--color-*` roles,
  never atoms.
