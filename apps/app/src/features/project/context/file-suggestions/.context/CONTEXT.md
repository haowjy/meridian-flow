# file suggestions — contracts and architecture

Read the [AGENTS.md](../AGENTS.md) first.

## Deep-module contract

The public surface combines a pure ranking core, a cached data hook, and a
presentational list. A host supplies a query and explicit `schemes`/`kinds`
filters; it receives matching `{ scheme, path, name, kind, parents }` entries.

`catalogFileSuggestions` derives source order and ancestor labels directly from
normalized entries.
`matchFileSuggestions` filters first, then ranks a normalized query by:

1. leaf-name prefix;
2. word boundary within the leaf name;
3. scheme, ancestors, or full-path substring.

Ties prefer shallower entries and then source order. Keep this logic pure and
host-agnostic.

`useFileSuggestions` declares the project, user, and current Work/no-Work scope
queries in stable hook order, disabling scopes excluded by the host. Tree
expansion does not affect picker completeness. There is no server search or
suggestion-specific cache.

## Keyboard model

The list owns a roving `tabIndex={-1}` focus model over all stops marked
`data-file-suggestion`. Arrow keys walk the full set — rows plus any host
`header` slot content carrying the same attribute — in visual order. Tab exits
the roving boundary: the host's `onKeyDown` handler on the popover catches Tab
and closes + focuses a logical adjacent control (backward → input, forward →
enabled Save). Escape from any row closes and restores focus to the host input.
This model keeps the list purely presentational — the host owns the popover
and input.

## Hosts

The current host is the identity bar's unified placement/rename/move field
(`IdentityPlacementField.tsx`), which browses writable-scheme directories. The collision note's "Open existing" action
rides inside the roving walk via the `header` slot, so keyboard users can reach
it. Intended reuse includes the composer attach-file picker and ⌘O quick open.
Those hosts should compose this public contract rather than fork matching or
query orchestration.

## Downlinks

- [Editor context architecture](../../.context/CONTEXT.md)
