# features/agents — Agent selection

New-chat Send reserves the selected Agent (default General) with its display
snapshot on the local thread before persist, and catalog updates can't replace
that choice. The server remains the authority for admission of retained
revisions.

| Surface | Behavior |
|---|---|
| New-chat composer | Interactive picker until creation is reserved. |
| Existing conversation, including zero turns | Readonly bound-Agent status. |
| Results provenance | Inert attribution from the producing conversation's retained definition, inside the producing-thread link. |

The composer has no use for the remove API; it stays for a later management
screen.
