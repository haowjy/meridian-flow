# features/agents — Agent selection

New-chat Send reserves the selected Agent (default General) with its display
snapshot on the local thread before persist, and catalog updates can't replace
that choice. The server remains the authority for admission of retained
revisions.

| Surface | Behavior |
|---|---|
| New-chat composer | Interactive picker until creation is reserved. |
| Started chat | The same picker with the bound Agent current. Picking another hands off to it from the last complete turn, a writer message included, so during a running reply the cut is the message it answers. Picking the bound Agent changes nothing (the picker under a turn hands off to it instead). Busy while the server has yet to accept the first send. |
| Chat with nothing to hand off from (no complete turn, a subagent's) | Readonly bound-Agent status. |
| Results provenance | Inert attribution from the producing conversation's retained definition, inside the producing-thread link. |

The composer has no use for the remove API; it stays for a later management
screen.
