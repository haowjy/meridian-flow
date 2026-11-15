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
| Picker | Saved versions only (the catalog lists nothing else). A closing line, "2 unsaved Agent changes", counts the packages not `saved` and opens the Agents tab, so a new Agent missing from the list has its reason. |
| Agents tab (sidebar) | `.agents/` and `~/.agents/` as trees, built-ins as rows that open read-only. Each package's heading (a level's own files) or folder row (`packages/<name>/`) ends with its state and Save; a removed import, which has no row, gets a line under its level. "Save all" in the tab's heading once two or more packages are not `saved`. A file row ends with the first that applies: Error (Mars can't use it, so a Save leaves it out; the name is struck through), Unsaved, Hidden. |
| Open file of a level | `AgentFileNotice` under the path bar: for an Agent or skill file, its level, available or Mars's reasons, what it hides or what hides it; for every file, its package's state and Save (the tab is off by default, so this is where most writers meet Save). |
| Applied draft, the AI's write | The Changes row an Apply took, and the chat's edits receipt, show the package's state and Save for each Agents package they landed in. |
| The AI's `save_agents` | Its fold row says Saved or not; the card after the turn (`AgentSavesReceipt`) gives each package's outcome: the files it left out first, struck through with their Error, then what changed, renames, warnings, and Undo; or the problems. |

## Agent files

- Two reads: the catalog (`GET /api/agents`, saved versions only, winners, with a selection)
  feeds the picker; `GET /api/agents/files` gives every level's file with its verdict and each
  package's Save state, and feeds the tab, the notice, the Save chips and the picker's count.
  Built-ins are no documents: their text comes from `GET /api/agents/builtin?path=` and opens in
  a dialog, as an upload does.
- `useAgentFiles` keys on the documents both Agents trees list, so a file made, renamed or
  deleted asks again. Content edits ask again when the open file's room reports every edit
  acknowledged (`serverHasLocalChanges`), which also refreshes the picker's catalog.
- A file made at an Agent or skill path (`agentsFileOf`), from New Agent, New skill or a plain
  New file, starts with `agentFileTemplate`, written into its local copy as typing would be
  (`writeFirstAgentText`). The name goes through Mars's own emitter (`rewriteBlock`, the browser
  build), so `123` and `[critic]` are quoted. The template must read with no Mars finding.
- The picker marks a level (Project, Yours, Built-in) only on a name that hides another.
- Copy spells the levels `.agents/` and `~/.agents/`; `agents://` and `user://.agents` never
  reach the screen. `areaOf` (`context-schemes.ts`) names a path of the writer's level
  `~/.agents/...` wherever a location is printed.

## Save

- A package is a level's own files (folder `""`) or one import (`packages/<name>/`). Edits land
  in files at once; new chats use a package only once it is saved. Its state (`saved`,
  `unsaved`, `cant-save`, `not-saved`, `removed`) is the server's, computed from the files and
  the latest Save, and read only from the files query: the app keeps no copy of it.
- `PackageSave` is the one look for a package's state and Save, on every surface above. After a
  Save or Undo it says what happened instead (`package-save.ts`, drawn in
  [state-machines.md](state-machines.md)): "Saved" with Undo (and "1 left out" when it left
  files out), "Not saved: 2 problems" opening each finding with a way to its file, "Undone", or
  Retry when the request got no answer. The word is shown at once from what the files query
  holds and replaced by the server's outcome.
- An Error in one Agent's or skill's file leaves that item out of what runs (`leftOut`); the
  rest saves. Only a package-level Error (a broken `mars.toml`, state `cant-save`) fails the
  Save, as a result in a 200, never a refused write: the files and the saved version both stay.
  Warnings never fail it.
- Undo puts the package back on the version before and restores its files by a three-way
  merge, so an edit made since is kept: the package then reads Saved, or Unsaved when such an
  edit survives.
- Save and Undo read the files and the catalog again (`invalidateAgentReads`), as an
  acknowledged edit of an open Agent file does.
