/** One caller/child execution graph and report operations, shared by both adapters and terminal A/B tests. */
import { buildInvocationCardContent } from "@meridian/contracts/components";
import type { ReturnResultCapture } from "@meridian/contracts/spawn";
import type { Database } from "@meridian/database";
import { conformanceUserValues } from "@meridian/database/__test-support__/db-fixtures";
import * as schema from "@meridian/database/schema";
import { invocationCardProps } from "../domains/runtime/spawn/spawn-output.js";
import { createDrizzleRepositoriesForTest } from "../domains/threads/adapters/drizzle/repositories.js";
import { createInMemoryRepositories } from "../domains/threads/adapters/in-memory/repositories.js";
import type {
  AdmitExecutionReportInput,
  FinalizeExecutionReportInput,
} from "../domains/threads/ports/repositories.js";

type ExecutionIds = {
  user: string;
  project: string;
  caller: string;
  callerTurn: string;
  child: string;
  childUserTurn: string;
  execution: string;
  card?: string;
} & ({ root?: never; rootTurn?: never } | { root: string; rootTurn: string });
function executionIds(): ExecutionIds {
  return Object.fromEntries(
    ["user", "project", "caller", "callerTurn", "child", "childUserTurn", "execution"].map(
      (key) => [key, crypto.randomUUID()],
    ),
  ) as ExecutionIds;
}
export async function executionScenario(db?: Database, ids = executionIds()) {
  const repos = db ? createDrizzleRepositoriesForTest(db) : createInMemoryRepositories();
  if (db) {
    await db.insert(schema.users).values(conformanceUserValues(ids.user, "execution"));
    await db
      .insert(schema.projects)
      .values({ id: ids.project, userId: ids.user, name: "Reports", slug: "reports" });
    if (ids.root) {
      await db
        .insert(schema.threads)
        .values({ id: ids.root, projectId: ids.project, createdByUserId: ids.user, ref: "c1" });
      await db
        .insert(schema.turns)
        .values({ id: ids.rootTurn, threadId: ids.root, role: "assistant", status: "complete" });
    }
    await db.insert(schema.threads).values([
      {
        id: ids.caller,
        projectId: ids.project,
        createdByUserId: ids.user,
        ref: ids.root ? "p0" : "c1",
        ...(ids.root
          ? {
              kind: "subagent",
              parentThreadId: ids.root,
              rootThreadId: ids.root,
              originTurnId: ids.rootTurn,
              originType: "spawn",
              spawnStatus: "succeeded",
            }
          : {}),
      },
      {
        id: ids.child,
        projectId: ids.project,
        createdByUserId: ids.user,
        ref: "p1",
        kind: "subagent",
        parentThreadId: ids.caller,
        rootThreadId: ids.root ?? ids.caller,
        originTurnId: ids.callerTurn,
        originType: "spawn",
        spawnStatus: "running",
      },
    ]);
  } else {
    await repos.threads.create({ id: ids.caller, userId: ids.user, projectId: ids.project });
    await repos.threads.createSubagent({
      id: ids.child,
      userId: ids.user,
      projectId: ids.project,
      parentThreadId: ids.caller,
      rootThreadId: ids.caller,
      originTurnId: ids.callerTurn,
      spawnDepth: 1,
    });
  }
  await repos.turns.create({
    id: ids.callerTurn,
    threadId: ids.caller,
    role: "assistant",
    status: "complete",
  });
  await repos.turns.create({
    id: ids.childUserTurn,
    threadId: ids.child,
    role: "user",
    status: "complete",
  });
  await repos.turns.create({
    id: ids.execution,
    threadId: ids.child,
    prevTurnId: ids.childUserTurn,
    role: "assistant",
    status: "streaming",
  });
  if (ids.card)
    await repos.blocks.create({
      id: ids.card,
      turnId: ids.callerTurn,
      blockType: "custom",
      sequence: 7,
      content: buildInvocationCardContent(
        invocationCardProps({
          agent: "critic",
          correlation: {
            parentTurnId: ids.callerTurn,
            toolCallId: "spawn-1",
            deliveryMode: "background_notification",
          },
          childThreadId: ids.child,
          execution: null,
        }),
      ),
    });
  const input: AdmitExecutionReportInput = {
    childThreadId: ids.child,
    assistantTurnId: ids.execution,
    handle: (await repos.threads.findById(ids.child))?.ref ?? "",
    origin: "spawn",
    deliveryMode: "background_notification",
    callerThreadId: ids.caller,
    callerTurnId: ids.callerTurn,
    toolCallId: "spawn-1",
    cardBlockId: ids.card ?? null,
    ...(ids.card ? { agentSlug: "critic" } : {}),
  };
  return {
    ids,
    repos,
    input,
    admit: (changes: Partial<AdmitExecutionReportInput> = {}) =>
      repos.executionReports.admit({ ...input, ...changes }),
    capture: (capture: ReturnResultCapture, toolCallId = "return-1") =>
      repos.executionReports.captureOnce(ids.child, ids.execution, toolCallId, capture),
    finalize: (changes: Partial<FinalizeExecutionReportInput> = {}) =>
      repos.executionReports.finalizeOnce({
        childThreadId: ids.child,
        assistantTurnId: ids.execution,
        outcome: "succeeded",
        reason: null,
        source: "return_result",
        summary: "saved",
        ...changes,
      }),
    read: () => repos.executionReports.findByExecution(ids.child, ids.execution),
  };
}
export type ExecutionScenario = Awaited<ReturnType<typeof executionScenario>>;
