# file suggestions — contracts

`useFileSuggestions` declares its scope queries in stable hook order, disabling scopes the host excludes.
Tree expansion doesn't affect picker completeness.

## Keyboard model

The list is a `Picker` (`components/ui/picker.tsx`): Up, Down, Home, End and Enter walk every stop
marked `data-list-item`, host `header` content included, and Tab moves between the rows as in any picker.
The host's input enters the list through the handle's `focusFirst` and `focusLast`. Escape calls `onClose`,
because the host holds its popover open and no popover closes it. The host owns the popover and input.
