# tools/deploy — versioned image promotion

The workflows build four digest-pinned OCI images once for a tagged release,
record the manifest on its GitHub Release, deploy those same digests to
staging, and permit a human-dispatched production promotion only after the
staging commit status is successful. Production rollback is dispatching an
older staging-verified version; migrations remain forward-only.

- `manifest.ts` owns release-manifest creation, validation, and byte-level
  SHA-256 for the workflows and deploy seam. `release-commit.ts` resolves tags
  to commit SHAs for deployment statuses.
- `deploy.ts` is the deployment seam: it confirms a target Neon branch snapshot
  before contacting Railway, then edits the server's `source.image` and
  `variables.MERIDIAN_BACKUP_REF.value` together. The ref is
  `neon-snapshot:<snapshot-id>:release=<manifest-sha>`; the image release
  command requires its SHA to match. It then promotes remaining Railway image
  digests and fails on every terminal non-success deployment state.
- `neon.ts` owns the Neon REST interaction. Only `scheduling`/`running` are
  pending; HTTP success is not enough: the operation must finish with zero
  failures, the created ID must match the listed snapshot, and its source
  branch must match before Railway is touched. Snapshot TTL defaults to 3 days
  in staging and 14 in production.
- `railway/configure.sh` is human-run at provisioning/settings changes. It
  batches stable healthchecks, lifecycle behavior, and non-secret references
  into one environment edit. It never owns `source.image`,
  `MERIDIAN_BACKUP_REF`, or secret values; set `DATABASE_URL` to the direct
  Neon TLS URL as a runtime secret.
- `smoke-check.ts` proves HTTP, readiness, release identity, login, websocket,
  and optionally www runtime behavior. Root must redirect to same-origin
  `/login…` or valid WorkOS authorization; root and login prove release headers.
  Ingress must route `/healthz` and `/readyz` to the server. The unauthenticated
  Yjs websocket must open, then close with code 4401 and reason `auth_failed`.
  A command that cannot prove its work
  must exit non-zero; missing config is never a successful stub.
- Workflow files own release image builds, manifests, GitHub status, and
  staging/production promotion gates.
