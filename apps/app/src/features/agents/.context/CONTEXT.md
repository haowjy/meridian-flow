# features/agents — Agent selection

New-chat Send reserves the selected Agent (default: the Agent of the newest chat started in the
project, from the project's chat list, which every create, handoff and fork adds to at once; else
General) and the model it runs on with its display
snapshot on the local thread before persist, and catalog updates can't replace
that choice. The server remains the authority for admission of retained
revisions.

| Surface | Behavior |
|---|---|
| New-chat composer | Interactive picker until creation is reserved. |
| Started chat | The same picker opened on "This chat": the bound Agent, its definition and the model it runs on. Picking another Agent (under "Hand off to") hands off to it from the last complete turn, a writer message included, so during a running reply the cut is the message it answers; a model picked with it goes to the new chat. Changing the bound Agent's model sets this chat's overrides (`thread_set_overrides`, which carries the model and the reasoning setting together); re-picking what is already in use sends nothing. The picker under a turn hands off, the bound Agent included, under the same "Hand off to" heading. The panel takes one `mode` (`new` / `chat` / `turn`) with the callbacks that mode has, and decides alone whether a pick hands off; a handoff closes it. Busy while the server has yet to accept the first send. |
| Chat with nothing to hand off from (no complete turn, a subagent's) | Readonly bound-Agent status. |
| Results provenance | Inert attribution from the producing conversation's retained definition, inside the producing-thread link. |
| Picker | Left: a borderless search (focused on open), the Agents (name over a line of description) and "Manage Agents" (desktop shell only; the phone has no Agents list). Right, in lockstep for the Agent pointed at: a card of one fixed height (name, description to two lines, this chat's definition, the touch-only "Hand off to X"; the file on hover), its models with their maker's mark (scrolled to the one in use), and one row of the reasoning levels that model accepts (the server's list, so its source can change; Left and Right move along it). They preview what that Agent would run at, by the shared current fill, never a check: the chat's choices for the Agent in use, else its own, which carry "Default". The Agent's own reasoning is marked as the level the gateway settles it to on that model (nearest, ties higher); an Agent that names none gets a leading "Default" level. Choosing a Default clears that override, so one is always reachable. Pointing re-points after 120 ms at rest and holds once the pointer reaches the right side, so a diagonal move keeps its Agent. Picking keeps the picker open (owner, 2026-11-16) so model and reasoning can follow; a handoff closes it, and on touch a handoff row's first tap only points. Saved versions only; an Agent that can't be used keeps its place, struck through, with why and Open file; an Agent only other Agents call (`primary: false`) is left out. Its height follows the Agent count alone. |
| Model and reasoning override | A chat can run its Agent on another model and at another reasoning setting, for that chat only (`threads.model_override` and `threads.effort_override`, resolved per turn by `threadModelId` and `turnGatewayParams`; a model the gateway doesn't list falls back to the Agent's; the gateway settles any reasoning setting to the nearest level the model has, the override's as the Agent's). `GET /api/models` lists each model's levels (`efforts`, lowest first) and `canDisable`; the Agent catalog item's `effort` is the Agent's own setting, for marking "Default". The chip shows the other model's name only when one is set (struck through when it falls back); choosing the Agent's own model ("Default") clears it. Changing the model settles a reasoning override onto the new model and drops it once it equals that model's own level, so the chip names the level the turn runs at (unless the model override itself falls back, or `LIVE_TEST_MODEL` redirects the call). Subagents the chat spawns don't inherit it: each runs at its own Agent file's model and reasoning (owner, 2026-11-15). A pick shows at once from the command journal (`useThreadOverrides`) until a snapshot read after it settles. |
| Agents tab (sidebar) | `.agents/` and `~/.agents/` as trees, built-ins as rows that open read-only. Each package's heading (a level's own files) or folder row (`packages/<name>/`) ends, when there is something to save, with the count of files changed since the last save (an icon and the number, so a 264px row keeps its name; it remains available while a failed Save or Undo result shows) and Save, and a package-level problem (a broken `mars.toml`) as a "1 problem" chip: said there once, never copied onto its files. A removed import, which has no row, gets a line under its level. "Save all" in the tab's heading once two or more packages are not `saved`. A file row ends with the first that applies (`fileTrouble`): Unavailable (no good save in use; the name is struck through), Not in use (its edit has an Error or can't run, and its last good save is used), Unsaved, Hidden. A closed folder says what it holds out of use: "2 unavailable", else "1 not in use" (`outOfUseWord`, the one count every level says, over `fileTrouble`); a package row with its problem chip shows only the chip, and beside Save the count shrinks to a dot and the number (the words in its tooltip and accessible name), so the name keeps the room. |
| Open file of a level | `AgentFileState` at the end of the toolbar row, before Live (the identity row's slot), so the page never moves: a chip for what keeps the file from use or its notes, opening each finding in Flow's words, then its package's state (`Unsaved`, which opens the changed files) and Save, or the Save's result in place ("4 unavailable · Undo"). A package-level problem names the package there ("cw-skills can't be saved: 1 problem", a long name truncated), so a good file of a broken package never reads as broken. A file with nothing to say shows nothing. |
| Applied draft, the AI's write | The Changes row an Apply took, and the chat's edits receipt, show the package's state and Save for each Agents package they landed in. |
| The AI's `save_agents` | Its fold row says Saved or not; the card after the turn (`AgentSavesReceipt`) gives each package's outcome in the Save result's words: what it kept out of use first (a left-out item struck through under "Left out:", a kept item's "Your latest edit isn't in use:"), then what was saved, renames, warnings, and Undo; or the problems. The model reads the same, each file named once above its findings. |

## Agent files

- Two reads: the catalog (`GET /api/agents`, saved versions only, winners, with a selection)
  feeds the picker; `GET /api/agents/files` gives every level's file with its verdict and each
  package's Save state, and feeds the tab, the notice and the Save chips.
  Built-ins are no documents: their text comes from `GET /api/agents/saved-file?level=builtin` and opens in
  a dialog, as an upload does, with the same state chip as an open file (`TroubleChip`).
- `useAgentFiles` keys on the documents both Agents trees list, so a file made, renamed or
  deleted asks again. A text change of any Agents-level document, by any writer (the room, the
  AI, `./mf`), asks again too: the server sends the project an `agent-files-hint` 250ms after it
  (`agent-files-hints.ts`; `~/.agents/` to every project the writer has open), and
  `useProjectWake` re-reads the files and the picker's catalog. Without it a file's verdict was
  read once, when the tree first listed it, which for a file made and then filled is empty text.
- A file made at an Agent or skill path (`agentsFileOf`), from New Agent, New skill or a plain
  New file, starts with `agentFileTemplate`, written into its local copy as typing would be
  (`writeFirstAgentText`). The name goes through Mars's own emitter (`rewriteBlock`, the browser
  build), so `123` and `[critic]` are quoted. The template must read with no Mars finding.
- The picker shows no level (Project, Yours, Built-in); rows that share a name add their file
  name as a quiet meta, and the detail shows the file's address.
- Copy spells the levels `.agents/` and `~/.agents/`; `agents://` and `user://.agents` never
  reach the screen. `areaOf` (`context-schemes.ts`) names a path of the writer's level
  `~/.agents/...` wherever a location is printed.

## Diff since the last save

- `PackageChanges` is the one list of a package's files added, changed and deleted since its last
  save (`AgentPackageStatus.changes`): an open file's `Unsaved` opens it, and elsewhere a count
  before the state does, a Save's failed or undone word included. Each file opens
  `SavedDiffDialog`: the saved text (`GET /api/agents/saved-file`, keyed by the package's latest
  Save, which never changes) against the document's text now (the context read), two columns
  from `sm` up and stacked below it. An added file shows only the new side, a deleted one only
  the saved side. Stacked changed lines each name their side (Saved or Now); colour
  is not the only cue.
- The line diff is `diffKeys` over lines, and a paired changed line marks its words with
  `wordDiff`, both from `@meridian/agent-edit/diff` (`saved-diff.ts`). Unchanged stretches fold
  to three lines of context each side.

## Save

- A package is a level's own files (folder `""`) or one import (`packages/<name>/`). Edits land
  in files at once; new chats use a package only once it is saved. Its state (`saved`,
  `unsaved`, `cant-save`, `not-saved`, `removed`) is the server's, computed from the files and
  the latest Save, and read only from the files query: the app keeps no copy of it.
- `PackageSave` is the one look for a package's state and Save, on every surface above. After a
  Save or Undo it says what happened instead (`package-save.ts`, drawn in
  [state-machines.md](state-machines.md)): "Saved" with Undo, or, when anything of the
  package is out of use, its count in place of "Saved" ("4 unavailable · Undo"; the count every
  level says, read with `troubleAfterSave`, what a Save makes of each file, so it is the same
  before the server answers and after the files are read again); its list names each such file
  with what keeps it out ("Left out:", "Your latest edit isn't in use:", "New chats can't start
  it:"), then what was saved and the Save's notes. A failed Save reads "2 problems" on a sidebar
  row and "cw-skills can't be saved: 2 problems" elsewhere, opening each finding with a way to
  its file; then "Undone" (inside the changes count’s popover on package rows to keep
  the name readable), or Retry when the request got no answer. The word is shown at once
  from what the files query holds and replaced by the server's outcome.
- **Words** (`findings.ts`): "Unavailable" only for an item with no saved version that runs; an
  edit with an Error, or one that can't run (such as a model the account can't use), over a saved
  version that runs is "Not in use". The server keeps the two apart: an item's Errors are its package's
  findings, `unavailableReasons` holds only runtime reasons, and `savedVersionInUse` means the
  saved version runs. Each finding shows in Flow's sentence where `findingSentence` has one, else
  Mars's message. Findings are causes only (`compile-package.ts` makes no knock-on of a broken
  `mars.toml`), so every surface shows them unfiltered. A failed Save says what new chats keep
  from `SaveOutcome.savedBefore`, never "the version saved before" for a package never saved.
- An Error in one Agent's or skill's file leaves that item out of what runs (`leftOut`); the
  rest saves. Only a package-level Error (a broken `mars.toml`, state `cant-save`) fails the
  Save, as a result in a 200, never a refused write: the files and the saved version both stay.
  Warnings never fail it.
- Undo puts the package back on the version before and restores its files by a three-way
  merge, so an edit made since is kept: the package then reads Saved, or Unsaved when such an
  edit survives.
- Save and Undo read the files and the catalog again (`invalidateAgentReads`), as an
  acknowledged edit of an open Agent file does.
