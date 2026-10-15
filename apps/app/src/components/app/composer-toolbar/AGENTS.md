# Composer toolbar framework

One responsive control surface for conversation-attached composer controls.
Feature adapters own domain state and panels; this module owns popup topology,
trigger policy, placement, navigation, and return focus.

- Treat `ComposerToolbarModel` as one value: render descriptors and the
  serializable navigation projection must describe the same topology.
- Keep one toolbar-owned Popover root and Content. Inline controls and overflow
  are alternate hosts, never nested popup surfaces.
- Let the navigation machine decide open, switch, lock, dismissal, Back,
  reconciliation, and semantic focus intent before children commit. DOM refs
  only execute focus intent.
- Keep transient controls as focusable `aria-disabled` return anchors. Native
  `disabled` must not strand focus or hide refusal semantics.

Read [`.context/CONTEXT.md`](.context/CONTEXT.md) before changing descriptors,
navigation, measurement, popup ownership, or focus execution.

The toolbar is presentation infrastructure, not a feature-state owner.
