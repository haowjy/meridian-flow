# TODO

- `yjs-ws-handler.ts` (`classifyYjsConnectionAdmission`, `refuseConnection`,
  and the `onLoadDocument` backstop): these are the only places the server
  refuses a document connection. The
  [repair-first ruling](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/repair-first-never-disable.md)
  (2026-07-28) governs every change here — a refusal is only legitimate as
  the trigger for an automatic repair the client runs (4406 → reload). The
  4407 refusal has no automatic repair today; it is tolerable only because
  major bumps are ruled out of ordinary operation. Follow-up: if a major
  schema bump ever becomes real, build the migration path (load under
  compat, transform, restamp) and route this refusal into it — do not ship
  the bump with 4407 as the writer experience, and do not add any new
  refusal here without its automatic recovery.
