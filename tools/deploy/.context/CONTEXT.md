# tools/deploy — versioned image promotion

The workflows build four digest-pinned OCI images once for a tagged release,
record the manifest on its GitHub Release, deploy those same digests to
staging, and permit a human-dispatched production promotion only after the
staging commit status is successful. Production rollback is dispatching an
older staging-verified version; migrations remain forward-only.

- `deploy.ts` is the deployment seam: it confirms a target Neon branch snapshot
  before contacting Railway, then edits the server's `source.image` and
  `variables.MERIDIAN_BACKUP_REF.value` together. The ref is
  `neon-snapshot:<snapshot-id>:release=<manifest-sha>`; the image release
  command requires its SHA to match. It then promotes remaining Railway image
  digests and fails on every terminal non-success deployment state.
- `neon.ts` owns the Neon REST interaction. HTTP success is not enough: the
  snapshot operation must finish with zero failures and the named snapshot
  must appear on the expected branch before Railway is touched.
- `railway/configure.sh` is human-run at provisioning/settings changes. It
  batches stable healthchecks, lifecycle behavior, and non-secret references
  into one environment edit. It never owns `source.image`,
  `MERIDIAN_BACKUP_REF`, or secret values; set `DATABASE_URL` to the direct
  Neon TLS URL as a runtime secret.
- `smoke-check.ts` proves HTTP, readiness, release identity, login, websocket,
  and optionally www runtime behavior. Ingress must route `/healthz` and `/readyz` to the server. The unauthenticated Yjs websocket must open, then close with code 4401 and reason `auth_failed`. A command that cannot prove its work
  must exit non-zero; missing config is never a successful stub.
- Workflow files own release image builds, manifests, GitHub status, and
  staging/production promotion gates.
