# domains/packages

Owns Mars package parsing, import/export, definition editing, catalog projection,
and skill-reference resolution. A package contains `mars.toml`, Agent Markdown,
and skill directories with `SKILL.md` and supporting files.

## Source and compilation

- `domain/mars-source.ts` reads TOML and Markdown frontmatter, preserves structured
  Agent skills and field presence, and computes canonical source checksums.
  Frontmatter must be a mapping. Agent mode defaults are resolved by consumers.
- `domain/agent-definition-compiler.ts` validates declared configuration and emits
  a presence-sensitive definition with a versioned digest. Flat skills normalize
  to `skills.load`. Agent-specific body text becomes `systemPrompt`.
- Compilation accepts canonical frontmatter tools as lists or allow/deny maps.
  TOML overlays use `tools.allowed` and `tools.disallowed`; explicit empty lists
  clear that channel. A disallowed-list overlay replaces all baseline denials,
  including map-form denials; an allowed-list-only overlay retains them.
- Compilation is syntax validation. Runtime support, resource authorization,
  model resolution, and dependency binding belong to execution preparation.
  Unknown metadata is retained; acceptance does not establish its execution.
- Source checksums and compiled-definition digests have different purposes.
  Source checksums drive edited/pristine detection and include config overlays;
  compiled digests identify normalized definition content. Both sort object keys
  recursively and retain list order.

## Retained definition storage

`domain/agent-source-revision.ts` derives compiled definitions from the retained
file snapshot and TOML overlays. Source identity includes supporting files;
compiled identity describes the Agent configuration. Binary/NUL-containing
supporting files use base64 for JSONB storage.

`ports/agent-revision-store.ts` owns immutable source/definition records,
account/system catalog pointers, and fixed thread bindings.
`adapters/drizzle-agent-revision-store.ts` persists them in the
`agent-definition-revisions.ts` schema tables and joins the app's ambient
transaction. Source installs deduplicate by coordinate/digest. Catalog creation
is idempotent for the same revision; advancement requires an expected revision.
The current catalog pointer and retained `agent_catalog_revisions` membership
authorize exact selections. Pointer advancement retains the old membership in the
same transaction, allowing a reserved first Send to keep its revision without
authorizing unrelated account content. Removal hides selection while bound revisions remain readable. An explicit
owner restore requires the retained revision; ordinary saves leave removed entries hidden. Catalog pages
combine system and owned entries with a bounded name/keyset order.

The store is an internal persistence port. Callers authorize source/Project/thread
access and runtime support before selecting or binding. Null catalog ownership
is reserved for trusted system seeding. App services expose the revision port as
`agentRevisions`. The hermetic adapter and thread repositories share one snapshot transaction
owner in app composition. Either entry point commits or rolls back both stores;
completed transaction frames reject escaped writes. The live creation/runtime path still
consumes `PackageRepository` below; integration belongs to the milestone work.

`domain/bound-agent-catalog.ts` resolves exact primary selections and builds
catalog pages from immutable revisions. Listing and resolution share the supplied
host-support predicate. System-source publication uses one transaction-scoped
serialization boundary across the system catalog and rejects
cross-source logical-key collisions. Production startup seeds General through this
boundary with an empty Agent-specific body (the shared host prompt remains
authoritative) and a concrete configured default model. Changing that configured
model publishes a new revision and retains the former one.

## Package repository and editing

`ports/package-store.ts` defines `PackageRepository` and its transaction port.
Mutable records live in `domain/types.ts`: package installs, Agent definitions,
skills, user-installed skills, and Agent/skill links. Project definitions are
keyed by project and slug; builtin records use a null project.

`adapters/in-memory-package-store.ts` uses transaction-local cloned state and
commits on success. `adapters/drizzle-package-store.ts` currently delegates to
that in-memory implementation, including in production composition. Records and
revision history therefore do not survive server restart.

`domain/definition-editing.ts` appends definition history on save/restore and
updates the live row. Agent skill ordering comes from the declared flat list;
operational link invocation flags are preserved across reconciliation. Current
runtime lookup consumes live records by slug.

## Import, export, and resolution

- `domain/package-sync.ts` resolves local-path dependencies and writes an import
  transaction. Remote dependencies are reported as unsupported. Updates replace
  pristine content, preserve locally edited items unless force-reset, and retain
  dependencies referenced by preserved Agents.
- `domain/package-export.ts` reconstructs the package file map for export;
  `sourcePath` is repository metadata and is excluded.
- `domain/skill-files.ts` owns supporting-file encodings and checksums.
- `domain/resolution.ts` merges builtin, user, project/global, and linked skills.
  Linked skills and operational invocation overrides are live repository state.
- Runtime consumes the catalog through `runtime/tools/agent-thread-context.ts`
  and `runtime/tools/skill-tools.ts`. Skill catalog descriptions are rendered;
  executable skill loading is disabled. Source preservation of structured
  channels does not implement their loading behavior.

Errors propagate through the existing calling boundary. Repository operations
and parser/compiler validation do not independently authorize resources.
