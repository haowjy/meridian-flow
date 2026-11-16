# domains/packages

This domain reads Mars packages from the writer's Agent files, saves them, decides which Agents and
skills are available, retains immutable definitions for the chats bound to them, and resolves execution
configuration. The model
is in the [Agent definition][definitions] and [package][packages] pages.

## Contracts

- `domain/mars.ts` is the only module that imports `@meridian-flow/mars-schema`.
  A package is read whole by `readPackage` (Mars's `prepare`, `migrate` off) for its definitions,
  and judged by `checkFiles` (Mars's `check()`) for its findings, both once per `compilePackage`: it adds the package's `[package.tools]` to each Agent that does not name
  the key, and Flow adds no tool rule itself. `prepare` upgrades a pre-v1 package and translates a
  foreign one in memory, so a package whose classification is not `schema-1` makes every Agent
  unavailable (`flow.package-not-schema-1`, left out when the TOML doesn't parse). Findings are
  causes only: an Agent of a package whose `mars.toml` has an Error carries that Error and nothing
  of its own about not being read, so every reader (the Agents tab, the Save result, `save_agents`)
  shows them as they are. `check()` reports a file's
  `changes` too: `field.restriction-lost` above all is a warning, not an error. A manifest error reaches each Agent as Mars's
  `package-tools.unreadable`. A lone file (a skill's listing, a package name) is still read with
  `read`.
- An `error` finding on a file, Mars's or Flow's, defines nothing: its Agent is unavailable, a skill
  file is not a skill, and a `mars.toml` with one makes every Agent of the package unavailable. A
  `warning` or `info` doesn't: it is shown and the Agent runs as its file reads (a restriction
  `prepare` dropped, `field.restriction-lost`, is a warning). `compilePackage` holds the table.
  Mars's levels are used as it grades them (Error: won't load; Warning: written but won't take
  effect; Info: nothing lost) except `definition.duplicate-name` (two Agents or two skills with one
  `name`, compared case-sensitively as Mars does): a Warning, because both work and the picker tells
  Agents apart by file; `fromMars` writes Flow's own message for it. A retired restricting key
  (`permission`, `disallowed-tools`, `field.retired`) says the Agent "is not limited by it". Warnings
  that lose a restriction (`losesRestriction`) come first in a Save.
  Mars never speaks of a path Flow couldn't read: `checkFiles` gives Mars an empty file there and
  drops its findings on it, so `flow.file-unreadable` is the only finding about that file.
  Info is kept in the package status and stored rows (the editor marks a key "not in effect" from
  `field.unknown`); `shownFindings` (`@meridian/contracts/agents`) drops it, and every list, chip,
  count, Save result and the `save_agents` text goes through it. Flow adds only what
  Mars can't judge: its tool and permission rules, subagents, a skill that has an error, unreadable
  files, and a `[dependencies]` entry (`flow.dependency-missing`, `flow.dependency-unreadable`;
  Flow vendors none yet, so `dependencies` is passed empty, and a package that declares one fails
  its Save naming it). `dependency_diagnostics` is therefore always empty and unread until imports
  vendor dependencies.
  `checkPackage` (`domain/check-package.ts`) is the one place Save asks whether files can be
  published: it orders the package's errors and warnings for Save and says which items are left out.
- An unavailable Agent is stored with its diagnostics and no definition, so
  nothing can run it. `AgentRevision` is an available Agent; the store reads the
  runtime uses return only those, and `readThreadBinding` throws on a bound row
  with no definition. `CatalogRevision` is the row either way, for the catalog.
- Flow checks its own `harness-overrides.meridian-flow` block from the file as
  written (Mars returns it unchecked) and caps `permission` at `read` for
  `sandbox: read-only` anywhere in the file.
- `tools` rules come from Mars's `project` for `meridian-flow`; Flow adds no precedence or
  coverage logic. `allow` and `ask` names become `tools` when the file has an allow-list
  (`*: deny`), `[]` included; `deny` becomes `disallowed-tools`. A rule Mars calls `unknown` or
  `unscopable` makes the Agent unavailable with Mars's note; `absent` is met; `ask` runs as
  `allow` with a warning.
- A revision's key includes `GRAMMAR_VERSION` (the Mars version and Flow's
  `flow-N`). Whoever changes the availability table or the tool projection bumps
  `flow-N`. A revision an older reader compiled is read again with the running reader
  when something selects it; a binding keeps its revision, and a verdict is made once, at compile.
- Package files are UTF-8 text only (`Record<string, string>`).
- **A package is used only once it is saved.** The catalog reads each package's latest Save
  (`agent_package_saves`, append-only: the row with the highest `seq` is the saved version, a null
  revision means the package was removed), never the files. `package-levels.ts` builds the three
  levels from either source (`fromFiles`, `fromSaves`) and shares one compile cache by content
  digest; a saved version's package is read once per process by its immutable row id. A package is
  a level's own files (folder `""`) or one import (`packages/<name>/`, `splitLevel`).
- `save-packages.ts` is the one Save path, behind `POST /api/agents/save` (the writer) and the
  `save_agents` tool (the AI, `lib/model-tools/save-agents.ts`). Per package, independently:
  `checkPackage`. An error in one Agent's or skill's file stops that edit from being used and the
  rest saves: `keepLastGood` installs, for such an item, the files of its last saved version when
  that was usable (`kept` on the result; an Agent whose subagent or skill is broken is kept too
  when that does not fix it), and an item with no usable saved version is out (`leftOut`). The
  errors are listed first on the result. Only an error in `mars.toml`, which leaves nothing
  readable, fails the Save (`failed`, nothing written, the previous version stays). A Save installs
  exactly the cut `AgentLevelFiles.read` returned, which is one repeatable-read snapshot of the
  tree and of each document's admitted text, so the files are a state the level was in. No change
  is `unchanged`; otherwise `installSource` and a Save row. A failed Save is a result, never a
  refused write. A package's Saves and Undos are ordered by one transaction-scoped advisory lock
  per (owner, folder). `AgentRevisionStore.settleSave` is a Save's whole decision under it: it
  reads the latest Save row, applies the last-good rule, decides `unchanged` and adds the row in
  one transaction, so a concurrent Save is never put back by a decision made on an older read
  (only the captured file cut is read before the lock). `undoSave` runs in one transaction:
  after the stale check it prepares `AgentLevelFiles.prepareFiles` with create and delete off,
  then calls the prepared `applyFiles` to merge the previous save's text through the documents'
  own write path (`MarkdownDocumentStore.mergeCodeText`, which takes the document's durable
  mutation lock before it reads the live text and merges against what it holds then; base: that Save's text, target: the previous save's text; the writer's
  text wins where both changed the same text) and then adds the row, so a failure changes nothing
  and a stale Undo answers `undone: false` with `already-undone` or `later-save`.
  Undo rows record `undone_save_id`; Save rows record writer or AI origin. The files query
  offers Undo only for a latest non-Undo row with a predecessor. A first Save has no Undo.
  Save and Undo publish an agent-files hint after commit, even without document changes. Undo never creates or deletes a file. The user level's
  documents resolve from the account, not from `projectId`.
  `prepareFiles` binds creates outside transactions; its returned `applyFiles` runs inside the
  caller's transaction, after package Save locks. It takes the level's list lock before
  document mutation locks in id order. Creates share Copy's plan identities, binding and single
  tree submission, not its allocate-new-name policy: Apply uses the paths it receives unless
  obstructed. Deletion removes only a source document whose text still equals its base.
  An obstructed path (a folder, blocked ancestor, prose or binary document) keeps its occupant. With creation enabled a target lands at a settled name beside the obstruction;
  the result is `landed-elsewhere`, with requested `path`, `actualPath`, and one clash.
  Deletion at an obstructed path is `skipped`. Import and update callers record `actualPath`
  and use it next time: the adapter keeps no history of earlier calls. Results carry each file's
  outcome, resulting text, document identity and clash count. A deleted or newly occupied path
  between preparation and application is replanned under the list lock.
  A package's state (`saved`, `unsaved`, `cant-save`, `not-saved`, `removed`) is computed in
  `files()` from the files and the latest Save and stored nowhere, so it is not a state machine
  (`cant-save` is only a broken `mars.toml`). `unsaved` means a Save would change what is used: it
  compares the package as Save would install it (`keepLastGood`: an Agent or skill with a new
  Error at its last good saved version) with the latest Save, so an edit Save would hold back reads
  `saved`, with the file's own Not in use. `changes` is measured against the same package, so a
  `saved` package lists none.
- `list`, `resolvePrimary`, `userSkills` and `resolveSkill` read saved versions. A new chat binds the
  newest saved Agent of the selection's name; the selection's revision id is used only when that
  name is no longer saved, and then only if a Save of the account or the project (the caller has
  authorized it) points at its package (`readSavedRevision`), or it is a built-in. The same
  version also stands in when the newest one cannot run, so Send is not refused over a later Save. Definition rows
  are written when a chat binds or a skill is invoked, never when the picker lists; the picker's ids
  are computed (`agentRevisionId`) from the saved packages compiled in memory. Rows are immutable and
  shared by every account that has the same bytes; they are not collected yet.
- A level owns every name it contains, readable or not (`combine-agents.ts`): project over user over
  built-in; within a level the root wins silently over its packages, and two packages bringing one
  name are both renamed `name__package` while the bare name stays as an unavailable item. Rename uses
  the name before any rename for shadowing. All of it is computed over the saved versions, so a new
  project `critic` hides nothing until it is saved, and saving one import can rename another's Agent.
- `save_agents` is off by default: an Agent has it only when its `tools` rules name it
  (`tools: {save_agents: allow}`, `OPT_IN_TOOLS`). Mars's tool vocabulary has no name for it, so
  `compile-package.ts` reads those rules itself before `project` and writes the name into `tools`
  (the full catalog plus it when the file has no allow-list). It requires `packages`; it never
  means "all".
- `files` is read from the files, not the saves: every level's Agent and skill file, winner or not,
  with its reasons (errors only), its `change` since the saved version, whether the writer picks it (`pickable`: false for a subagent or a model-only skill, which are not
  broken), what it hides and what hides it (`layerByName`; `combineByName` is its winners), and every package's Save state. A
  file's own findings drop the file name. `savedFile` reads a file's text by that path as its package's latest Save holds it, a
  built-in's as shipped.
  Routes: `GET /api/agents/files`, `GET /api/agents/saved-file`.
- A chat's binding keeps its revision whatever is saved later, until the chat compacts. A skill invoked with `/` pins the files it was first read from; invoking it again reads the pin.
- `refreshBinding(userId, projectId, thread)` reads the binding a chat moves onto at a compaction (a child only off a removed model, below): the newest save of its Agent's name, only when what the chat would run differs: the compiled definition and configuration compared without package-version ids, so a Save that touched other files of the package moves nothing (an Agent that is gone, or whose newest save can't run, resolves to the bound revision), and each invoked skill pinned again when its own files' digest changed, whether or not the Agent moved (a skill no longer saved keeps its pin). A thread with a parent refreshes only off a model the host no longer offers: its configuration came from `resolveChildInvocation` with the parent's overrides, and `resolvePrimary` would rebuild it without them. So a subagent, and an Agent only ever spawned as one, stays on the version it started with until its model leaves the host. It writes no binding (it can install a package row, which is idempotent); the runtime writes the result with `replaceThreadBinding` inside the compaction's transaction, which leaves the invocation overlay and the chat's per-chat model override alone. A catalog read that fails during a compaction keeps the current binding and logs `binding_refresh.failed`. There is no Reload. `effectiveBinding` is the one rule for what a chat's next turn runs: the stored binding, unless the host no longer offers its model (`modelUnavailable`, model only) and a refresh moves it. `followRemovedModel` writes its result before a turn; `boundAgent` reports it. `boundAgent` backs the chat's read-only definition view and its Agent picker (`GET /api/threads/:id/agent`): the bound text, and, for the next turn's Agent, its selection, name, description, model and reasoning, whether it can run on that model now, and `stale` when a refresh would change the binding, a skill's newer save included. The picker builds the chat's own row from this alone, not from the catalog's newest save, which the chat doesn't run until it compacts.
- A level root with no `mars.toml` is a package named for the level. When package-wide tool
  rules are supported, deleting that manifest drops them.
- The adapter reads files one by one, so a multi-file Apply can be seen half done; an Agent's
  access comes from its own file and the chain takes the minimum, so this never widens one.
- **Fetching a tree** goes through the `PackageFetcher` port (`ports/package-fetcher.ts`): `fetchTree({ url, pin? }, budget)`
  returns the resolved commit SHA, the ref and import root the URL named, and the files as bytes under that root. A
  `pin` (the `commit`, `ref` and `path` an earlier fetch returned) makes the fetch read exactly that commit with no ref call, so import's second call matches inspect's and survives a deleted branch. A returned tree is read-only. `createGithubPackageFetcher`
  (wired in `lib/compose.ts` behind `createCachedPackageFetcher`, which keeps recent trees by URL and commit so a repeat
  costs no download) resolves the longest leading run of URL segments that names a branch or tag (one `matching-refs` call per kind), peels annotated tags to a
  commit, and streams `codeload.github.com`'s tarball through gunzip and a tar reader. One `FetchBudget` per import
  (`createFetchBudget`, limits in `FETCH_LIMITS`) is counted as bytes arrive; crossing one throws
  `FetchBudgetError` naming it (`download`, `expanded`, `entries`, `wall-time`). Every request hop must be on github.com,
  api.github.com or codeload.github.com, and `FLOW_GITHUB_TOKEN` goes only to api.github.com. Archive paths that are
  absolute, use `..` or repeat are refused; links are dropped and listed, files over 2 MB are dropped and listed, and
  files under `node_modules/`, `.git/`, `dist/` or `build/` directories, and archives are skipped without a word. A second adapter (a pack
  bundle answering a pinned commit) goes behind a wrapper that picks by URL; callers don't change. `./mf package fetch`
  reaches it through `GET /api/debug/package-fetch`.
- Callers authorize source, Project, and thread access before selecting or
  binding. Root, child, fork, handoff, and derived-primary creation bind through
  the threads domain's atomic operation.
- The store is an internal port, and app composition shares one transaction
  owner with thread repositories so a completed transaction cannot leak writes.

Checks: `tools/qa/probes/agents-through-mars/run.mts` (database) and
`tools/qa/agents-through-mars/server-gate.mts` (running stack); the fetch budgets by
[`qa/package-fetch.md`](qa/package-fetch.md).

[definitions]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md
[packages]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md#packages-and-availability
