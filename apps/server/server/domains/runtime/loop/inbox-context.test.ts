/**
 * Inbox batch rendering and steer-turn persistence: system messages stay
 * request-only, and a redelivered steer reuses its durable message id instead
 * of appending a second turn.
 */

import type { ThreadId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { createInMemoryProjectRepository } from "../../projects/index.js";
import {
  createInMemoryEventJournalWriter,
  createInMemoryRepositories,
} from "../../threads/index.js";
import { createInMemoryInbox } from "../adapters/in-memory/loop-ports.js";
import { persistInboxSteers, renderInboxBatch } from "./inbox-context.js";
import type { MessageDraft } from "./ports.js";

const USER_ID = "user-1";

function steer(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "steer",
    provenance: { kind: "writer", actorId: USER_ID },
    body: { kind: "text", text: key },
    idempotencyKey: key,
  };
}

function systemMessage(key: string, threadId: ThreadId): MessageDraft {
  return {
    threadId,
    intent: "system",
    provenance: { kind: "system", source: "work" },
    body: { kind: "context", parts: [{ source: "work", text: key }] },
    idempotencyKey: key,
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
  it("renders a steer as a user message and a system message as a notice", async () => {
    const { inbox, thread } = await seed();
    await inbox.enqueue(steer("steer body", thread.id));
    await inbox.enqueue(systemMessage("context note", thread.id));
    const batch = await inbox.claimPending(thread.id);

    const rendered = renderInboxBatch([], batch);

    expect(rendered.messages).toHaveLength(1);
    expect(rendered.messages[0].role).toBe("user");
    expect(rendered.notices).toHaveLength(1);
    expect(rendered.notices[0].message).toBe("context note");
  });
});

describe("persistInboxSteers", () => {
  it("reuses the durable message id so a redelivery appends no second turn", async () => {
    const { repos, eventWriter, inbox, thread } = await seed();
    await inbox.enqueue(steer("keep me", thread.id));
    const [message] = await inbox.claimPending(thread.id);

    const deps = { repos, eventWriter };
    const first = await persistInboxSteers({
      deps,
      threadId: thread.id,
      expectedLeafTurnId: null,
      batch: [message],
    });
    expect(first.turns).toHaveLength(1);
    expect(first.turns[0].id).toBe(message.id);

    // A crash between the steer-turn persist and the ack redelivers the same
    // message; the id-keyed turn create and block upsert make it a no-op.
    const redelivered = await persistInboxSteers({
      deps,
      threadId: thread.id,
      expectedLeafTurnId: first.turns[0].id,
      batch: [message],
    });
    expect(redelivered.turns).toHaveLength(1);

    const turns = await repos.turns.listByThread(thread.id);
    expect(turns).toHaveLength(1);
    expect(turns[0].id).toBe(message.id);
    expect(turns[0].role).toBe("user");
    expect(await repos.blocks.listByTurn(message.id)).toHaveLength(1);
  });
});
