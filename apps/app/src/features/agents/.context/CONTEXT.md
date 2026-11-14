# features/agents — Agent selection

New-chat Send reserves the selected Agent (default General) with its display
snapshot on the local thread before persist, and catalog updates can't replace
that choice. The server remains the authority for admission of retained
revisions.

| Surface | Behavior |
|---|---|
| New-chat composer | Interactive picker until creation is reserved. |
| Started chat | The same picker with the bound Agent current; picking another hands off to it from the last finished turn. Busy until the server has a turn to hand off from. |
| Subagent chat | Readonly bound-Agent status: the server refuses a hand off there. |
| Results provenance | Inert attribution from the producing conversation's retained definition, inside the producing-thread link. |

The composer has no use for the remove API; it stays for a later management
screen.
