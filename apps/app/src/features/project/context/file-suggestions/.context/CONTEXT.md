# file suggestions — contracts

`useFileSuggestions` declares its scope queries in stable hook order, disabling scopes the host excludes.
Tree expansion doesn't affect picker completeness.

## Keyboard model

The list owns a roving `tabIndex={-1}` focus over every stop marked `data-list-item`, including host
`header` slot content, through the shared picker keys (`components/ui/list-keys.ts`). Tab exits the roving
boundary: the host's `onKeyDown` on the popover closes and focuses an adjacent control. Escape closes and
restores focus to the host input. This keeps the list presentational; the host owns the popover and input.
