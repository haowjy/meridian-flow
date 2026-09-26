/**
 * messageTurnFor's origin derivation: writer provenance is the only human
 * send; every other provenance (agent/child/system) is a machine injection.
 * `origin` is orthogonal to `role` — child notifications are role="system"
 * for rendering, but everything else here stays role="user" regardless of
 * origin.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { describe, expect, it } from "vitest";
import { messageTurnFor } from "./inbox-context.js";
import type { InboxMessage } from "./ports.js";

function message(
  overrides: Partial<InboxMessage> & Pick<InboxMessage, "provenance">,
): InboxMessage {
  return {
    id: "message-1",
    threadId: "thread-1" as ThreadId,
    seq: 1,
    intent: "message",
    body: { kind: "text", text: "hello" },
    idempotencyKey: "idem-1",
    enqueuedAt: "2026-01-01T00:00:00.000Z",
    deliveredAt: null,
    ...overrides,
  };
}

describe("messageTurnFor", () => {
  it("gives a writer send origin writer", () => {
    const { turn } = messageTurnFor(
      message({ provenance: { kind: "writer", actorId: "user-1" } }),
      null,
    );
    expect(turn.origin).toBe("writer");
    expect(turn.role).toBe("user");
  });

  it("gives an agent-provenance background send origin system, not writer", () => {
    const { turn } = messageTurnFor(
      message({ provenance: { kind: "agent", threadId: "other-thread" as ThreadId } }),
      null,
    );
    expect(turn.origin).toBe("system");
    expect(turn.role).toBe("user");
  });

  it("gives a child completion notification origin system", () => {
    const { turn } = messageTurnFor(
      message({
        provenance: {
          kind: "child",
          threadId: "child-1" as ThreadId,
          reportId: "report-1" as TurnId,
          handle: "p1",
          outcome: "succeeded",
        },
      }),
      null,
    );
    expect(turn.origin).toBe("system");
    expect(turn.role).toBe("system");
  });

  it("gives a system-provenance notice origin system", () => {
    const { turn } = messageTurnFor(
      message({ provenance: { kind: "system", source: "probe" } }),
      null,
    );
    expect(turn.origin).toBe("system");
    expect(turn.role).toBe("user");
  });

  it("gives a Work-context refresh origin system: it is system-provenance", () => {
    const { turn } = messageTurnFor(
      message({
        provenance: { kind: "system", source: "work_context" },
        body: { kind: "work_context_refresh" },
      }),
      null,
    );
    expect(turn.origin).toBe("system");
    expect(turn.metadata).toEqual({ kind: "system_update", section: "work_context" });
  });
});
