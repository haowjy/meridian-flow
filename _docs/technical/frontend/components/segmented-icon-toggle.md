---
detail: minimal
audience: developer
---

# Segmented Icon Toggle (Two-option control)

## What it is
A reusable two-option toggle built from two buttons with an animated thumb that highlights the active side. Keyboard accessible and icon-agnostic.

## Where
Code: `frontend/src/shared/components/SegmentedIconToggle.tsx`
Example usage: `frontend/src/features/documents/components/EditorHeader.tsx`

## API (props)
- `value: 0 | 1` — current selection (left = 0, right = 1)
- `onChange: (value: 0 | 1) => void` — called on toggle or arrow keys
- `leftIcon: React.ReactNode` — content for left button (usually an icon)
- `rightIcon: React.ReactNode` — content for right button (usually an icon)
- `className?: string` — container styles
- `leftTitle?: string` — title/tooltip for left
- `rightTitle?: string` — title/tooltip for right
- `thumbInset?: number` — highlight inset in px (default 2)
- `thumbRadius?: string` — highlight border-radius (defaults to the active button’s border-radius)
- `variant?: 'fill' | 'content'` — layout behavior
  - `fill` (default): equal-width segments (flex-1)
  - `content`: segments size to the larger of the two icons; thumb tracks measured size

## Behavior
- Click on either side toggles the state (always swaps).
- ArrowLeft/ArrowRight move focus between sides and toggle.
- The highlight (thumb) animates to the active segment and matches its size (with `thumbInset` applied). Radius is derived from the active button unless overridden.

## Usage (editor header)
```tsx
// EditorHeader.tsx
<SegmentedIconToggle
  value={editorReadOnly ? 0 : 1}
  onChange={(v) => setEditorReadOnly(v === 0)}
  leftIcon={<Eye className="h-4 w-4" />}
  rightIcon={<Pencil className="h-4 w-4" />}
  leftTitle="Read-only"
  rightTitle="Edit"
  // variant="fill" // default
  // variant="content" // opt-in: size-to-content
/>
```

## Design notes / rationale
- Avoids hardcoding icon padding/sizes inside the component; callers control icon sizing directly.
- Default `fill` gives predictable symmetry; `content` exists for special cases where sides must size to content.
- Highlight uses DOM measurements and an inset to prevent border overlap artifacts.

## Accessibility
- Uses two real buttons with `aria-pressed` to convey state.
- Group wrapper handles arrow keys for quick switching.

## Open questions
- Visual polish: final colors/shadows per design system (current values are placeholders aligned with shadcn/ui tones).
- Motion: optional cross-fade/scale between icons while sliding.

## Migration
- Prefer `SegmentedIconToggle` over ad-hoc switches for two explicit modes.
- For the editor header, see the example above; remove per-icon padding hacks—keep icons consistent (e.g., `h-4 w-4`).


