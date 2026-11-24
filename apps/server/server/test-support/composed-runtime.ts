import { randomUUID } from "node:crypto";
import { toolContentText } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { modelResponses, observationFrontiers, threads } from "@meridian/database/schema";
import { and, asc, eq, gt } from "drizzle-orm";
import { afterEach } from "vitest";
import type { EventSink } from "../domains/observability/index.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import { TREE_NAMES_ROOM } from "../domains/runtime/index.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import { composeAppServices, createProductionAppPorts } from "../lib/compose.js";

type ComposedRuntime = Awaited<ReturnType<typeof composeRuntime>>;
type RuntimeThread = { threadId: string; turnId: string };
export type ToolCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolExecutionResult>;
type ToolCallText = (name: string, args: Record<string, unknown>) => Promise<string>;

async function composeRuntime(db: Database, eventSink: EventSink) {
  const ports = await createProductionAppPorts({
    db,
    eventSink,
    environment: { FLOW_OPENAI_API_KEY: "sk-test-runtime-composition" },
  });
  const app = composeAppServices(ports);
  return { ports, app };
}

export async function bindEditAgent(runtime: ComposedRuntime, threadId: string): Promise<void> {
  if (await runtime.ports.agentRevisions.readThreadBinding(threadId)) return;
  await runtime.ports.agentRevisions.bindThread(
    threadId,
    null,
    {
      model: "mock-model",
      skills: { load: [], available: [] },
      namedTargets: [],
      permission: "edit",
    },
    null,
  );
}

export function useComposedRuntimes(db: () => Database) {
  const runtimes: ComposedRuntime[] = [];
  const sequences = new Map<string, number>();
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await runtime.app.shutdown();
    }
  });

  async function compose(options: { eventSink?: EventSink } = {}): Promise<ComposedRuntime> {
    const runtime = await composeRuntime(db(), options.eventSink ?? createNoopEventSink());
    runtimes.push(runtime);
    return runtime;
  }

  async function insertModelResponse(thread: RuntimeThread): Promise<string> {
    const sequence = (sequences.get(thread.turnId) ?? 0) + 1;
    sequences.set(thread.turnId, sequence);
    const responseId = randomUUID();
    await db().insert(modelResponses).values({
      id: responseId,
      turnId: thread.turnId,
      sequence,
      provider: "runtime-test",
      model: "runtime-test",
      requestMessageCount: 1,
      predictedCacheState: "cold",
      predictedCacheReason: "facts_unavailable",
    });
    return responseId;
  }

  function script(runtime: ComposedRuntime, thread: RuntimeThread) {
    const names: Uint8Array[] = [];
    let recorded = 0;
    const takeRecorded = async () => {
      const rows = await db()
        .select({ seq: observationFrontiers.recordedSeq, snapshot: observationFrontiers.snapshot })
        .from(observationFrontiers)
        .where(
          and(
            eq(observationFrontiers.threadId, thread.threadId),
            eq(observationFrontiers.roomKey, TREE_NAMES_ROOM),
            gt(observationFrontiers.recordedSeq, recorded),
          ),
        )
        .orderBy(asc(observationFrontiers.recordedSeq));
      for (const row of rows) {
        names.push(new Uint8Array(row.snapshot));
        recorded = row.seq;
      }
    };
    const shownNames = async () => {
      await takeRecorded();
      return [...names];
    };
    const begin = async () => {
      await bindEditAgent(runtime, thread.threadId);
      const responseId = await insertModelResponse(thread);
      const [owner] = await db()
        .select({ accountId: threads.createdByUserId, projectId: threads.projectId })
        .from(threads)
        .where(eq(threads.id, thread.threadId));
      const call: ToolCall = async (name, args) => {
        const result = await runtime.app.toolExecutor.executeTool(
          { id: randomUUID(), name, arguments: args },
          {
            ...thread,
            shownNames,
            responseIdentity: { modelResponseId: responseId },
            commandOwner: owner as never,
            agentSlug: null,
            request: async () => ({
              kind: "refused",
              refusal: { code: "request_refused", message: "No one answers requests here." },
            }),
          },
        );
        await takeRecorded();
        if (result.evidence?.names) names.push(result.evidence.names.snapshot);
        return result;
      };
      return { responseId, call };
    };
    const reply = async (steps: (call: ToolCallText) => Promise<void>) => {
      const { call } = await begin();
      await steps(async (name, args) => {
        const result = await call(name, args);
        const output = String(toolContentText(result.content));
        if (result.isError) throw new Error(`${name} failed:\n${output}`);
        return output;
      });
    };
    const text = async (path: string, version?: "live") => {
      let output = "";
      await reply(async (call) => {
        output = await call("read", version ? { path, version } : { path });
      });
      return output;
    };
    return { runtime, begin, reply, text };
  }

  return { compose, script, insertModelResponse };
}
