# Deployment tools

`deploy.ts` confirms the Neon snapshot before editing the server digest and
`MERIDIAN_BACKUP_REF`; the image release runner enforces that backup ref before
pending migrations. The immutable manifest is reused for staging and manual
production promotion. Runtime smoke is required before deployment status is
successful. See [`docs/deploy/README.md`](../../../docs/deploy/README.md) and
its runbook.
