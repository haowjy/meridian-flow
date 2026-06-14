# domains/storage — Object store

Binary object storage behind a port. Callers persist stable storage URLs into
relational rows; renderers ask the store for short-lived read URLs when bytes
are needed. No figure, profile-image, or domain semantics — just bytes.

## What it owns

- **`ObjectStorePort`** — the `put`/`getSignedUrl`/`delete` contract every
  adapter implements.
- **`object://` URL scheme** — stable, non-expiring reference persisted by
  callers (`object://meridian/<key>`). `createObjectStorageUrl(key)` and
  `objectStoreKeyFromStorageUrl(storageUrl)` are the only producers and
  consumers.
- **Three adapters** — `local` (filesystem, signed HMAC tokens), `s3`
  (MinIO/S3/R2 via `@aws-sdk/client-s3`, presigned URLs), `in-memory` (tests).
- **Adapter selection** — `compose.ts` reads `OBJECT_STORE_PROVIDER` (`local`
  or `s3`) and constructs the corresponding adapter. No domain code branches on
  provider.

## Contracts (ports)

| Port | Verbs |
|---|---|
| `ObjectStorePort` | `put(key, bytes, mimeType) → Result<{ storageUrl }>` / `getSignedUrl(key) → Result<string>` / `delete(key) → Result<void>` |

All operations return `ObjectStoreResult<T>` — a tagged `ok`/`error` union.
Errors carry `ObjectStoreErrorCode` (`invalid_key`, `not_found`, `io_error`)
and a message. No throws at the port boundary.

Object keys must match `^[a-zA-Z0-9][a-zA-Z0-9/_:+=.,@-]*$` and contain no `..`
or empty segments. Keys that escape the storage root (local adapter) are
rejected.

## Adapters

| Adapter | File | Env-driven? | Read-URL strategy |
|---|---|---|---|
| `InMemoryObjectStoreAdapter` | `adapters/in-memory/` | No (test-only) | Fake `/memory-object-store/<key>` path |
| `LocalObjectStoreAdapter` | `adapters/local/` | Yes (`OBJECT_STORE_PROVIDER=local`) | HMAC-signed tokens with TTL |
| `S3ObjectStoreAdapter` | `adapters/s3/` | Yes (`OBJECT_STORE_PROVIDER=s3`) | `@aws-sdk/s3-request-presigner` presigned GET URLs |

### Local adapter

Files stored under `LOCAL_OBJECT_STORE_DIR` with sibling `.metadata.json` files.
Read URLs are HMAC-SHA256 signed tokens (`<payload>.<signature>`) served through
`LOCAL_OBJECT_STORE_SIGNED_URL_BASE_PATH`. The adapter exposes
`readSignedToken(token)` for the route handler that streams the file back.

### S3 adapter

Same `@aws-sdk/client-s3` code path in dev and production — only the endpoint
and credentials differ. Reads `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`,
`S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_FORCE_PATH_STYLE`, and
`S3_CREATE_BUCKET_IF_MISSING` from the environment. Presigned read URLs use
`S3_PUBLIC_ENDPOINT` when the browser cannot reach `S3_ENDPOINT` directly (e.g.
an HTTPS proxy in front of MinIO). Signed URL TTL is
`OBJECT_STORE_SIGNED_URL_TTL_SECONDS` (default 900s).

Bucket creation on first use (`createBucketIfMissing`) is a dev/MinIO
convenience — never enabled in production.

### In-memory adapter

For tests only. Stores bytes in a `Map`. `getSignedUrl` returns a fake path;
no actual serving layer.

## Dev workflow — per-worktree bucket isolation

`S3_BUCKET` is isolated per worktree through the same mechanism as dev
databases (`tools/dev/lib/dev-env.ts`): `print-worktree-env.ts` rewrites
`S3_BUCKET` from the main checkout's base name to `<base>-<slug>` (hyphen
separator — S3 buckets disallow underscores). The main checkout uses the bare
bucket name. See [`tools/dev/.context/CONTEXT.md`](../../../../../../tools/dev/.context/CONTEXT.md).

Dev defaults in `.env.example` point at MinIO (`S3_ENDPOINT=http://localhost:9000`,
`minioadmin` credentials, path-style addressing, auto-create enabled).

## Wiring

`compose.ts` → `createObjectStoreFromEnv()` reads `OBJECT_STORE_PROVIDER` and
returns `{ objectStore, localObjectStore }`. The `objectStore` (the port) is
injected into domain services; `localObjectStore` is `null` in S3 mode and used
by the local signed-URL serving route.

## Invariants

- **Storage URLs are stable.** `createObjectStorageUrl(key)` produces a URL
  that callers persist forever. Read URLs are short-lived and never persisted.
- **No domain semantics.** This module doesn't know what a figure, profile
  image, or attachment is. It knows bytes, keys, and MIME types.
- **Keys are validated at the port boundary.** Both adapters call `isSafeKey`
  before any I/O.
- **Fallible operations return results, not throws.** Callers handle
  `ObjectStoreError` explicitly.
