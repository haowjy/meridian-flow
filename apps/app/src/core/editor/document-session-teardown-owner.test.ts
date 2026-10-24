/** Rejection ownership and retry contract for retired document sessions.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - retired-session quarantine and retry
 */
import { describe, expect, it, vi } from "vitest";
import { DocumentSessionTeardownOwner } from "./document-session-teardown-owner";

type ControlledSession = {
  session: { destroy(): Promise<void> };
  destroy: ReturnType<typeof vi.fn>;
};

function controlledSession(): ControlledSession {
  const destroy = vi.fn<() => Promise<void>>();
  return { session: { destroy }, destroy };
}

const live = (roomKey = "doc") => ({ kind: "live" as const, roomKey });
const documentDraft = (roomKey = "draft") => ({ kind: "draft" as const, roomKey });

describe("DocumentSessionTeardownOwner", () => {
  it("joins one retirement attempt, quarantines the room, then retries after rejection", async () => {
    const owner = new DocumentSessionTeardownOwner(() => new Error("room retiring"));
    const item = controlledSession();
    let rejectFirst!: (error: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    item.destroy.mockImplementationOnce(() => first).mockResolvedValueOnce(undefined);

    const a = owner.retire(live(), item.session as never);
    const b = owner.retire(live(), item.session as never);
    expect(a).toBe(b);
    expect(() => owner.assertAvailable(live())).toThrow("room retiring");
    rejectFirst(new Error("transient destroy failure"));
    await expect(a).rejects.toThrow("transient destroy failure");

    await expect(owner.drain()).resolves.toBeUndefined();
    expect(item.destroy).toHaveBeenCalledTimes(2);
    expect(() => owner.assertAvailable(live())).not.toThrow();
    await expect(owner.retire(live(), item.session as never)).resolves.toBeUndefined();
    expect(item.destroy).toHaveBeenCalledTimes(2);
  });

  it("aggregates current failures and retries only retained sessions", async () => {
    const owner = new DocumentSessionTeardownOwner(() => new Error("retiring"));
    const a = controlledSession();
    const b = controlledSession();
    a.destroy.mockRejectedValueOnce(new Error("a")).mockResolvedValueOnce(undefined);
    b.destroy.mockRejectedValueOnce(new Error("b")).mockResolvedValueOnce(undefined);
    void owner.retire(live("a"), a.session as never).catch(() => undefined);
    void owner.retire(documentDraft("b"), b.session as never).catch(() => undefined);

    await expect(owner.drain()).rejects.toBeInstanceOf(AggregateError);
    await expect(owner.drain()).resolves.toBeUndefined();
    expect(a.destroy).toHaveBeenCalledTimes(2);
    expect(b.destroy).toHaveBeenCalledTimes(2);
  });
});
