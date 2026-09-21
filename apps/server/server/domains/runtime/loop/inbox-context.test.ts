/**
 * Inbox batch rendering and message-turn persistence: notices stay
 * request-only, and a redelivered message reuses its durable id instead
 * of appending a second turn.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { Notice, NoticePort } from "../../notices/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createInMemoryInbox } from "../adapters/in-memory/loop-ports.js";
import { drainInbox, persistInboxMessages, renderInboxBatch } from "./inbox-context.js";
import type { MessageDraft } from "./ports.js";

const USER_ID = "user-1";

function message(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function notice(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "notice",
    provenance: { kind: "system", source: "work" },
    body: { kind: "context", parts: [{ source: "work", text: key }] },
    idempotencyKey: key,
  };
}

function childReport(reportId: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "message",
    provenance: { kind: "child", threadId: "child-thread" as ThreadId, reportId },
    body: {
      kind: "report",
      text: "Two chapter breaks sag.",
      artifacts: [{ type: "object", uri: "outline.md" }],
      payload: { chapter: 3 },
      agentSlug: "critic",
      description: "Review the chapter",
    },
    idempotencyKey: `child-report:${reportId}`,
  };
}

async function seed() {
  const projects = createInMemoryProjectRepository();
  const repos = createInMemoryRepositories({ projects });
  const project = await projects.create({ userId: USER_ID, title: "Inbox" });
  const thread = await repos.threads.create({ userId: USER_ID, projectId: project.id });
  return {
    repos,
    eventWriter: createInMemoryEventJournalWriter(),
    inbox: createInMemoryInbox(),
    thread,
  };
}

describe("renderInboxBatch", () => {
  it("renders a message as a user message and a notice as a request-only notice", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(message("steer body", thread.id));
    await inbox.enqueue(notice("context note", thread.id));
    const batch = await inbox.claimPending(thread.id);

    const rendered = renderInboxBatch([], batch);

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].role).toBe("user");
    expect(rendered.notices).toHaveLength(1);
    expect(rendered.notices[0].message).toBe("context note");
  });

  it("renders a child report as a system message carrying its artifacts", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(childReport("report-1", thread.id));
    const batch = await inbox.claimPending(thread.id);

    const rendered = renderInboxBatch([], batch);

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].role).toBe("system");
    const text = rendered.messages[0].content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(text.join("\n")).toContain('Background subagent "Critic" reported.');
    expect(text.join("\n")).toContain("Two chapter breaks sag.");
    expect(text.join("\n")).toContain("outline.md");
  });
});

describe("persistInboxMessages", () => {
  it("reuses the durable message id so a redelivery appends no second turn", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("keep me", thread.id));
    const [claimedMessage] = await inbox.claimPending(thread.id);

    const deps = { repos, eventWriter };
    const first = await persistInboxMessages({
      deps,
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [claimedMessage],
    });
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0].id).toBe(claimedMessage.id);

    // A crash between the message-turn persist and the ack redelivers the same
    // message; the id-keyed turn create and block upsert make it a no-op.
    const redelivered = await persistInboxMessages({
      deps,
      threadId: thread.id,
      expectedLeafTurnId: first.turns[0].id,
      batch: [claimedMessage],
    });
    expect(redelivered.turns).toHaveLength(1);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe(claimedMessage.id);
    expect(turns[0].role).toBe("user");
    expect(await repos.blocks.listByTurn(claimedMessage.id)).toHaveLength(1);
  });

  it("persists a whole batch in one turn-start transition, chaining each turn", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("one", thread.id));
    await inbox.enqueue(message("two", thread.id));
    const batch = await inbox.claimPending(thread.id);

    const transition = vi.spyOn(repos, "runTurnStartTransition");
    const persisted = await persistInboxMessages({
      deps: { repos, eventWriter },
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch,
    });

    expect(transition).toHaveBeenCalledTimes(1);
    transition.mockRestore();
    expect(persisted.turns).toHaveLength(2);
    expect(persisted.turns[1]?.prevTurnId).toBe(persisted.turns[0]?.id);
    expect(persisted.events.map((event) => event.type)).toEqual([
      "turn.created",
      "block.upserted",
      "turn.created",
      "block.upserted",
    ]);
  });

  it("persists a report as a system turn carrying a helper-result card", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(childReport("report-2", thread.id));
    const [message] = await inbox.claimPending(thread.id);

    const persisted = await persistInboxMessages({
      deps: { repos, eventWriter },
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [message],
    });

    expect(persisted.turns[0]?.role).toBe("system");
    const [block] = await repos.blocks.listByTurn(message.id);
    expect(block?.blockType).toBe("custom");
    expect(block?.content).toMatchObject({
      kind: "helper-result",
      props: {
        agentSlug: "critic",
        title: "Review the chapter",
        status: "completed",
        childThreadId: "child-thread",
        summary: "Two chapter breaks sag.",
        artifacts: [{ type: "object", uri: "outline.md" }],
      },
    });
  });

  it("stamps a message turn with the inbox enqueuedAt, not persist time", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("timed", thread.id));
    const [claimedMessage] = await inbox.claimPending(thread.id);
    const enqueuedAt = "2020-01-02T03:04:05.000Z";

    const persisted = await persistInboxMessages({
      deps: { repos, eventWriter },
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [{ ...(claimedMessage as NonNullable<typeof claimedMessage>), enqueuedAt }],
    });

    expect(persisted.turns[0]?.createdAt).toBe(enqueuedAt);
    const turns = await repos.turns.listByThread(thread.id);
    expect(turns[0]?.createdAt).toBe(enqueuedAt);
  });
});

describe("drainInbox", () => {
  function noopNotices(rows: Notice[] = []): NoticePort {
    return {
      async record() {},
      async drainForModelContext() {
        return [...rows];
      },
    };
  }

  it("skips a redelivered message already in knownTurnIds and still returns its ack id", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("crash then retry", thread.id));
    const [claimedMessage] = await inbox.claimPending(thread.id);
    if (!claimedMessage) throw new Error("expected a claimed message");
    // Persist once, leaving the message unacked (crash before ack).
    const first = await persistInboxMessages({
      deps: { repos, eventWriter },
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [claimedMessage],
    });

    // The same unacked message is redelivered; its turn is already durable.
    const drain = await drainInbox({
      persistence: { repos, eventWriter },
      inbox,
      notices: noopNotices(),
      threadId: thread.id,
      messages: [],
      knownTurnIds: new Set(first.turns.map((turn) => turn.id)),
      expectedLeafTurnId: first.turns[0]?.id ?? null,
    });

    expect(drain.turns).toEqual([]);
    expect(drain.persistedEvents).toEqual([]);
    expect(drain.ackIds).toEqual([claimedMessage.id]);
    expect(await repos.turns.listByThread(thread.id)).toHaveLength(1);
  });
});
