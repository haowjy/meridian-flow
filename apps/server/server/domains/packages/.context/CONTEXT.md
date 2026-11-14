# domains/packages

This domain reads Mars packages, decides which Agents are available, publishes
immutable definitions, and resolves skills and execution configuration. The model
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
  `flow-N`. Boot republishes every package with no rows at the running version.
  A binding keeps its revision; a verdict is made once, at compile.
- Package files are UTF-8 text only (`Record<string, string>`).
- Catalog advancement requires an expected revision and retains old membership
  so a reserved first Send keeps its exact revision.
- Callers authorize source, Project, and thread access before selecting or
  binding. Root, child, fork, handoff, and derived-primary creation bind through
  the threads domain's atomic operation.
- The store is an internal port, and app composition shares one transaction
  owner with thread repositories so a completed transaction cannot leak writes.
- Project availability filters prospective selection only: bound execution and
  same-ID creation recovery do not recheck it.

Checks: `tools/qa/probes/agents-through-mars/run.mts` (database) and
`tools/qa/agents-through-mars/server-gate.mts` (running stack).

[definitions]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md
[packages]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md#packages-and-availability
