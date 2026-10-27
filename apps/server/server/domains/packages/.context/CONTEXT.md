# domains/packages

This domain parses and retains Mars packages, publishes immutable Agent
definitions, and resolves skills and execution configuration. Keep four
identities distinct: a source revision is the complete exportable snapshot, a
definition revision is one compiled Agent, a catalog entry selects a revision,
and a thread binding fixes a revision plus resolved configuration.

## Compilation and configuration

`mars.toml`, Agent Markdown, and skill files are parsed into a canonical source
snapshot. Compiled-definition digests identify normalized Agent content and
canonicalize object-key order while retaining list order. Unknown metadata is
retained, but compilation is syntax validation only: runtime support,
authorization, model resolution, and dependency binding happen in the retained
configuration resolver.

Execution-knob schemas are canonical in `@meridian/contracts/agents`; this
domain consumes them rather than redefining effort, permission, aliases, or
tool-list shapes. `tools` and `disallowed-tools` are lists of names. Mars
aliases fold before validation, `permission` is not a tool, and an unknown
authoring allow-list name is refused while an unknown deny-list name denies
nothing. Missing or ambiguous retained skill/target references refuse binding.

## Retention and publication

All Agent definitions and package skill files live in retained snapshots; there
are no mutable operational Agent records. The revision store owns immutable
source/definition rows, account/system catalog pointers, retained catalog
membership, and fixed thread bindings. Catalog advancement requires an
expected revision and retains old membership so a reserved first Send keeps
its exact revision. Removal hides selection but leaves bound revisions
readable; explicit restore names the retained revision.

`source-publication.ts` is the atomic owner for publishing a source and for
system provisioning. It validates the complete retained graph, advances
future-chat pointers, and commits installation history under one owner lock. A
source collision (found from file paths alone) refuses the publication rather
than silently renaming or partially applying it. Startup seeds the built-in
launch-agent directory as one snapshot. No route imports, updates, or edits a
package today; export reads the retained files.

Account-installed skills are separate user-slash inventory, not package
content, prompt-list entries, or replacements for retained skill files.
Exports read retained files rather than reconstructing them from normalized
definitions.

## Thread and project boundaries

Callers authorize source, Project, and thread access before selecting or
binding. Root, child, fork, handoff, and derived-primary creation bind through
the threads domain's atomic operation. A generic child has no definition
revision and uses the host-owned generic identity; a named child consumes an
exact target from its parent's retained binding. The store is an internal
port, and app composition shares one transaction owner with thread
repositories so a completed transaction cannot leak writes.

Project availability is a separate prospective-selection filter. Removing an
entry hides it for that Project but does not delete source, change account
ownership, or invalidate already-bound execution. Stable catalog-entry IDs are
the exclusion keys, shared publication does not clear exclusions, and General
is the only non-removable system entry. Routes authorize the Project before
listing/removal; root, fork, and handoff selection pass the Project ID. Bound
execution and same-ID creation recovery do not recheck prospective availability.

Project-addressed management routes authorize the Project, but owned package
content belongs to the authenticated account and can be reused across Projects.
