// @ts-nocheck
import { randomUUID } from "node:crypto";
import type { SendMessageResponse, ThreadLiveState } from "@meridian/contracts/protocol";
import type {
  AgentDefinitionId,
  ProjectId,
  ThreadId,
  TurnBlockId,
  TurnId,
  UserId,
  WorkId,
} from "@meridian/contracts/runtime";
import type {
  JsonValue,
  OrchestratorEvent,
  OrchestratorTurn,
  TurnRole,
  TurnStatus,
} from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { eventJournal, projects, threads, turnBlocks, turns, works } from "@meridian/database";
import { and, eq, isNull, sql } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import type { Gateway } from "../runtime/index.js";
import type { RuntimeToolRegistry } from "../runtime/tool-registry.js";
import type { ThreadEventHub } from "./event-hub.js";

export type ThreadRuntimeService = ReturnType<typeof createThreadRuntimeService>;

type OwnedThread = {
  id: ThreadId;
  projectId: ProjectId;
  workId: WorkId;
  currentAgentId: AgentDefinitionId | null;
  activeLeafTurnId: TurnId | null;
  nextSeq: bigint;
  status: string;
};

type PersistedJournalEvent = {
  seq: bigint;
  event: OrchestratorEvent;
};

function jsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toOrchestratorTurn(row: typeof turns.$inferSelect): OrchestratorTurn {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role as TurnRole,
    status: row.status as TurnStatus,
    blocks: [],
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

function textBlockContent(text: string): JsonValue {
  return { type: "text", text };
}

async function generateTurnPlan(
  gateway: Gateway,
  input: { threadId: ThreadId; userText: string },
): Promise<{ assistantText: string; actions: unknown[] }> {
  const legacyGateway = gateway as Gateway & {
    generateTurnPlan?: (input: { threadId: ThreadId; userText: string }) => Promise<{
      assistantText: string;
      actions?: unknown[];
    }>;
  };

  if (typeof legacyGateway.generateTurnPlan === "function") {
    const plan = await legacyGateway.generateTurnPlan(input);
    return { assistantText: plan.assistantText, actions: plan.actions ?? [] };
  }

  const result = await gateway.generate({
    messages: [{ role: "user", content: [{ type: "text", text: input.userText }] }],
    maxTokens: 4096,
  });
  const assistantText = result.content
    .filter(
      (part): part is Extract<(typeof result.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("");

  return {
    assistantText: assistantText || "",
    actions: [],
  };
}

function journalTurnId(event: OrchestratorEvent): TurnId | null {
  if ("turn" in event) return event.turn.id;
  if ("turnId" in event) return event.turnId;
  return null;
}

async function appendJournalEvent(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  threadId: ThreadId,
  event: OrchestratorEvent,
): Promise<PersistedJournalEvent> {
  const [head] = await tx
    .update(threads)
    .set({ nextSeq: sql`${threads.nextSeq} + 1` })
    .where(eq(threads.id, threadId))
    .returning({ seq: threads.nextSeq });
  const seq = head?.seq ?? 0n;
  const payload = jsonClone(event);

  await tx.insert(eventJournal).values({
    threadId,
    turnId: journalTurnId(payload),
    seq,
    eventType: payload.type,
    payload,
  });

  return { seq, event: payload };
}

export function createThreadRuntimeService(deps: {
  db: Database;
  gateway: Gateway;
  hub: ThreadEventHub;
  tools?: RuntimeToolRegistry;
}) {
  async function requireOwnedThread(threadId: ThreadId, userId: UserId): Promise<OwnedThread> {
    const [thread] = await deps.db
      .select({
        id: threads.id,
        projectId: threads.projectId,
        workId: threads.workId,
        currentAgentId: threads.currentAgentId,
        activeLeafTurnId: threads.activeLeafTurnId,
        nextSeq: threads.nextSeq,
        status: threads.status,
      })
      .from(threads)
      .innerJoin(projects, eq(projects.id, threads.projectId))
      .where(
        and(
          eq(threads.id, threadId),
          eq(projects.userId, userId),
          isNull(threads.deletedAt),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1);

    if (!thread) throw new HTTPError({ status: 404, message: "Thread not found" });
    return thread;
  }

  async function liveState(threadId: ThreadId, userId: UserId): Promise<ThreadLiveState> {
    const thread = await requireOwnedThread(threadId, userId);
    const headSeq = thread.nextSeq;
    return {
      threadId,
      status: thread.status === "archived" ? "archived" : "idle",
      runningTurnId: null,
      currentAgent: thread.currentAgentId,
      nextSeq: (headSeq + 1n).toString(),
      resumeAfterSeq: headSeq.toString(),
    };
  }

  return {
    requireOwnedThread,
    liveState,

    async sendMessage(input: {
      threadId: ThreadId;
      userId: UserId;
      text: string;
    }): Promise<SendMessageResponse> {
      const now = new Date();
      const userTurnId = randomUUID() as TurnId;
      const userBlockId = randomUUID() as TurnBlockId;
      const assistantTurnId = randomUUID() as TurnId;
      const assistantBlockId = randomUUID() as TurnBlockId;
      await requireOwnedThread(input.threadId, input.userId);
      const plan = await generateTurnPlan(deps.gateway, {
        threadId: input.threadId,
        userText: input.text,
      });

      const events = await deps.db.transaction(async (tx) => {
        const [thread] = await tx
          .select({
            id: threads.id,
            projectId: threads.projectId,
            workId: threads.workId,
            currentAgentId: threads.currentAgentId,
            activeLeafTurnId: threads.activeLeafTurnId,
            status: threads.status,
          })
          .from(threads)
          .innerJoin(projects, eq(projects.id, threads.projectId))
          .where(
            and(
              eq(threads.id, input.threadId),
              eq(projects.userId, input.userId),
              isNull(threads.deletedAt),
              isNull(projects.deletedAt),
            ),
          )
          .for("update", { of: threads })
          .limit(1);

        if (!thread) throw new HTTPError({ status: 404, message: "Thread not found" });

        if (thread.activeLeafTurnId) {
          await tx
            .update(threads)
            .set({ activeLeafTurnId: null })
            .where(eq(threads.id, input.threadId));
        }

        const [userTurn] = await tx
          .insert(turns)
          .values({
            id: userTurnId,
            threadId: input.threadId,
            parentTurnId: thread.activeLeafTurnId,
            agentDefinitionId: thread.currentAgentId,
            role: "user",
            status: "complete",
            finishReason: "end_turn",
            completedAt: now,
          })
          .returning();

        const [assistantTurn] = await tx
          .insert(turns)
          .values({
            id: assistantTurnId,
            threadId: input.threadId,
            parentTurnId: userTurnId,
            agentDefinitionId: thread.currentAgentId,
            role: "assistant",
            status: "streaming",
          })
          .returning();

        await tx.insert(turnBlocks).values({
          id: userBlockId,
          turnId: userTurnId,
          blockType: "text",
          status: "complete",
          sequence: 0,
          content: textBlockContent(input.text),
          compact: input.text,
        });

        await tx.insert(turnBlocks).values({
          id: assistantBlockId,
          turnId: assistantTurnId,
          blockType: "text",
          status: "complete",
          sequence: 0,
          modelText: plan.assistantText,
          content: textBlockContent(plan.assistantText),
          compact: plan.assistantText,
        });

        await tx
          .update(threads)
          .set({
            activeLeafTurnId: assistantTurnId,
            turnCount: sql`${threads.turnCount} + 2`,
            updatedAt: now,
          })
          .where(eq(threads.id, input.threadId));

        await tx.update(works).set({ updatedAt: now }).where(eq(works.id, thread.workId));
        await tx
          .update(projects)
          .set({ updatedAt: now, lastActivityAt: now })
          .where(eq(projects.id, thread.projectId));

        if (!userTurn || !assistantTurn) {
          throw new Error("Failed to create turns");
        }

        const userEvent: OrchestratorEvent = {
          type: "turn.created",
          turn: toOrchestratorTurn(userTurn),
        };
        const assistantEvent: OrchestratorEvent = {
          type: "turn.created",
          turn: toOrchestratorTurn(assistantTurn),
        };
        const deltaEvent: OrchestratorEvent = {
          type: "stream.delta",
          threadId: input.threadId,
          turnId: assistantTurnId,
          kind: "text",
          text: plan.assistantText,
        };
        const persistedEvents: PersistedJournalEvent[] = [];
        for (const event of [userEvent, assistantEvent, deltaEvent]) {
          persistedEvents.push(await appendJournalEvent(tx, input.threadId, event));
        }

        return persistedEvents;
      });

      for (const { seq, event } of events) {
        deps.hub.publishPersistedEvent(input.threadId, seq, event);
      }

      try {
        await deps.tools?.executePlanActions(
          { threadId: input.threadId, userId: input.userId, assistantTurnId },
          plan.actions,
        );
      } catch (error) {
        const failedAt = new Date();
        const message = error instanceof Error ? error.message : "Tool action failed";
        const [errorEvent] = await deps.db.transaction(async (tx) => {
          const [assistantTurn] = await tx
            .update(turns)
            .set({
              status: "error",
              finishReason: "error",
              completedAt: failedAt,
              error: message,
            })
            .where(eq(turns.id, assistantTurnId))
            .returning();
          if (!assistantTurn) throw new Error("Failed to mark assistant turn errored");

          const event: OrchestratorEvent = {
            type: "turn.error",
            turn: toOrchestratorTurn(assistantTurn),
            message,
          };
          return [await appendJournalEvent(tx, input.threadId, event)];
        });
        deps.hub.publishPersistedEvent(input.threadId, errorEvent.seq, errorEvent.event);
        throw error;
      }

      const completedAt = new Date();
      const completedEvents = await deps.db.transaction(async (tx) => {
        const [assistantTurn] = await tx
          .update(turns)
          .set({
            status: "complete",
            finishReason: "end_turn",
            completedAt,
          })
          .where(eq(turns.id, assistantTurnId))
          .returning();
        if (!assistantTurn) throw new Error("Failed to complete assistant turn");

        const completedEvent: OrchestratorEvent = {
          type: "turn.completed",
          turn: toOrchestratorTurn(assistantTurn),
        };

        return [await appendJournalEvent(tx, input.threadId, completedEvent)];
      });

      for (const { seq, event } of completedEvents) {
        deps.hub.publishPersistedEvent(input.threadId, seq, event);
      }

      return {
        threadId: input.threadId,
        userTurnId,
        assistantTurnId,
        status: "accepted",
      };
    },

    async journalEvents(threadId: ThreadId) {
      return deps.db.select().from(eventJournal).where(eq(eventJournal.threadId, threadId));
    },
  };
}
