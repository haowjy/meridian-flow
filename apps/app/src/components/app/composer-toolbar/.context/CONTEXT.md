# Composer toolbar contracts

The render descriptors and `ToolbarNavigationInput` form one
`ComposerToolbarModel`. Structural changes are reconciled by
`useComposerToolbarMachine` during render, before children or DOM commit, so
descriptor arrays, render closures and refs aren't hidden reducer inputs.

Host migration between inline and overflow keeps the panel session and Content
relationship, and changes neither domain state nor in-panel focus because width
changed. During a nondismissible panel session, measurement keeps accepting
control widths but the toolbar holds its committed allocation and popup host;
the latest topology applies once when the session settles.

Busy and locked are separate. One feature can be busy without making competitors
busy, while a session lock makes competing activation unavailable without
claiming their mutations are in progress.

The executor checks that a focus target is connected, visible, inside the active
Content when required, and actually received focus. A missing or disabled ref
doesn't acknowledge the token; Content is the panel fallback and `BODY` doesn't
count as a destination.

`ComposerCurrentValueTrigger` requires the toolbar binding intact and doesn't
infer open, busy, locked or refusal policy. The visible ellipsis and its mounted
measurement probe share one sizing recipe so overflow reservation matches the
rendered owner.

## Rejected structures

- Separate inline and overflow popups, nested feature popovers, or feature-owned
  open state: they permit duplicate or empty surfaces during migration.
- Permanent maximum-width reservations or Work-specific allocation rules: they
  waste space for short values and fail to cover other changing labels.
- Mutable descriptor refs or effect-time topology repair: rendered controls and
  reducer validity can disagree for a committed frame.
- One static initial-focus ref: real pages replace choices, disable rows, and
  render error or confirmation actions.
- Radix default return focus or unverified `.focus()`: the current owner may have
  migrated, disappeared or become nonfocusable.
- Feature-authored trigger ARIA or native-disabled transient triggers: they can
  contradict the one toolbar-owned dialog and strand focus.

Feature-adapter behavior and mid-thread Work rebinding:
[`composer-write-mode.md`](../../../../features/chat/.context/composer-write-mode.md).
