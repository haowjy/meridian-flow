> A3 foundation design

# Agent Import

Git import flow for agents and skills: security requirements, DNS rebinding mitigation, host policy, import semantics, collision policy, structure validation, and backfill.

## Git Import

Git import is a backend service, not a direct filesystem clone. It clones to a temp directory, stages a complete manifest, validates the final post-import tree, then applies the approved batch to the project's `.agents/` folder in a single DB transaction.

### Security requirements

Every import must enforce all of the following before any document write:

- HTTPS-only remote URLs
- reject `git://`, `ssh://`, `file://`, bare SCP syntax, and local paths
- resolve all A and AAAA records for the hostname before clone
- reject the import when resolution returns zero records
- reject the import when any resolved record is loopback, RFC 1918 private, IPv6 ULA, link-local, multicast, or otherwise non-public
- pin the validated IP set for the actual outbound git connection; do not re-resolve during clone
- clone with `--depth 1 --no-recurse-submodules`
- reject submodules even if present in the repo metadata
- enforce total clone size cap of `50 MB`
- enforce per-file size cap of `1 MB`
- reject symlinks
- reject binary files
- validate `.agents/` structure after clone and before import

The SSRF check applies to the resolved host, not just the URL string. DNS resolution is part of validation, and the validated resolution result must be the one actually used for the network connection.

### DNS rebinding mitigation

DNS rebinding protection is mandatory because a one-time DNS check is insufficient if the clone step performs a fresh lookup.

Use a custom `net.Dialer` with a `DialContext` that resolves the hostname, checks all A/AAAA records against RFC 1918/loopback ranges, and pins the resolved IP for the connection. The dialer preserves TLS verification against the original hostname while connecting to the validated IP. This gives the fetcher full control over DNS resolution and eliminates the window between validation and connection.

Running the raw `git` CLI against the original hostname without a pinned dial path is not sufficient for Phase 1 because it can re-resolve after validation and bypass the SSRF check.

### Host policy

Phase 1 does not hardcode a marketplace-only allowlist, but the interface supports both:

- `AllowedHosts`: optional allowlist, empty means allow all public hosts
- `BlockedHosts`: optional denylist, applied before allowlist success

This supports a future marketplace mode without changing the service boundary.

### Import semantics

Import is atomic at the service layer and must follow a stage-then-commit flow:

1. clone remote into temp dir
2. extract only `.agents/` files into an in-memory staged manifest of target folders, documents, and parsed frontmatter
3. validate remote, structure, security rules, frontmatter, cross-file references, and collision policy against the current project tree
4. materialize the final post-import tree in memory after applying the requested collision policy
5. if any fatal validation issue exists, return `422` and do not write
6. apply the entire import plan inside one `ExecTx` transaction
7. if any folder or document write fails, rollback the transaction and return an error

`ExecTx` is the hard boundary for "no partial `.agents/` state." Import must not call a per-file helper that commits independently. The batch applier must use tx-aware repository operations so the create/update set for `.agents/agents/**` and `.agents/skills/**` commits or rolls back as one unit.

Imported content is allowed to target system folders. That is intentional. `.agents/` is a first-class writable namespace, and import must use the normal `.agents/` write path rather than a privileged bypass so the existing system-folder policy remains authoritative.

### Import collision policy

Import collisions are resolved per target path after staging and before commit:

- request field: `collision_policy`
- allowed values: `overwrite`, `skip`
- default: `overwrite`
- overwrite means the staged document replaces the existing `.agents/` document or resource at that exact path
- skip means the existing project document wins and the staged entry is omitted from the commit plan
- type conflicts that cannot be reconciled safely, such as an existing document where the import requires a folder, remain `409 Conflict`

Validation always runs on the final post-policy tree snapshot. Overwrite does not bypass validation. The imported replacement must itself parse and validate, and the merged resulting tree must still satisfy path, schema, and reference rules before `ExecTx` begins.

### Git import domain abstraction

The import service must depend on a domain interface, not a concrete git implementation:

```go
package agents

import "context"

var (
    ErrNotHTTPS     = errors.New("agents: URL scheme must be HTTPS")
    ErrBlockedHost  = errors.New("agents: host is blocked by policy")
    ErrSSRFDetected = errors.New("agents: resolved address is not public (SSRF)")
)

type CloneOptions struct {
    AllowedHosts []string
    BlockedHosts []string
    MaxRepoBytes int64
    MaxFileBytes int64
}

type CloneResult struct {
    Dir     string
    Cleanup func()
}

type ValidateOptions struct {
    AllowedExtensions []string
}

type ValidateResult struct {
    Issues []ValidationIssue
}

type ImportCollisionPolicy string

const (
    ImportCollisionOverwrite ImportCollisionPolicy = "overwrite"
    ImportCollisionSkip      ImportCollisionPolicy = "skip"
)

type ValidationIssue struct {
    Path     string
    Code     string
    Message  string
    Severity string
}

type GitFetcher interface {
    ValidateURL(ctx context.Context, rawURL string) error
    Clone(ctx context.Context, url string, opts CloneOptions) (*CloneResult, error)
    Validate(ctx context.Context, dir string, opts ValidateOptions) (*ValidateResult, error)
}
```

`ValidateURL` checks scheme, host policy, and DNS resolution. It returns `ErrNotHTTPS`, `ErrBlockedHost`, or `ErrSSRFDetected` on failure. `Clone` returns a `CloneResult` containing the temp directory and a cleanup function the caller must defer. `Validate` performs structure and safety validation over the cloned contents, including `.agents/` schema checks.

The concrete implementation may use the `git` binary only if the network path is pinned through a controlled dialer that enforces the validated host-to-IP mapping. Otherwise the implementation should use a fetcher that owns DNS resolution and dialing directly. The service consumes only `GitFetcher`.

## Structure Validation

Validation runs on the temp clone before any project write:

- repository must contain `.agents/`
- `.agents/skills/` entries must be directories
- each skill directory must contain exactly one `SKILL.md`
- `.agents/agents/` entries must be regular `.md` files
- no nested `.git` directories
- no path traversal segments
- no symlinks anywhere under `.agents/`
- only text files are allowed in Phase 1: detect binary files by scanning the first 8192 bytes for null bytes; additionally, only allow files with text-format extensions: `.md`, `.txt`, `.yaml`, `.yml`, `.json`; reject all other extensions in Phase 1

Files outside `.agents/` are ignored by import.

Validation also runs against the computed post-import tree, not just the clone contents:

- no duplicate normalized skill slugs in the final tree
- no duplicate agent slugs in the final tree
- agent `skills` references must resolve against the final tree snapshot, not just the imported subset
- overwrite and skip decisions must be reflected in that final-tree validation before commit

## Backfill

Backfill migrates legacy DB-backed skills into `.agents/skills/` without breaking existing routes.

### Backfill rules

- idempotent per project
- safe to retry after partial failure
- uses privileged system-folder writes
- writes only missing files
- never deletes legacy DB rows or legacy reference files in Phase 1

### Algorithm

1. ensure `.agents/` exists
2. ensure `.agents/skills/` exists
3. list active `project_skills`
4. for each skill:
   - normalize `skill.Name` to slug
   - if `.agents/skills/<slug>/SKILL.md` already exists, skip document creation
   - otherwise create `SKILL.md` with generated frontmatter + DB content
   - copy legacy references into `.agents/skills/<slug>/resources/` when target files do not already exist
5. update backfill completion metadata

Backfill does not overwrite an existing `.agents` skill. Existing file content is treated as the newer source.

### Privileged context

Backfill is backend-controlled maintenance work, not a user or agent edit. It must use a privileged path that:

- can create documents inside `.agents/`
- bypasses review gating and reserved-name checks needed only for untrusted callers
- still runs inside a transaction boundary for each skill's document and resource creation

This matches the same privileged bootstrap path used when system folders are created at project creation time.

### Crash recovery and completion tracking

Progress is tracked on the `.agents/` system folder metadata:

- `agents_skills_backfill_version`
- `agents_skills_backfill_completed_at`
- `agents_skills_backfill_counts`

That metadata is advisory, not authoritative. The operation remains idempotent because the true guard is file existence:

- if `SKILL.md` exists, skip it
- if a copied resource already exists, skip it

The admin endpoint returns a structured summary so an interrupted run can be retried safely.

## API Contracts

### Import agents and skills from git

`POST /api/projects/{projectId}/agents/import-git`

Request:

```json
{
  "url": "https://github.com/example/fiction-agents.git",
  "collision_policy": "overwrite"
}
```

Response `200`:

```json
{
  "imported_agents": 2,
  "imported_skills": 5,
  "imported_resources": 8,
  "overwritten": 3,
  "skipped": 0,
  "warnings": []
}
```

Errors:

- `400` malformed URL
- `401` unauthenticated
- `403` project access denied
- `409` imported path collides with an existing document that cannot be merged
- `422` validation failure, unsafe repo, invalid frontmatter, invalid structure, binary file, symlink, size cap exceeded

Import failure is atomic. No partial writes.

### Admin backfill trigger

`POST /api/admin/projects/{projectId}/agents/backfill`

Purpose: one-shot or retryable migration endpoint for Phase 1 rollout.

Response `200`:

```json
{
  "project_id": "proj_123",
  "skills_total": 4,
  "skills_created": 3,
  "skills_skipped": 1,
  "resources_copied": 6,
  "completed_at": "2026-03-20T15:04:05Z"
}
```

Errors:

- `401` unauthenticated
- `403` non-admin caller
- `404` project not found
- `409` another backfill is already running for the project
- `422` generated file content failed validation
