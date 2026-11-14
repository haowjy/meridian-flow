# file suggestions — contracts

`useFileSuggestions` reads one replayed tree per scheme the host asks for and lists every
entry in tree order, so a browsed folder lists its children in the writer's order, as the
tree panel does. Only a search ranks (`matchFileSuggestions`). Tree expansion doesn't affect
picker completeness.

## Keyboard model

The list is a `Picker` (`components/ui/picker.tsx`): Up, Down, Home, End and Enter walk every stop
marked `data-list-item`, host `header` content included. Tab moves between the rows as in any picker and
wraps within the list (the popover's focus scope loops), so it never leaves for the input. Escape is the way
out: it calls `onClose`, because the host holds its popover open and no popover closes it. The host's input
enters the list through the handle's `focusFirst` and `focusLast`. The host owns the popover and input.
