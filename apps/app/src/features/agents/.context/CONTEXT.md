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
| Agents tab (sidebar) | `.agents/` and `~/.agents/` as trees, built-ins as rows that open read-only. A row says only what keeps a file from use: Unavailable, or Hidden. |
| Open Agent or skill file | `AgentFileNotice` under the path bar: its level, available or Mars's reasons, what it hides or what hides it. |

## Agent files

- Two reads: the catalog (`GET /api/agents`, winners only, with a selection) feeds the picker;
  `GET /api/agents/files` gives every level's file with its verdict and feeds the tab and the
  notice. Built-ins are no documents: their text comes from `GET /api/agents/builtin?path=`
  and opens in a dialog, as an upload does.
- `useAgentFiles` keys on the documents both Agents trees list, so a file made, renamed or
  deleted asks again. Content edits ask again when the open file's room reports every edit
  acknowledged (`serverHasLocalChanges`), which also refreshes the picker's catalog.
- A file made at an Agent or skill path (`agentsFileOf`), from New Agent, New skill or a plain
  New file, starts with `agentFileTemplate`, written into its local copy as typing would be
  (`writeFirstAgentText`). The name goes through Mars's own emitter (`rewriteBlock`, the browser
  build), so `123` and `[critic]` are quoted. The template must read with no Mars finding.
- The picker marks a level (Project, Yours, Built-in) only on a name that hides another.
- Copy spells the levels `.agents/` and `~/.agents/`; `agents://` never reaches the screen.
