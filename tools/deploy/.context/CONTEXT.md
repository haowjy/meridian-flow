# tools/deploy — versioned image promotion

The workflows build four digest-pinned OCI images once for a tagged release,
record the manifest on its GitHub Release, deploy those same digests to
staging, and permit a human-dispatched production promotion only after the
staging commit status is successful. Production rollback is dispatching an
older staging-verified version; migrations remain forward-only.

- `deploy.ts` is the only provider-specific deployment seam; it edits Railway
  `source.image`, polls the new deployment, and fails on any non-success state.
- `railway/configure.sh` is human-run at provisioning/settings changes. It
  configures healthchecks, lifecycle behavior, and non-secret references; it
  never owns `source.image` or secret values.
- `smoke-check.ts` proves HTTP, readiness, release identity, login, websocket,
  and optionally www runtime behavior. The unauthenticated Yjs websocket must open, then close with code 4401 and reason `auth_failed`. A command that cannot prove its work
  must exit non-zero; missing config is never a successful stub.
- Workflow files own release image builds, manifests, GitHub status, and
  staging/production promotion gates.
