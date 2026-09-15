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

## Repository and editing

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
