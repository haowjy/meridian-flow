# Composer toolbar contracts

The toolbar presents Agent, write mode, Work, and future composer controls
through one state machine and one popup surface. Layout may change the visible
host, but it must not create a second interaction hierarchy.

## Ownership

`ComposerToolbar` owns measurement, the Popover root and Content, visible-owner
trigger bindings, navigation, session locks, and focus execution.
`ComposerToolbarControl` adapters own only their domain state and presentation:

- `kind: "status"` is inline information and has no popup semantics.
- `kind: "panel"` supplies its interaction state, panel page, ordered focus
  candidates, and render function. Its inline trigger spreads the toolbar's
  opaque `ComposerToolbarTriggerBinding` intact.

The render descriptors and `ToolbarNavigationInput` form one
`ComposerToolbarModel`. The input is a serializable projection of topology,
interaction, page identity, and focusable collection. Structural changes are
reconciled by `useComposerToolbarMachine` during render, before children or DOM
commit; descriptor arrays, render closures, and refs are not hidden reducer
inputs.

## One-surface topology

Exactly zero or one Content is visible. At wide allocations it is anchored to
the active inline control. When controls overflow, the same Content shows either
the root page or a feature page anchored to the ellipsis. Host migration keeps
the panel session and stable Content relationship; it changes neither domain
state nor the current in-panel focus merely because width changed.
During a nondismissible panel session, measurement continues to accept the latest
control widths, but the toolbar retains its committed allocation and popup host.
Current-value wrappers hold their allocated width and truncate changing labels;
the latest measured topology is applied once when the blocking session settles.

The navigation reducer owns same-trigger toggle, different-trigger switch,
overflow Back, terminal close, outside/Escape dismissal, and nondismissible
sessions. A locked panel refuses dismissal and competing navigation. Busy and
locked are separate: one feature may be busy without making competitors busy,
while a session lock makes competing activation unavailable without falsely
claiming their mutations are in progress.

## Trigger and focus contracts

Only the currently visible popup owner exposes the mounted Content relationship.
Panel triggers retain `aria-haspopup="dialog"`; `aria-expanded`,
`aria-controls`, `aria-busy`, and `aria-disabled` come from toolbar policy.
Transient refusal uses `aria-disabled` plus the toolbar activation guard rather
than native disabling, preserving discoverability and a return-focus anchor.

Focus intent is semantic and tokenized:

- page entry tries the adapter's ordered enabled candidates, then Content;
- same-page repair preserves a valid focused descendant and moves only when it
  became invalid;
- close resolves the control's current visible owner, then the ellipsis, another
  inline control, or the explicit toolbar fallback;
- host-only migration preserves valid in-panel focus.

The executor checks that a target is connected, visible, inside the active
Content when required, and actually received focus. A missing or disabled ref
does not acknowledge the token; Content is the panel fallback and `BODY` is
never a successful destination.

## Adapter boundary

Agent may change structurally between an interactive panel and a readonly
status. Write mode uses a Work-keyed discriminated page state so confirmation
cannot survive settlement or a Work identity change. Work derives filtering,
grouping, row enablement, rendered rows, and focus revision from one picker view
model. These differences remain feature-owned; the toolbar supplies the same
surface, trigger, lock, topology, and focus policy to all three.

The current-value presentation family shares one private visual chrome while
keeping two truthful public contracts. `ComposerCurrentValueTrigger` renders the
localized value and chevron for interactive panels and requires the toolbar
binding intact; it must not infer open, busy, locked, or refusal policy.
`ComposerCurrentValueStatus` renders the same geometry without a binding,
chevron, activation, or popup relationship. Existing-chat Agent identity uses
that focusable `aria-disabled` status and preserves its explanatory tooltip.
Current-value controls and the toolbar-owned overflow control share a 32px fine
pointer height and a 44px coarse pointer height. The visible ellipsis and its
permanently mounted measurement probe consume one sizing recipe so overflow
reservation always matches the rendered owner.

## Rejected structures

- Separate inline and overflow popups, nested feature popovers, or feature-owned
  open state: they permit duplicate or empty surfaces during migration.
- Permanent maximum-width reservations or Work-specific allocation rules: they
  waste space for short values and fail to cover other changing labels.
- Mutable descriptor refs or effect-time topology repair: they allow rendered
  controls and reducer validity to disagree for a committed frame.
- One static initial-focus ref: real pages replace choices, disable rows, and
  render error or confirmation actions.
- Radix default return focus or unverified `.focus()`: the current owner may
  have migrated, disappeared, or become nonfocusable.
- Feature-authored trigger ARIA or native-disabled transient triggers: they can
  contradict the one toolbar-owned dialog and strand focus.

Feature-adapter behavior and the checkout's divergent mid-thread Work rebinding are documented in
[`../../../../features/chat/.context/composer-write-mode.md`](../../../../features/chat/.context/composer-write-mode.md).
