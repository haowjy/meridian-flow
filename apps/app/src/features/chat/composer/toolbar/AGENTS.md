# Composer toolbar framework

One responsive control surface for conversation-attached composer controls.
Feature adapters own domain state and panels; this module owns popup topology,
trigger policy, placement, navigation and return focus.

- Keep one toolbar-owned Popover root and Content. Inline controls and overflow
  are alternate hosts, not nested popups.
- The navigation machine decides open, switch, lock, dismissal and focus intent
  before children commit. DOM refs only execute that intent.
- Keep transient controls as focusable `aria-disabled` return anchors; native
  `disabled` strands focus.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing descriptors,
navigation, measurement, popup ownership or focus execution.
