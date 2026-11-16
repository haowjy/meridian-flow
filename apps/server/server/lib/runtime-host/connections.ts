/**
 * The runtime's view of a writer's MCP connections: the catalogue for a prompt, and the three
 * tools' calls. A tool call reads the thread's pins through the bake in effect (a compaction
 * writes a new one, so it is read per call, not held), and the full reply and its media go to
 * the thread's own storage prefix, which goes with the thread.
 */
import type { UserId } from "@meridian/contracts";
import type { McpBakedConnection } from "@meridian/contracts/mcp";
import type { Thread } from "@meridian/contracts/threads";
import type { McpClient } from "@meridian-flow/runtime/mcp";
import type { ScriptRunner } from "@meridian-flow/runtime/script";
import {
  type CallStore,
  type ConnectionStore,
  createConnectionBake,
  createConnectionTools,
  createScriptRuns,
  DO_NOT_REPEAT,
  type McpConnections,
  SCRIPT_LIMITS,
} from "../../domains/mcp/index.js";
import {
  type EventSink,
  emitEvent,
  unknownToEventPayload,
} from "../../domains/observability/index.js";
import type { ConnectionsPort } from "../../domains/runtime/index.js";
import { chatMediaPrefix, type ObjectStorePort } from "../../domains/storage/index.js";
import { bakeInEffect, type ThreadRepositories } from "../../domains/threads/index.js";

export function createConnections(deps: {
  service: Pick<McpConnections, "resolve" | "checks" | "serverFor">;
  store: Pick<ConnectionStore, "find" | "findPin">;
  calls: CallStore;
  client: McpClient;
  runner: ScriptRunner;
  objectStore: Pick<ObjectStorePort, "put" | "get">;
  repos: Pick<ThreadRepositories, "threads" | "turns" | "promptBakes">;
  eventSink: EventSink;
}): ConnectionsPort {
  const baker = createConnectionBake(deps);
  const tools = createConnectionTools({
    warn: (what, cause) =>
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "mcp.call",
        name: "McpCallAfterAnswerFailed",
        payload: { what, ...unknownToEventPayload(cause) },
      }),
    store: deps.store,
    calls: deps.calls,
    client: deps.client,
    service: deps.service,
    replies: {
      async put(threadId, name, bytes, mimeType) {
        const key = `${chatMediaPrefix(threadId)}mcp/${name}`;
        const stored = await deps.objectStore.put(key, bytes, mimeType);
        if (!stored.ok) throw new Error(`A connection reply was not stored: ${stored.error.code}`);
        return { key };
      },
      async get(key) {
        const stored = await deps.objectStore.get(key);
        if (!stored.ok) throw new Error(`A connection reply was not read: ${stored.error.code}`);
        return stored.value.bytes;
      },
    },
  });

  const scripts = createScriptRuns({ runner: deps.runner, tools });

  const bakeOf = (thread: Pick<Thread, "id" | "initialPromptBakeId">) =>
    bakeInEffect(deps.repos, thread);

  async function threadOf(threadId: string) {
    const thread = await deps.repos.threads.findById(threadId as never);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  return {
    scriptLimits: SCRIPT_LIMITS,

    async bake(thread) {
      if (!thread.parentThreadId) return baker.forWriter(thread.userId as UserId, thread.projectId);
      // A subagent holds what its parent's bake in effect holds, whatever the writer's connections are now.
      const parent = await deps.repos.threads.findByIdIncludingDeleted(thread.parentThreadId);
      const held: readonly McpBakedConnection[] = parent
        ? ((await bakeOf(parent))?.bakedConnections ?? [])
        : [];
      return baker.fromHeld(thread.userId as UserId, held);
    },

    saved(thread, baked) {
      void baker.saved(thread.userId as UserId, baked).catch((cause) =>
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "mcp.connection-check",
          name: "McpConnectionCheckFailed",
          correlation: { threadId: thread.id },
          payload: unknownToEventPayload(cause),
        }),
      );
    },

    async ownNameRefusal(thread, name) {
      const bake = await bakeOf(thread);
      for (const held of bake?.bakedConnections ?? []) {
        const pin = await deps.store.findPin(held.pinId);
        for (const tool of pin?.pin.tools ?? []) {
          const own = [
            tool.name,
            ...["_", "__", "-", "."].map((join) => `${held.name}${join}${tool.name}`),
          ];
          if (own.includes(name))
            return `${name} is not a tool of its own: it is the tool ${tool.name} of the ${held.name} connection. Call it with mcp_call, with tool "${held.name}/${tool.name}" and its arguments.`;
        }
      }
      return null;
    },

    doNotRepeat: DO_NOT_REPEAT,

    async recordedCalls(threadId, turnIds) {
      const bake = await bakeOf(await threadOf(threadId));
      return tools.recordedCalls(threadId, turnIds, bake?.bakedConnections ?? []);
    },

    async call(caller, input) {
      const thread = await threadOf(caller.threadId);
      return tools.mcpCall({
        thread: { id: thread.id, userId: thread.userId as UserId },
        bake: (await bakeOf(thread)) ?? { bakedConnections: [] },
        id: input.id,
        arguments: input.arguments,
        signal: caller.signal,
        origin: {
          turnId: caller.turnId,
          modelResponseId: caller.modelResponseId,
          toolCallId: caller.toolCallId,
          sequence: 0,
        },
      });
    },

    async run(caller, input) {
      const thread = await threadOf(caller.threadId);
      return scripts.run({
        thread: { id: thread.id, userId: thread.userId as UserId },
        bake: (await bakeOf(thread)) ?? { bakedConnections: [] },
        code: input.code,
        signal: caller.signal,
        origin: {
          turnId: caller.turnId,
          modelResponseId: caller.modelResponseId,
          toolCallId: caller.toolCallId,
        },
        emit: input.emit,
      });
    },

    async describe(caller, input) {
      const startedAt = Date.now();
      const thread = await threadOf(caller.threadId);
      const bake = await bakeOf(thread);
      const described = await tools.describe({
        bake: bake ?? { bakedConnections: [] },
        names: input.names,
      });
      // A bake other than the thread's first is a compaction's: this read is the one the new prompt
      // asks for again. The response that issued it is the round trip it adds
      // (`model_responses.latency_ms` on the event's `responseId`), so a query can sum both.
      if (bake && bake.id !== thread.initialPromptBakeId)
        emitEvent(deps.eventSink, {
          level: "info",
          source: "mcp.describe",
          sensitivity: "safe",
          name: "McpDescribeAfterCompaction",
          correlation: { threadId: thread.id, turnId: caller.turnId },
          payload: {
            responseId: caller.modelResponseId,
            names: input.names.length,
            ms: Date.now() - startedAt,
          },
        });
      return described;
    },
  };
}
