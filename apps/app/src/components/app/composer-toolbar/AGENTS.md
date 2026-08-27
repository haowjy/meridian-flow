# Composer toolbar framework

This module owns one responsive control surface for conversation-attached
composer controls. Features contribute status or panel adapters; they do not
own popup topology, trigger policy, placement, or return focus.

- Treat `ComposerToolbarModel` as one value: render descriptors and their
  serializable navigation projection must describe the same topology.
- Keep one toolbar-owned Popover root and Content. Inline controls and the
  overflow root are alternate hosts for that surface, never nested popups.
- Let the navigation machine decide open, switch, lock, dismissal, Back,
  topology reconciliation, and semantic focus intent before children commit.
- Feature adapters own domain state, page rendering, and ordered focus
  candidates. DOM refs execute focus intent; they never become navigation
  state.
- Preserve transient controls as focusable `aria-disabled` return anchors.
  Native `disabled` must not strand focus or hide refusal semantics.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing descriptors,
navigation, measurement, popup ownership, or focus execution.
