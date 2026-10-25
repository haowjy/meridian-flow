/** POST /api/diagnostics/failures — bounded, account-fenced diagnostic metadata only. */
import { assertBodySize, defineEventHandler, readBody } from "nitro/h3";
import { requireAppUser } from "../../../lib/auth-gate.js";
import { ingestClientFailures } from "../../../lib/client-failures-route.js";
import { getProcessEventSink } from "../../../lib/observability.js";
export default defineEventHandler(async (event) => {
  const { app, user } = await requireAppUser(event);
  await assertBodySize(event, 32 * 1024);
  return ingestClientFailures(
    { threads: app.threadRepos.threads, turns: app.threadRepos.turns, sink: getProcessEventSink() },
    user.userId,
    await readBody(event),
  );
});
