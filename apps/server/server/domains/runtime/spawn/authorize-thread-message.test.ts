/** thread_message authority: background is lineage, foreground is subtree. */
import type { ThreadId } from "@meridian/contracts/runtime";
import type { Thread } from "@meridian/contracts/threads";
import { describe, expect, it } from "vitest";

const CALLER = "caller" as ThreadId;
const SIBLING = "sibling" as ThreadId;
const CHILD = "child" as ThreadId;
const STRANGER = "stranger" as ThreadId;

function thread(input: {
  id: string;
  parentThreadId?: string | null;
  rootThreadId?: string;
  projectId?: string;
  userId?: string;
  kind?: "primary" | "subagent";
  ref?: string | null;
}): Thread {
  return {
    id: input.id,
    projectId: input.projectId ?? "project-1",
    userId: input.userId ?? "user-1",
    kind: input.kind ?? "subagent",
    ref: input.ref ?? null,
    parentThreadId: input.parentThreadId ?? null,
    rootThreadId: input.rootThreadId ?? input.id,
  } as unknown as Thread;
}

function repo(threads: Thread[]) {
  const byId = new Map(threads.map((entry) => [entry.id, entry]));
  return {
    async findLiveByProjectRef(projectId: string, ref: string) {
      return threads.find((entry) => entry.projectId === projectId && entry.ref === ref) ?? null;
    },
    async findById(id: ThreadId) {
      return byId.get(id) ?? null;
    },
  };
}

async function authorize(input: {
  caller: Thread;
  targetRef: string;
  mode: "foreground" | "background";
  threads: Thread[];
}) {
  const { authorizeThreadMessage } = await import("./authorize-thread-message.js");
  return authorizeThreadMessage({
    callerThread: input.caller,
    targetRef: input.targetRef,
    mode: input.mode,
    threads: repo(input.threads) as never,
  });
}

describe("authorizeThreadMessage", () => {
  it("allows background to a lineage sibling and foreground to a descendant", async () => {
    const caller = thread({ id: CALLER, rootThreadId: CALLER, kind: "primary", ref: "c1" });
    const sibling = thread({ id: SIBLING, rootThreadId: CALLER, ref: "p1" });
    const child = thread({ id: CHILD, parentThreadId: CALLER, rootThreadId: CALLER, ref: "p2" });

    const background = await authorize({
      caller,
      targetRef: "p1",
      mode: "background",
      threads: [caller, sibling, child],
    });
    expect(background).toMatchObject({ ok: true, target: { id: SIBLING } });

    const foreground = await authorize({
      caller,
      targetRef: "p2",
      mode: "foreground",
      threads: [caller, sibling, child],
    });
    expect(foreground).toMatchObject({ ok: true, target: { id: CHILD } });
  });

  it("rejects background to a different lineage", async () => {
    const caller = thread({ id: CALLER, rootThreadId: CALLER, kind: "primary", ref: "c1" });
    const stranger = thread({ id: STRANGER, rootThreadId: STRANGER, ref: "p9" });

    const outcome = await authorize({
      caller,
      targetRef: "p9",
      mode: "background",
      threads: [caller, stranger],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("thread_message_not_authorized");
  });

  it("rejects foreground to an ancestor (no wait cycle)", async () => {
    const caller = thread({ id: CALLER, parentThreadId: SIBLING, rootThreadId: SIBLING });
    const ancestor = thread({
      id: SIBLING,
      rootThreadId: SIBLING,
      kind: "primary",
      ref: "c1",
    });

    const outcome = await authorize({
      caller,
      targetRef: "c1",
      mode: "foreground",
      threads: [ancestor],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe("thread_message_not_authorized");
  });

  it("allows background thread_message between a fork and its source", async () => {
    // Mirrors buildDerivedPrimaryThreadRow: a fork of a root shares its root
    // and has no parent (fork.parentThreadId = source.parentThreadId = null).
    const source = thread({ id: CALLER, rootThreadId: CALLER, kind: "primary", ref: "c1" });
    const fork = thread({ id: SIBLING, rootThreadId: CALLER, kind: "primary", ref: "c2" });

    const fromSource = await authorize({
      caller: source,
      targetRef: "c2",
      mode: "background",
      threads: [source, fork],
    });
    expect(fromSource).toMatchObject({ ok: true, target: { id: SIBLING } });

    const fromFork = await authorize({
      caller: fork,
      targetRef: "c1",
      mode: "background",
      threads: [source, fork],
    });
    expect(fromFork).toMatchObject({ ok: true, target: { id: CALLER } });
  });

  it("rejects foreground thread_message between a fork and its source: siblings grant no subtree authority", async () => {
    const source = thread({ id: CALLER, rootThreadId: CALLER, kind: "primary", ref: "c1" });
    const fork = thread({ id: SIBLING, rootThreadId: CALLER, kind: "primary", ref: "c2" });

    const fromSource = await authorize({
      caller: source,
      targetRef: "c2",
      mode: "foreground",
      threads: [source, fork],
    });
    expect(fromSource.ok).toBe(false);
    if (fromSource.ok) return;
    expect(fromSource.error.code).toBe("thread_message_not_authorized");

    const fromFork = await authorize({
      caller: fork,
      targetRef: "c1",
      mode: "foreground",
      threads: [source, fork],
    });
    expect(fromFork.ok).toBe(false);
    if (fromFork.ok) return;
    expect(fromFork.error.code).toBe("thread_message_not_authorized");
  });

  it("returns not-found for a malformed or unknown ref", async () => {
    const caller = thread({ id: CALLER, rootThreadId: CALLER, kind: "primary" });
    const malformed = await authorize({
      caller,
      targetRef: "nope",
      mode: "background",
      threads: [caller],
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("thread_message_target_not_found");

    const unknown = await authorize({
      caller,
      targetRef: "p4",
      mode: "background",
      threads: [caller],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe("thread_message_target_not_found");
  });
});
