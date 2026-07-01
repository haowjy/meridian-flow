import { randomUUID } from "node:crypto";
import { buildAskUserComponentContent } from "@meridian/contracts/components";
import type { ThreadId, TurnBlockId, TurnId, UserId } from "@meridian/contracts/runtime";
import { isTerminalTurnStatus, type JsonValue, type TurnStatus } from "@meridian/contracts/threads";
import type { Database } from "@meridian/database";
import {
  projects,
  threadDocuments,
  threads,
  threadWorks,
  turnBlocks,
  turns,
  works,
} from "@meridian/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPError } from "nitro/h3";
import { contextPortForThread, resolveThreadContext } from "../context/context-port-resolution.js";
import { MANUSCRIPT_URI } from "../context/manuscript-uri.js";
import type { UnifiedContextPortFactory } from "../context/unified-context-port-factory.js";
import type { ThreadRepository, ThreadWorksRepository } from "../threads/index.js";
import type { RuntimeToolAction } from "./index.js";

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
      workId: threadWorks.workId,
      currentAgentId: threads.currentAgentId,
      spawnDepth: threads.spawnDepth,
    })
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .leftJoin(
      threadWorks,
      and(eq(threadWorks.threadId, threads.id), eq(threadWorks.isPrimary, true)),
    )
    .where(
      and(
        eq(threads.id, ctx.threadId),
        eq(projects.userId, ctx.userId),
        isNull(threads.deletedAt),
        isNull(projects.deletedAt),
      ),
    )
    .limit(1);
  if (!thread?.workId) throw new HTTPError({ status: 404, message: "Thread not found" });
  return thread as typeof thread & { workId: string };
}

function agentOrigin(ctx: ToolContext) {
  return {
    type: "agent" as const,
    agentSlug: "runtime-tool",
    threadId: ctx.threadId,
    turnId: ctx.assistantTurnId,
  };
}

function contextErrorMessage(
  error: import("../context/ports/context-port.js").ContextError,
): string {
  switch (error.code) {
    case "invalid_uri":
      return error.reason;
    case "io_error":
      return error.message;
    default:
      return "Context operation failed";
  }
}

export function createRuntimeToolRegistry(deps: {
  db: Database;
  contextPorts: UnifiedContextPortFactory;
  threads: Pick<ThreadRepository, "findById">;
  threadWorks: Pick<ThreadWorksRepository, "findPrimary" | "listByThread">;
}) {
  async function resolvePort(ctx: ToolContext) {
    const resolution = await resolveThreadContext(
      { threads: deps.threads, threadWorks: deps.threadWorks },
      ctx.threadId,
    );
    if (!resolution) throw new HTTPError({ status: 404, message: "Thread not found" });
    return contextPortForThread(deps.contextPorts, resolution);
  }

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

    async read(ctx: ToolContext, uri = MANUSCRIPT_URI) {
      const port = await resolvePort(ctx);
      const document = await port.read(uri);
      if (!document.ok) {
        throw new HTTPError({ status: 404, message: contextErrorMessage(document.error) });
      }
      return {
        result: {
          uri,
          documentId: document.value.documentId ?? null,
          markdown: document.value.content,
        },
      };
    },

    async write(ctx: ToolContext, uri: string, markdown: string) {
      const port = await resolvePort(ctx);
      const written = await port.write(uri, markdown, { origin: agentOrigin(ctx) });
      if (!written.ok) {
        throw new HTTPError({ status: 400, message: contextErrorMessage(written.error) });
      }
      return {
        result: {
          tool: "write",
          uri,
          documentId: written.value.documentId ?? null,
        },
      };
    },

    async edit(ctx: ToolContext, action: Extract<RuntimeToolAction, { tool: "edit" }>) {
      const port = await resolvePort(ctx);
      const edited = await port.edit(
        action.uri,
        (content) => (action.mode === "append" ? `${content}${action.text}` : content),
        { origin: agentOrigin(ctx) },
      );
      if (!edited.ok) {
        throw new HTTPError({ status: 400, message: contextErrorMessage(edited.error) });
      }
      const beforeLength =
        action.mode === "append" && edited.value.markdown
          ? edited.value.markdown.length - action.text.length
          : (edited.value.markdown?.length ?? 0);
      return {
        result: {
          tool: "edit",
          uri: action.uri,
          documentId: edited.value.documentId ?? null,
          beforeLength,
          afterLength: edited.value.markdown?.length ?? beforeLength,
        },
      };
    },

    async list(_ctx: ToolContext) {
      return { result: { uris: [MANUSCRIPT_URI] } };
    },

    async search(ctx: ToolContext, query: string, uri = MANUSCRIPT_URI) {
      const port = await resolvePort(ctx);
      const document = await port.read(uri);
      if (!document.ok) {
        throw new HTTPError({ status: 404, message: contextErrorMessage(document.error) });
      }
      const index = document.value.content.toLowerCase().indexOf(query.toLowerCase());
      return {
        result: {
          uri,
          query,
          matches:
            index >= 0
              ? [{ index, preview: document.value.content.slice(index, index + 160) }]
              : [],
        },
      };
    },

    async askUser(ctx: ToolContext, prompt: string) {
      const blockId = randomUUID() as TurnBlockId;
      const interruptId = randomUUID();
      const content = {
        ...buildAskUserComponentContent({
          interruptId,
          question: prompt,
          kind: "free-text",
          recommended: null,
          requiresHuman: true,
          timeoutMs: 0,
        }),
        interrupt: { id: interruptId },
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
          .set({ status: "waiting_interrupt", finishReason: "interrupt", completedAt: null })
          .where(eq(turns.id, ctx.assistantTurnId));
      });
      return { result: { blockId, interruptId, status: "waiting_interrupt" } };
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
        await tx.insert(threadWorks).values({
          threadId: childThreadId,
          workId: parent.workId,
          projectId: parent.projectId,
          isPrimary: true,
        });
        await tx.insert(turns).values({
          id: childTurnId,
          threadId: childThreadId,
          parentTurnId: null,
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
          });
        if (!child) throw new HTTPError({ status: 404, message: "Child thread not found" });
        const [childPrimary] = await tx
          .select({ workId: threadWorks.workId })
          .from(threadWorks)
          .where(and(eq(threadWorks.threadId, childThreadId), eq(threadWorks.isPrimary, true)))
          .limit(1);
        if (child.parentThreadId) {
          await tx
            .update(threads)
            .set({ updatedAt: now })
            .where(eq(threads.id, child.parentThreadId));
        }
        if (childPrimary?.workId) {
          await tx.update(works).set({ updatedAt: now }).where(eq(works.id, childPrimary.workId));
        }
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
