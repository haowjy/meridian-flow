// Shared admission fixture for durable inverse boundaries.
import { randomUUID } from "node:crypto";
import { testFileGrant } from "../../../test-support/file-grants.js";
import {
  ALPHA_ID,
  createHarness,
  type createTestDatabase,
  PROJECT_ID,
  schema,
  THREAD_ID,
  TURN_ID,
  WORK_ID,
} from "./change-trail-postgres-harness.js";
export async function inverseFixture(db: ReturnType<typeof createTestDatabase>) {
  const harness = createHarness(db),
    view = harness.crossWorkProbeFixture(),
    responseId = randomUUID();
  await db.insert(schema.modelResponses).values({
    id: responseId as never,
    turnId: TURN_ID,
    sequence: 1,
    provider: "mock",
    model: "mock",
    requestMessageCount: 1,
    predictedCacheState: "cold",
    predictedCacheReason: "facts_unavailable",
  });
  await harness.seedWriterDocument("Alpha Beta.\n\nBlue.", responseId);
  const context = {
    sessionId: THREAD_ID,
    threadId: THREAD_ID,
    turnId: TURN_ID,
    responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
    grant: testFileGrant({ kind: "draft", workId: WORK_ID, workSlug: "atomicity-work" }, ALPHA_ID),
  };
  const target = { projectId: PROJECT_ID as never, workId: WORK_ID, documentId: ALPHA_ID };
  return { harness, view, responseId, context, target };
}
