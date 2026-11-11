# domains/packages

This domain parses and retains Mars packages, publishes immutable Agent
definitions, and resolves skills and execution configuration. The model is in
the [Agent definition][definitions] and [package][packages] pages.

## Contracts

- An unknown authoring allow-list name is refused, while an unknown deny-list
  name denies nothing. `permission` is not a tool.
- Catalog advancement requires an expected revision and retains old membership
  so a reserved first Send keeps its exact revision.
- Callers authorize source, Project, and thread access before selecting or
  binding. Root, child, fork, handoff, and derived-primary creation bind through
  the threads domain's atomic operation.
- The store is an internal port, and app composition shares one transaction
  owner with thread repositories so a completed transaction cannot leak writes.
- Project availability filters prospective selection only: bound execution and
  same-ID creation recovery do not recheck it.

[definitions]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md
[packages]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/agents/definitions.md
