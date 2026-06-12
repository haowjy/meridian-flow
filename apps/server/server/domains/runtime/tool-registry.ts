// @ts-nocheck
import { randomUUID } from "node:crypto";
import { buildAskUserComponentContent } from "@meridian/contracts/components";
import type { ThreadId, TurnBlockId, TurnId, UserId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type JsonValue, type TurnStatus } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import { projects, threadDocuments, threads, turnBlocks, turns, works } from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import type { ContextPortFactory } from "../context/index.js";
import { REQUIRED_MANUSCRIPT_URI, type RuntimeToolAction } from "./index.js";

export type RuntimeToolRegistry = ReturnType<typeof createRuntimeToolRegistry>;

type ToolContext = {
  threadId: ThreadId;
  userId: UserId;
  assistantTurnId: TurnId;
};

async function requireParentThread(db: Database, ctx: ToolContext) {
  const [thread] = await db
    .select({
      id: threads.id,
      projectId: threads.projectId,
      workId: threads.workId,
      currentAgentId: threads.currentAgentId,
      spawnDepth: threads.spawnDepth,
    })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .where(
      and(
        eq(threads.id, ctx.threadId),
        eq(projects.userId, ctx.userId),
        isNull(threads.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!thread) throw new HTTPError({ status: 404, message: "Thread not found" });
  return thread;
}

export function createRuntimeToolRegistry(deps: {
  db: Database;
  contextPorts: ContextPortFactory;
}) {
  const registry = {
    async executePlanActions(ctx: ToolContext, actions: RuntimeToolAction[]) {
      const results: JsonValue[] = [];
      for (const action of actions) {
        if (action.tool === "edit") {
          results.push((await registry.edit(ctx, action)).result);
        } else if (action.tool === "write") {
          results.push((await registry.write(ctx, action.uri, action.markdown)).result);
        }
      }
      return results;
    },

    async read(ctx: ToolContext, uri = REQUIRED_MANUSCRIPT_URI) {
      const document = await deps.contextPorts.forThread(ctx).readDocument(uri);
      return { result: { uri, documentId: document.documentId, markdown: document.markdown } };
    },

    async write(ctx: ToolContext, uri: string, markdown: string) {
      const document = await deps.contextPorts.forThread(ctx).writeDocument({
        uri,
        markdown,
        origin: { type: "agent", actorTurnId: ctx.assistantTurnId },
      });
      return {
        result: {
          tool: "write",
          uri,
          documentId: document.documentId,
          updateSeq: document.updateSeq,
        },
      };
    },

    async edit(ctx: ToolContext, action: Extract<RuntimeToolAction, { tool: "edit" }>) {
      const written = await deps.contextPorts.forThread(ctx).editDocument({
        uri: action.uri,
        transform: (current) => (action.mode === "append" ? `${current}${action.text}` : current),
        origin: { type: "agent", actorTurnId: ctx.assistantTurnId },
      });
      return {
        result: {
          tool: "edit",
          uri: action.uri,
          documentId: written.documentId,
          updateSeq: written.updateSeq,
          beforeLength: written.beforeMarkdown.length,
          afterLength: written.markdown.length,
        },
      };
    },

    async list(_ctx: ToolContext) {
      return { result: { uris: [REQUIRED_MANUSCRIPT_URI] } };
    },

    async search(ctx: ToolContext, query: string, uri = REQUIRED_MANUSCRIPT_URI) {
      const document = await deps.contextPorts.forThread(ctx).readDocument(uri);
      const index = document.markdown.toLowerCase().indexOf(query.toLowerCase());
      return {
        result: {
          uri,
          query,
          matches:
            index >= 0 ? [{ index, preview: document.markdown.slice(index, index + 160) }] : [],
        },
      };
    },

    async askUser(ctx: ToolContext, prompt: string) {
      const blockId = randomUUID() as TurnBlockId;
      const checkpointId = randomUUID();
      const content = {
        ...buildAskUserComponentContent({
          question: prompt,
          kind: "free-text",
          requiresHuman: true,
        }),
        checkpoint: { id: checkpointId },
      } satisfies JsonValue;
      await deps.db.transaction(async (tx) => {
        const [assistantTurn] = await tx
          .select({
            threadId: turns.threadId,
            role: turns.role,
            status: turns.status,
            activeLeafTurnId: threads.activeLeafTurnId,
          })
          .from(turns)
          .innerJoin(threads, eq(threads.id, turns.threadId))
          .where(eq(turns.id, ctx.assistantTurnId))
          .for("update")
          .limit(1);
        if (!assistantTurn)
          throw new HTTPError({ status: 404, message: "Assistant turn not found" });
        if (
          assistantTurn.threadId !== ctx.threadId ||
          assistantTurn.role !== "assistant" ||
          isTerminalTurnStatus(assistantTurn.status as TurnStatus)
        ) {
          throw new HTTPError({
            status: 409,
            message: "ask_user requires a non-terminal assistant turn",
          });
        }
        if (assistantTurn.activeLeafTurnId !== ctx.assistantTurnId) {
          throw new HTTPError({
            status: 409,
            message: "ask_user requires the active leaf assistant turn",
          });
        }
        await tx.insert(turnBlocks).values({
          id: blockId,
          turnId: ctx.assistantTurnId,
          blockType: "custom",
          status: "complete",
          sequence: 1,
          content,
          compact: prompt,
        });
        await tx
          .update(turns)
          .set({ status: "waiting_checkpoint", finishReason: "checkpoint", completedAt: null })
          .where(eq(turns.id, ctx.assistantTurnId));
      });
      return { result: { blockId, checkpointId, status: "waiting_checkpoint" } };
    },

    async spawn(ctx: ToolContext, prompt: string) {
      const parent = await requireParentThread(deps.db, ctx);
      const childThreadId = randomUUID() as ThreadId;
      const childTurnId = randomUUID() as TurnId;
      const childBlockId = randomUUID() as TurnBlockId;
      const now = new Date();
      await deps.db.transaction(async (tx) => {
        const [originTurn] = await tx
          .select({ threadId: turns.threadId, role: turns.role })
          .from(turns)
          .where(eq(turns.id, ctx.assistantTurnId))
          .for("update")
          .limit(1);
        if (
          !originTurn ||
          originTurn.threadId !== ctx.threadId ||
          originTurn.role !== "assistant"
        ) {
          throw new HTTPError({
            status: 409,
            message: "spawn requires an assistant origin turn on the parent thread",
          });
        }
        await tx.insert(threads).values({
          id: childThreadId,
          projectId: parent.projectId,
          workId: parent.workId,
          createdByUserId: ctx.userId,
          title: "Spawned assistant",
          kind: "subagent",
          currentAgentId: parent.currentAgentId,
          parentThreadId: ctx.threadId,
          originTurnId: ctx.assistantTurnId,
          originType: "spawn",
          spawnStatus: "running",
          spawnDepth: parent.spawnDepth + 1,
        });
        await tx.insert(turns).values({
          id: childTurnId,
          threadId: childThreadId,
          parentTurnId: null,
          agentDefinitionId: parent.currentAgentId,
          role: "user",
          status: "complete",
          finishReason: "spawn_prompt",
          completedAt: now,
        });
        await tx.insert(turnBlocks).values({
          id: childBlockId,
          turnId: childTurnId,
          blockType: "text",
          status: "complete",
          sequence: 0,
          content: { type: "text", text: prompt },
          compact: prompt,
        });
        await tx
          .update(threads)
          .set({ activeLeafTurnId: childTurnId, turnCount: 1, updatedAt: now })
          .where(eq(threads.id, childThreadId));
        const parentDocuments = await tx
          .select({
            documentId: threadDocuments.documentId,
            relationship: threadDocuments.relationship,
          })
          .from(threadDocuments)
          .where(eq(threadDocuments.threadId, ctx.threadId));
        if (parentDocuments.length > 0) {
          await tx.insert(threadDocuments).values(
            parentDocuments.map((document) => ({
              threadId: childThreadId,
              documentId: document.documentId,
              relationship: document.relationship,
              firstTouchedAt: now,
              lastTouchedAt: now,
            })),
          );
        }
        await tx.update(threads).set({ updatedAt: now }).where(eq(threads.id, ctx.threadId));
        await tx.update(works).set({ updatedAt: now }).where(eq(works.id, parent.workId));
        await tx
          .update(projects)
          .set({ updatedAt: now, lastActivityAt: now })
          .where(eq(projects.id, parent.projectId));
      });
      return { result: { childThreadId, prompt, spawnStatus: "running" } };
    },

    async markSpawnSucceeded(childThreadId: ThreadId) {
      const now = new Date();
      await deps.db.transaction(async (tx) => {
        const [child] = await tx
          .update(threads)
          .set({ spawnStatus: "succeeded", spawnResult: { status: "succeeded" }, updatedAt: now })
          .where(eq(threads.id, childThreadId))
          .returning({
            parentThreadId: threads.parentThreadId,
            projectId: threads.projectId,
            workId: threads.workId,
          });
        if (!child) throw new HTTPError({ status: 404, message: "Child thread not found" });
        if (child.parentThreadId) {
          await tx
            .update(threads)
            .set({ updatedAt: now })
            .where(eq(threads.id, child.parentThreadId));
        }
        await tx.update(works).set({ updatedAt: now }).where(eq(works.id, child.workId));
        await tx
          .update(projects)
          .set({ updatedAt: now, lastActivityAt: now })
          .where(eq(projects.id, child.projectId));
      });
      return { result: { childThreadId, spawnStatus: "succeeded" } };
    },
  };
  return registry;
}
