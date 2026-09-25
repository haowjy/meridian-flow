/**
 * DeliveryStore batch rendering and message-turn persistence: notices stay
 * request-only, and a redelivered message reuses its durable id instead
 * of appending a second turn.
 */

import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it, vi } from "vitest";
import type { Notice, NoticePort } from "../../notices/index.js";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createInMemoryInbox } from "../adapters/in-memory/loop-ports.js";
import {
  drainInbox,
  persistInboxMessages,
  planMessageTurns,
  renderInboxBatch,
} from "./inbox-context.js";
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
    body: { kind: "text", text: `Read thread_report({"ref":"p1","execution":"${reportId}"}).` },
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
    const batch = await inbox.selectPending(thread.id);

    const rendered = renderInboxBatch([], batch);

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].role).toBe("user");
    expect(rendered.notices).toHaveLength(1);
    expect(rendered.notices[0].message).toBe("context note");
  });

  it("renders only a compact exact report reference as a system message", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(childReport("report-1", thread.id));
    const batch = await inbox.selectPending(thread.id);

    const rendered = renderInboxBatch([], batch);

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].role).toBe("system");
    const text = rendered.messages[0].content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    expect(text.join("\n")).toContain('thread_report({"ref":"p1","execution":"report-1"})');
    expect(text.join("\n")).not.toContain("chapter");
  });
});

describe("planMessageTurns", () => {
  it("chains each fresh message from the previous turn and reports the leaf", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(message("one", thread.id));
    await inbox.enqueue(message("two", thread.id));
    const batch = await inbox.selectPending(thread.id);

    const plan = planMessageTurns({ batch, prevTurnId: null, knownTurnIds: new Set() });

    expect(plan.turns.map((turn) => turn.id)).toEqual(batch.map((entry) => entry.id));
    expect(plan.turns[0]?.prevTurnId).toBeNull();
    expect(plan.turns[1]?.prevTurnId).toBe(batch[0]?.id);
    expect(plan.leafTurnId).toBe(batch[1]?.id);
    expect(plan.events.map((event) => event.type)).toEqual([
      "turn.created",
      "block.upserted",
      "turn.created",
      "block.upserted",
    ]);
  });

  it("skips a known turn id and re-chains the next fresh message from the durable leaf", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(message("first", thread.id));
    await inbox.enqueue(message("second", thread.id));
    const batch = await inbox.selectPending(thread.id);
    const firstId = batch[0]?.id ?? "";
    const secondId = batch[1]?.id ?? "";

    const plan = planMessageTurns({
      batch,
      prevTurnId: firstId,
      knownTurnIds: new Set([firstId]),
    });

    expect(plan.turns.map((turn) => turn.id)).toEqual([secondId]);
    expect(plan.turns[0]?.prevTurnId).toBe(firstId);
    expect(plan.leafTurnId).toBe(secondId);
  });

  it("skips notice entries without shifting the chain", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(notice("ambient", thread.id));
    await inbox.enqueue(message("direct", thread.id));
    const batch = await inbox.selectPending(thread.id);

    const plan = planMessageTurns({ batch, prevTurnId: null, knownTurnIds: new Set() });

    expect(plan.turns).toHaveLength(1);
    expect(plan.leafTurnId).toBe(plan.turns[0]?.id);
  });

  it("returns the previous leaf unchanged when nothing fresh remains", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(message("known", thread.id));
    const batch = await inbox.selectPending(thread.id);
    const knownId = batch[0]?.id ?? "";

    const plan = planMessageTurns({
      batch,
      prevTurnId: knownId,
      knownTurnIds: new Set([knownId]),
    });

    expect(plan.turns).toEqual([]);
    expect(plan.events).toEqual([]);
    expect(plan.leafTurnId).toBe(knownId);
  });
});

describe("persistInboxMessages", () => {
  it("reuses the durable message id so a redelivery appends no second turn", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("keep me", thread.id));
    const [claimedMessage] = await inbox.selectPending(thread.id);

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
    const batch = await inbox.selectPending(thread.id);

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
  });

  it("persists a child notification as writer-hidden system text, not a report card", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(childReport("report-2", thread.id));
    const [message] = await inbox.selectPending(thread.id);

    const persisted = await persistInboxMessages({
      deps: { repos, eventWriter },
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [message],
    });

    expect(persisted.turns[0]?.role).toBe("system");
    const [block] = await repos.blocks.listByTurn(message.id);
    expect(block?.blockType).toBe("text");
    expect(block?.content).toBe('Read thread_report({"ref":"p1","execution":"report-2"}).');
  });

  it("stamps a message turn with the inbox enqueuedAt, not persist time", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(message("timed", thread.id));
    const [claimedMessage] = await inbox.selectPending(thread.id);
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
    const [claimedMessage] = await inbox.selectPending(thread.id);
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
      batch: await inbox.selectPending(thread.id),
      notices: noopNotices(),
      threadId: thread.id,
      messages: [],
      knownTurnIds: new Set(first.turns.map((turn) => turn.id)),
      expectedLeafTurnId: first.turns[0]?.id ?? null,
    });

    expect(drain.turns).toEqual([]);
    expect(drain.ackIds).toEqual([claimedMessage.id]);
    expect(await repos.turns.listByThread(thread.id)).toHaveLength(1);
  });

  it("renders an adopted mid-run message from its persisted blocks, not the plain body", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    const enqueued = await inbox.enqueue(message("steer body", thread.id));
    // Simulate the writer producer: the turn and its rich blocks are durable at
    // enqueue, but the live run's accumulator predates them, so `knownTurnIds`
    // does not contain the turn.
    await repos.turns.create({
      id: enqueued.id as TurnId,
      threadId: thread.id,
      prevTurnId: null,
      role: "user",
      status: "complete",
    });
    await repos.blocks.create({
      id: "block-reference",
      turnId: enqueued.id,
      blockType: "text",
      sequence: 0,
      textContent: "[[Gate Map]]",
      content: {
        type: "reference",
        text: "[[Gate Map]]",
        documentId: "33333333-3333-4333-8333-333333333333",
        uri: "uploads://@/gate-map.png",
        read: { result: { pages: [1] } },
      },
      status: "complete",
    });
    await repos.blocks.create({
      id: "block-image",
      turnId: enqueued.id,
      blockType: "image",
      sequence: 1,
      content: {
        type: "image_reference",
        documentId: "33333333-3333-4333-8333-333333333333",
        uri: "uploads://@/gate-map.png",
      },
      status: "complete",
    });

    const drain = await drainInbox({
      persistence: { repos, eventWriter },
      batch: await inbox.selectPending(thread.id),
      notices: noopNotices(),
      threadId: thread.id,
      messages: [],
      knownTurnIds: new Set(),
      expectedLeafTurnId: enqueued.id as TurnId,
    });

    expect(drain.turns.map((turn) => turn.id)).toEqual([enqueued.id]);
    expect(drain.rendered).toHaveLength(1);
    const parts = drain.rendered[0]?.content ?? [];
    const texts = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
    const modelText = texts.join("\n");
    expect(modelText).toContain("[[Gate Map]]");
    expect(modelText).toContain("Reference read result for uploads://@/gate-map.png");
    expect(modelText).toContain('"pages":[1]');
    expect(parts.some((part) => part.type !== "text")).toBe(true);
    expect(modelText).not.toContain("steer body");
  });
});
