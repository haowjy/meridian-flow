# domains/packages

This domain reads Mars packages from the writer's Agent files, decides which Agents and skills
are available, retains immutable definitions for the chats bound to them, and resolves execution
configuration. The model
is in the [Agent definition][definitions] and [package][packages] pages.

## Contracts

- `domain/mars.ts` is the only module that imports `@meridian-flow/mars-schema`.
  Every Agent file, skill file and `mars.toml` is read by its `read`, never
  `prepare`, which upgrades an old file silently.
- A file with a Mars diagnostic of any severity defines nothing: its Agent is
  unavailable, a skill file is not a skill, and a `mars.toml` with one makes
  every Agent of the package unavailable. Severity says whether `mars sync`
  goes on, not whether a restriction survived. `compilePackage` holds the
  table of what makes an Agent available.
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
- The catalog is computed, never published. `bound-agent-catalog.ts` reads each level's files
  (built-in, `user://.agents/`, `agents://`; `ports/agent-level-files.ts`), splits the level
  into its root and `packages/<name>/` (`level-packages.ts`), compiles each with
  `compilePackage`, and combines Agents and skills by name (`combine-agents.ts`): project over
  user over built-in; within a level the root wins silently over its packages, and two packages
  bringing one name are both renamed `name__package` while the bare name stays as an
  unavailable item. A level owns every name it contains, readable or not: a broken, ambiguous or
  non-text file leaves its Agent in the level, unavailable, and it still hides the same name
  below (no fall-through; a prose document or two documents at one path is a `problems` entry
  of the level read). Rename uses the name before any rename for shadowing.
- Compile results are cached by content digest (bounded); a package is written to the store
  (`installSource`, idempotent) when a catalog read first offers its Agents or a skill is
  invoked, so a picker's selection (`{slug, definitionRevisionId}`) names a stored row. Rows are
  immutable and shared by every account that has the same bytes; they grow with observed edits
  and are not collected yet (they are small; a chat binding is the only reference).
- `files` is every level's Agent and skill file, winner or not, with its reasons, whether the
  writer picks it (`pickable`: false for a subagent or a model-only skill, which are not
  broken), what it hides and what hides it (`layerByName`; `combineByName` is its winners). A
  file's own findings drop the file name. `builtinFile` reads a built-in's text by that path.
  Routes: `GET /api/agents/files`, `GET /api/agents/builtin`.
- A selection pins the revision it showed: a chat binds exactly that revision, whatever the
  files say now. A skill invoked with `/` pins the files it was first read from; invoking it
  again reads the pin.
- A level root with no `mars.toml` is a package named for the level. When package-wide tool
  rules are supported, deleting that manifest drops them.
- The adapter reads files one by one, so a multi-file Apply can be seen half done; an Agent's
  access comes from its own file and the chain takes the minimum, so this never widens one.
- Callers authorize source, Project, and thread access before selecting or
  binding. Root, child, fork, handoff, and derived-primary creation bind through
  the threads domain's atomic operation.
- The store is an internal port, and app composition shares one transaction
  owner with thread repositories so a completed transaction cannot leak writes.

Checks: `tools/qa/probes/agents-through-mars/run.mts` (database) and
`tools/qa/agents-through-mars/server-gate.mts` (running stack).

[definitions]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md
[packages]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md#packages-and-availability
