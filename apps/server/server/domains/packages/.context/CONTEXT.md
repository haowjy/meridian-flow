# domains/packages

Owns Mars package parsing, import/export, definition editing, catalog projection,
and skill-reference resolution. A package contains `mars.toml`, Agent Markdown,
and skill directories with `SKILL.md` and supporting files.

Keep the identities distinct: a retained source revision is the complete
exportable file snapshot; a definition revision is one compiled Agent within
that snapshot; a catalog entry selects a definition revision for future chats;
and a thread binding fixes a definition revision plus resolved configuration for
one conversation. `agent_package_installations` records management head/history
over retained source revisions. It is not a fifth content or execution owner.

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
  model resolution, and dependency binding belong to the retained configuration resolver before conversation creation.
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

`domain/agent-configuration.ts` resolves the configured default model and skill/named-target identities over the retained package dependency graph. Missing or ambiguous references refuse binding; it never consults mutable package installs.

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
completed transaction frames reject escaped writes. Root creation resolves exact
account/system selections and binds atomically. Shared runtime preparation reads
the retained binding. Child creation consumes exact targets from the parent binding. Root, child and derived-primary creation use the threads domain's atomic bound-conversation operation.

`domain/bound-agent-catalog.ts` resolves exact primary selections and builds
catalog pages from immutable revisions. Listing and resolution share the supplied
host-support predicate. Publication uses one owner-scoped transaction boundary (system or account) and rejects
cross-source logical-key collisions. Production startup seeds General through this
boundary with an empty Agent-specific body (the shared host prompt remains
authoritative) and a concrete configured default model. Changing that configured
model publishes a new revision and retains the former one.

Standalone `POST /api/agents` publishes personal source directly through this owner. Saves require the prior revision for advancement; conflicts roll back the source install. Runtime support can make a preserved definition unavailable without pretending its semantics execute.

## Source management

`domain/source-publication.ts` is the atomic publication owner for standalone save,
package import/update/edit/restore and trusted system provisioning. It installs
immutable source, validates retained references, advances exact future-chat
pointers and commits the installation head/history under the same owner lock.
Removed entries remain hidden on ordinary publication. Source collisions refuse
the complete import with an actionable rename diagnostic, preserving existing content.

`agent_package_installations` is account/system management provenance: current
edited source, upstream pristine source and fetch origin. Its history authorizes
restore from owned source only, including definitions pruned from the current snapshot. It is never an execution lookup. All definitions
and skill files live exclusively in retained snapshots; there are no mutable
Agent/skill records or operational link overrides.

`package-source.ts` materializes local/GitHub dependency graphs before writes,
preserving supported files and binary data. Explicit downloaded provenance confines local dependencies to their fetched tree;
URL spelling never grants local filesystem trust. `package-management.ts` imports and reconciles the
retained graph. Updates keep locally edited entities and references unless reset. Keeping an edited
Agent retains its dependency closure; incompatible upstream additions refuse atomic
publication rather than silently changing those references;
removed pristine definitions leave retained history but no future-chat selection.
`definition-editing.ts` edits or restores one entity within that complete source.
The skill-availability edit versions `skills.available`; it does not activate
runtime skill loading. `package-export.ts` exports retained files without
reconstructing source from normalized definitions.

Project-addressed management routes still authorize access to that Project; the
owned package content belongs to the authenticated account and is reusable across
Projects. Source fetching stays outside owner transactions. Production seeds
General and configured first-party packages into the system catalog at startup,
not during Project creation. General replaces the old `<none>` entry.

## Project availability

`project_agent_removals` excludes stable catalog-entry IDs from one Project's
prospective list and primary selection admission. Shared publication/seeding never
clears exclusions. General is the only non-removable system entry. Routes authorize
the Project before listing/removal; root, handoff and fork selection pass its ID.
Previously bound execution and same-ID creation recovery do not recheck prospective
availability. Removal does not delete source or change account ownership.
