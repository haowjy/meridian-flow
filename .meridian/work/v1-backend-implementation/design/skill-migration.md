> A3 foundation design

# Skill Migration

Dual-read precedence, legacy DB fallback, shadow file refresh, reference file migration, and the Round 2+ table drop plan.

## Dual-Read Conflict Resolution

Phase 1 dual-read behavior is strict:

- DB remains the sole mutation entrypoint for legacy skill CRUD.
- Runtime reads are file first.
- DB is fallback only when the file copy does not exist.
- If both file and DB exist and disagree, the file wins.

Why file wins:

- backfill creates the file copy specifically so the runtime can start consuming the future storage format
- imported skills may exist only in files
- allowing DB to override a present file would make the cutover nondeterministic

For legacy-managed skills, successful DB writes must immediately refresh the corresponding `.agents` shadow file. "DB is the Phase 1 write path" means callers mutate through the DB-backed service, not that the file copy is allowed to drift.

## Shadow File Refresh

The existing `ProjectSkillService` methods (Create, Update, Delete) gain a post-mutation shadow write inside the same `ExecTx` that performs the DB write. After any successful DB write, the service upserts the corresponding `.agents/skills/<slug>/SKILL.md` document within the same transaction.

DB-field-to-frontmatter mapping:

```go
func buildSkillFrontmatter(skill *domain.Skill) ([]byte, error)
```

| DB field | Frontmatter key | Transform |
|---|---|---|
| `Name` | `name` | direct copy |
| `Description` | `description` | direct copy |
| `Metadata.DisableModelInvocation` | `model_invocable` | `!DisableModelInvocation` |
| (none) | `user_invocable` | defaults to `true` |

On delete: soft-delete the shadow document in the same `ExecTx`.

Transaction boundary: the shadow write runs inside the same `ExecTx` as the DB write. If the shadow write fails, the entire mutation rolls back. This guarantees the DB row and the `.agents/` document never diverge within a single operation.

## Resolution Algorithm

`ResolveSkill(projectID, name)`:

1. Normalize `name` to slug.
2. Look for `.agents/skills/<slug>/SKILL.md`.
3. If the file exists:
   - parse and validate it
   - return the file-backed skill
   - if invalid, return validation error
4. If the file does not exist:
   - query `project_skills` by legacy name
   - if found, materialize a runtime skill from DB fields
5. If neither exists, return not found.

Listing behavior for runtime and Settings:

1. Enumerate all file-backed skill slugs under `.agents/skills/`
2. Parse and validate each file-backed skill, recording slug state as `valid` or `invalid`
3. Add valid file-backed skills to the resolved catalog
4. Query legacy DB skills
5. Add DB skills only when their normalized slug is not already present in the file scan, including invalid file-backed slugs
6. Report invalid file entries separately

That "reserve the slug even when invalid" rule is what keeps `skill_list`, `/skill`, and `ResolveSkill` consistent. If `.agents/skills/foo/SKILL.md` exists but is corrupted, `foo` must appear as invalid rather than disappearing behind a DB fallback row.

## Transition Timeline

| Round | Behavior |
|---|---|
| Round 0 / Phase 1 | Legacy CRUD writes DB and refreshes the file shadow; runtime reads file first |
| Round 1-2 | Settings UI reads file catalog and validates parity |
| Round 2+ | CRUD moves fully to files; DB writes stop; `project_skills` is dropped |

## Reference File Migration

Reference migration is copy-only in Phase 1:

- source: `/.meridian/skills/<legacy-name>/references/`
- destination: `.agents/skills/<slug>/resources/`

Why copy, not move:

- legacy code still expects the old location in Phase 1
- the Settings UI is not yet the sole management surface
- move semantics would make rollback harder

Phase plan:

- Phase 1: both locations exist
- Phase 1 runtime: file-native imports and future Settings use `resources/`
- legacy code: continues to read old reference location where needed
- Phase 2: after Settings UI validates parity, delete old reference trees and remove legacy readers

No bidirectional sync is attempted in Phase 1.

## What Gets Removed in Round 2+

After Settings can validate and edit the file tree directly:

- `project_skills` table
- legacy skill CRUD handlers and services
- `/.meridian/skills/<name>/references/`
- dual-read fallback logic
- deprecated `EnsureMeridianSubfolder("skills")` path

## Non-Goals for Phase 1

- full marketplace trust model
- file-native write UI for every agent and skill field
- bidirectional sync between legacy DB and `.agents/`
- support for binary assets inside imported bundles
- destructive cleanup of legacy storage
