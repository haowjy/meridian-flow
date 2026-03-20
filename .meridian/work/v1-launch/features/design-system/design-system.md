# Design System

Atoms, theme tokens, and shared components. Storybook-first — every component built and verified in isolation before integration.

## Scope

- Color tokens (paper, espresso, jade-teal, semantic colors) — see [brand.md](../../foundations/brand.md)
- Typography scale (iA Writer Quattro, Geist, Geist Mono) — fluid with `clamp()`, not fixed px
- Spacing system (8pt grid)
- Shared atoms: Button, Badge, Input, Select, Dialog, Tooltip, Dropdown, Toast
- Dark/light mode toggle via theme context
- Phosphor Icons integration

## Responsive / Mobile-Ready

Every component is built responsive from day one. v1 ships desktop layouts only, but the atoms are mobile-ready so adding mobile layouts later requires no component rewrites.

- **Touch targets:** 44px minimum on all interactive elements (buttons, inputs, links, checkboxes)
- **Fluid typography:** `clamp()` for body and heading scales — no fixed breakpoint jumps
- **Responsive containers:** components use relative/fluid sizing, not hardcoded widths
- **No hover-only interactions:** every `:hover` state has a non-hover equivalent (focus, tap, long-press)
- **Viewport-aware modals:** dialogs and dropdowns reflow for small viewports (bottom sheet pattern ready)
- **Input method agnostic:** components work with mouse, touch, and keyboard without mode detection

## Carry Forward

- Existing `frontend-v2/` has Phase 1 (foundation) done, Phase 2 (atoms) in progress — button + badge built with Base UI
- Existing `frontend/` (v1) uses Radix + shadcn/ui throughout

## Key Decisions

- **Radix + shadcn/ui** — reverting the Base UI experiment in frontend-v2. The existing app already uses Radix everywhere, and shadcn/ui gives us pre-built wrappers for cmdk (command palette), sonner (toasts), react-hook-form, etc. Redo the 2 atoms (button, badge) with Radix primitives.
- Storybook-first verification — components have stories before they have consumers
- Accent token split needed: `accent-fill` (current jade-teal) vs `accent-text` (darker, WCAG AA compliant)

## Dependencies

None — this is the foundation everything else builds on.
