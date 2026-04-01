# Visual Component Map

**Status:** draft

Visual reference for all shared UI components across Meridian's workspace modes.

## SuperDesign References

| Item | Draft ID | Preview |
|------|----------|---------|
| Base Components (rail, tabs, explorer, status bar) | `a3324c5f-9b3b-40e1-9c25-5a2e17cc6092` | [Preview](https://p.superdesign.dev/draft/a3324c5f-9b3b-40e1-9c25-5a2e17cc6092) |
| Extended: Chat Components | `399be9d0-b759-49f1-88e0-6481d8c76e86` | [Preview](https://p.superdesign.dev/draft/399be9d0-b759-49f1-88e0-6481d8c76e86) |

## Components Covered

### Rail (Mode Switcher)
- 48px fixed width, dark warm background
- 3 mode icons: Agents (Users), Converse (ChatCircle), Studio (PencilLine)
- States: default (60% opacity), hover (100%), active (teal icon + 3px left border)
- Tooltip on hover showing mode name + keyboard shortcut
- Settings gear at bottom
- Light + Dark mode variants

### Panel Resize Handles
- Default: 1px warm border line
- Hover: 3px teal-tinted line, col-resize cursor
- Active/dragging: solid 3px teal line

### Tab Bar
- 36px height, warm background
- Active tab: paper bg, 2px bottom teal border
- Inactive: transparent bg, muted text
- Dirty indicator: filled teal dot before filename
- Close button: X, visible on hover
- Overflow: chevron dropdown at right edge
- Light + Dark variants

### Thread Messages (updated with frontend patterns)
- User: right-aligned card bubble, bg-card, border-border, shadow-1, rounded-lg, max-width 95%, compact padding (px-2.5 py-1.5). Hover shadow-2.
- AI: NO card/bubble -- transparent, full-width, left-aligned. Content blocks with gap-2 spacing. Content breathes as part of the page.
- Streaming: three bouncing gold (#F4B41A) dots, staggered 160ms
- Light + Dark variants

### Thinking Blocks
- Native details/summary collapsible
- bg-muted/30 background, 2px amber left border accent
- Collapsed: 'Thinking...' label with shimmer animation while streaming
- Expanded: reasoning text visible below summary
- Light + Dark variants

### Tool Groups
- Collapsible container, rounded-lg border, bg-card/50
- Header: wrench icon + tool count label + status indicator
- Status variants: green check (complete), red alert triangle (error), bouncing gold dots (streaming)
- Expanded: nested tool interaction rows with individual results
- Light + Dark variants

### Turn Action Bar
- Hidden by default, visible on hover (group-hover:opacity-100 transition)
- Actions: Copy (clipboard icon), Edit (pencil, user turns only), Regenerate (refresh, AI turns only)
- Sibling navigation: left/right chevrons + '2/3' counter when branched
- 3px icon size, muted foreground, hover highlights

### Reference Pills
- Inline document reference badges
- bg-muted, border, rounded-[4px], px-1.5 py-px, text-xs
- File icon + truncated filename
- Broken link variant: dashed underline indicator
- Remove-on-hover for editable contexts

### Floating Composer
- Positioned at bottom of scroll area, floats over messages
- CM6 editor: 14px font, max 200px height, auto-expanding, min 48px (2-line feel)
- Control bar below editor: model selector dropdown, reasoning toggle, tools toggle, send button
- Focused state: visible border/ring
- Unfocused state: subtle border

### Scroll-to-Bottom Button
- Circular button floating above composer
- Down chevron icon
- Opacity animated (visible when scrolled up, hidden at bottom)

### File Explorer Tree
- Folder expanded/collapsed with Phosphor icons
- File default/active/hover states
- Active: teal left border highlight
- 13px Geist, 16px indent per level
- Light + Dark variants

### Status Bar
- 28px height, full width
- Connected: green dot indicator
- Reconnecting: amber/red pulsing indicator
- Credit balance: teal icon + count
- Low credits warning: amber indicator
- Light + Dark variants

### Mobile Tab Bar (post-v1)
- 48px height, bottom-positioned, replaces rail on mobile
- 3 tabs: Agents, Converse, Studio
- Active: jade-teal icon + label
- Inactive: muted icon + label
- 44px touch targets

## Cross-References

- [Layout Visual Designs](../layouts/visual-designs.md)
- [Design System Spec](design-system.md)
- [Brand Foundations](../../foundations/brand.md)
