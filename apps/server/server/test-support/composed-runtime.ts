/**
 * The production app composed over a test database, with a Hocuspocus server
 * bound for open editors, and a script that drives model replies through the
 * real tool executor and the reply's save.
 */
import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import type { Database } from "@meridian/database";
import { modelResponses } from "@meridian/database/schema";
import { afterEach } from "vitest";
import * as Y from "yjs";
import type { EventSink } from "../domains/observability/index.js";
import { createNoopEventSink } from "../domains/observability/index.js";
import type { ToolExecutionResult } from "../domains/runtime/tools/types.js";
import { composeAppServices, createProductionAppPorts } from "../lib/compose.js";

type ComposedRuntime = Awaited<ReturnType<typeof composeRuntime>>;
type RuntimeThread = { threadId: string; turnId: string };
export type ToolCall = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolExecutionResult>;
/** Calls a tool and returns its text, throwing when the tool reports an error. */
type ToolCallText = (name: string, args: Record<string, unknown>) => Promise<string>;

async function composeRuntime(db: Database, eventSink: EventSink) {
  const ports = await createProductionAppPorts({
    db,
    eventSink,
    environment: { OPENAI_API_KEY: "sk-test-runtime-composition" },
  });
  const hocuspocus = new Hocuspocus({
    yDocOptions: { gc: false, gcFilter: () => true },
    async onLoadDocument({ documentName, document }) {
      const state = await ports.documentSync.loadHocuspocusDocument(documentName);
      if (state) Y.applyUpdate(document, state);
    },
    onStoreDocument: ({ documentName, document }) =>
      ports.documentSync.storeHocuspocusDocument(documentName, document),
  });
  ports.documentSync.bindHocuspocus(hocuspocus);
  const app = composeAppServices(ports);
  return { ports, hocuspocus, app };
}

/** Tool calls read the thread's Agent binding for its permission (file-access §8). */
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

/** Unloads every open room, so pending stores land before the case ends. */
export async function unloadHocuspocus(server: Hocuspocus): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await Promise.all(server.loadingDocuments.values());
    await Promise.all(
      [...server.documents.values()].map((document) => server.unloadDocument(document)),
    );
    await Promise.all(server.unloadingDocuments.values());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Registers per-case cleanup for composed runtimes: rooms unload and the app
 * shuts down (cancelling scheduled live pulls) after each case. `db` is read
 * at call time, so a rollback suite passes its current transaction.
 */
export function useComposedRuntimes(db: () => Database) {
  const runtimes: ComposedRuntime[] = [];
  // model_responses is unique per (turn, sequence); a counter per turn keeps
  // replies distinct across scripts on one thread.
  const sequences = new Map<string, number>();
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) {
      await unloadHocuspocus(runtime.hocuspocus);
      await runtime.app.shutdown();
    }
  });

  async function compose(options: { eventSink?: EventSink } = {}): Promise<ComposedRuntime> {
    const runtime = await composeRuntime(db(), options.eventSink ?? createNoopEventSink());
    runtimes.push(runtime);
    return runtime;
  }

  /** Records a model response for the thread's turn, as the runtime does before tool calls. */
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

  /**
   * Model replies on one thread. Each `reply` records a response, runs its
   * tool calls through the executor, then saves the reply.
   */
  function script(runtime: ComposedRuntime, thread: RuntimeThread) {
    const begin = async () => {
      await bindEditAgent(runtime, thread.threadId);
      const responseId = await insertModelResponse(thread);
      const call: ToolCall = (name, args) =>
        runtime.app.toolExecutor.executeTool(
          { id: randomUUID(), name, arguments: args },
          { ...thread, responseId, agentSlug: null },
        );
      const save = () =>
        runtime.ports.documentSync.finalizeResponseCommit(responseId, thread as never);
      return { responseId, call, save };
    };
    const reply = async (steps: (call: ToolCallText) => Promise<void>) => {
      const { call, save } = await begin();
      await steps(async (name, args) => {
        const result = await call(name, args);
        const output = String(result.output);
        if (result.isError) throw new Error(`${name} failed:\n${output}`);
        return output;
      });
      await save();
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
