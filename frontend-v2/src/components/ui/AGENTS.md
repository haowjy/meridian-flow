# Components — UI Primitives

## What Lives Here

This is `src/components/ui/` — 35 shadcn/ui new-york primitives with
co-located `.stories.tsx` files, plus shared composites (Rail, TabBar,
BottomNav, PanelResizeHandle, BottomSheet, AccessoryBar, etc. as they
are built in Phase 4/6).

| Category | Components |
|---|---|
| Form controls | Button, Input, Textarea, Select, Checkbox, Switch, Toggle, ToggleGroup, Slider, FormField |
| Overlays | Dialog, Sheet, Popover, Tooltip, DropdownMenu, ContextMenu, Command |
| Content display | Card, Badge, Avatar, Accordion, Tabs, Collapsible, Progress, Skeleton, Separator, ScrollArea, Breadcrumb, TreeView |
| Feedback | Sonner (toaster wrapper), Alert, Label |
| App shell | ThemeToggle |
| Composites (Phase 4/6) | Rail, StatusBar, TabBar, FileExplorer, PanelResizeHandle, BottomNav, AccessoryBar, BottomSheet, HunkReviewSheet, MobileComposer |

## Local Rules

### Every primitive carries `data-slot`

shadcn/ui v4 uses `data-slot` attributes for CLI compatibility and stable
styling hooks. All 35 existing components have them. Every new primitive
must include them. Enforced by ESLint (see `AGENTS.md` §Lint Contract).

### Co-locate `.stories.tsx`

Every component has a Storybook story in the same directory. The story is
the component contract — it exercises all variants, all states, and gates
visual regression via Chromatic. See `AGENTS.md` §Story Coverage Contract.

### Variants via CVA factory, never ad-hoc

Every component that exposes style variants must use a canonical variant
factory (CVA for atoms, `tailwind-variants` permitted for slot-heavy
composites). The variant map is the single source of truth. Ad-hoc
`className` overrides outside the variant map are an explicit escape hatch
— not the default path.

### `className`/`twMerge` only at the boundary

`twMerge` is called **only** at the component boundary where a consumer's
`className` prop merges with the component's own defaults. Internal
composition uses `twJoin` or plain string concatenation. See
`_docs/design/components.md` §Override Policy.

### No raw hex / arbitrary Tailwind values — consume tokens

Colors, spacing, radii, durations, easings, font sizes, font families,
and shadows must use design tokens. Raw values are only allowed in the
token-plumbing files (`src/index.css`). Enforced by ESLint
(`no-arbitrary-value`, `no-custom-classname`). See
`_docs/design/foundations/tokens.md` for the full token inventory.

### 44px minimum touch targets

All interactive elements must have a 44px minimum hit area
(`--touch-target-min`). Where visual size is smaller (rail icons at 36px,
tree rows at 28px), invisible hit-padding extends the interactive area to
44px. Enforced on all tiers; no exceptions on Phone/Tablet. See
`_docs/design/components.md` §Touch Targets.

### Font discipline

- UI chrome: **Geist Variable** only (weights 400, 500, 600)
- Prose/editor: **iA Writer Quattro** only (weights 400, 400i, 700, 700i)
- Code/technical: **Geist Mono Variable** only (weights 400, 500)

No mixing. See `_docs/design/foundations/typography.md` §Font Roles.

### Fluid type scale guardrails

All `clamp()` type tokens use `rem`/`em` bounds (never `px`), max ≤ 2.5×
min ratio, modest `vw` influence. 200% zoom + text-only resize is a QA
gate. See `_docs/design/foundations/typography.md` §Fluid Scale Guardrails.

### States: loading, empty, error

Every data-displaying component must handle:
- **Loading:** Skeleton or spinner (within 200ms — no spinner for fast loads)
- **Empty:** Centered message with icon + heading + description + optional action
- **Error:** Centered message with destructive icon, heading, retry button
- **Interaction:** Hover, focus-visible, active, disabled where applicable

See `_docs/design/components.md` §Component States.

### Accessibility patterns

- All interactive elements reachable via Tab; focus order follows visual order
- Composite widgets use arrow keys for internal navigation
- `Escape` closes the innermost overlay
- `aria-live="polite"` for mode switching and streaming status
- ARIA patterns per component: see `_docs/design/components.md` §ARIA Patterns

## Adding a shadcn Component

```bash
npx shadcn@latest add <component-name>
```

Components land in `src/components/ui/`. After adding:

1. Add a `.stories.tsx` file alongside the component
2. Verify `data-slot` attributes are present
3. Verify all styles use design tokens (no raw hex, no arbitrary values)
4. Test in both light and dark theme via the Storybook toolbar
5. Run `pnpm run lint` and fix any violations

## Design Spec Pointers

| Concern | Canonical doc |
|---|---|
| Atom inventory, shared patterns, enforcement policy, composites | `_docs/design/components.md` |
| Token system (`@theme` mapping, semantic tokens, token discipline whitelist) | `_docs/design/foundations/tokens.md` |
| Typography (type scale, font roles, fluid `clamp()` guardrails) | `_docs/design/foundations/typography.md` |
| Color (Paper/Espresso themes, accent system, WCAG rules) | `_docs/design/foundations/color.md` |
| Motion (duration/easing tokens, motion catalog, INP budget) | `_docs/design/foundations/motion.md` |
| Elevation (shadow token scale) | `_docs/design/foundations/elevation.md` |
| Responsive (tiers, viewport/safe-area tokens, touch rules) | `_docs/design/foundations/responsive.md` |
| AccessoryBar, BottomSheet, HunkReviewSheet, MobileComposer | `_docs/design/components.md` §New Composite Components |
