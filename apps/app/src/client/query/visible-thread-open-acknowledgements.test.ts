/** Public lifecycle contracts for visible-chat acknowledgement operations. */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runThreadUserStateCommand } from "./thread-user-state-commands";
import {
  cancelOpenAcknowledgementTransfer,
  claimVisibleOpenAcknowledgement,
  createVisibilityLeaseId,
  getOpenAcknowledgementState,
  prepareHomeOpenAcknowledgement,
  releaseVisibleOpenAcknowledgement,
  retryOpenAcknowledgement,
} from "./visible-thread-open-acknowledgements";

type Request = { body: unknown; resolve: (response: Response) => void };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const response = {
  threadId: "thread-1",
  isFavorite: false,
  manuallyUnread: false,
  lastOpenedAt: "2026-08-13T00:01:00.000Z",
  attention: "none" as const,
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function controlledRequests(): Request[] {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      let resolve!: (value: Response) => void;
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      requests.push({ body: JSON.parse(String(init?.body)), resolve });
      return promise;
    }),
  );
  return requests;
}

afterEach(() => vi.unstubAllGlobals());

describe("visible thread open acknowledgements", () => {
  it("transfers Home's exact in-flight operation to visible Chat without a duplicate PATCH", async () => {
    const client = new QueryClient();
    const requests = controlledRequests();
    const offer = prepareHomeOpenAcknowledgement(client, {
      projectId: "project-1",
      threadId: "thread-1",
    });
    expect(offer.kind).toBe("transfer");
    if (offer.kind !== "transfer") return;
    const lease = createVisibilityLeaseId();
    const claimed = claimVisibleOpenAcknowledgement(
      client,
      offer.transfer.key,
      lease,
      offer.transfer,
    );
    expect(claimed).toBe(offer.transfer.id);
    expect(requests.map((request) => request.body)).toEqual([{ isUnread: false }]);

    requests[0]?.resolve(json({ message: "offline" }, 503));
    await tick();
    expect(getOpenAcknowledgementState(client, claimed)).toMatchObject({
      phase: "failed",
      id: claimed,
      attempt: 1,
    });
  });

  it("keeps manual failure separate, retries one epoch, retires it, and reopens with a new id", async () => {
    const client = new QueryClient();
    const requests = controlledRequests();
    const manual = runThreadUserStateCommand(client, "project-1", "thread-1", "isUnread", true);
    const lease = createVisibilityLeaseId();
    const firstId = claimVisibleOpenAcknowledgement(
      client,
      { projectId: "project-1", threadId: "thread-1" },
      lease,
    );
    expect(requests.map((request) => request.body)).toEqual([{ isUnread: true }]);
    requests[0]?.resolve(json({ message: "manual offline" }, 503));
    await expect(manual).resolves.toMatchObject({ status: "error" });
    expect(requests.map((request) => request.body)).toEqual([
      { isUnread: true },
      { isUnread: false },
    ]);
    expect(getOpenAcknowledgementState(client, firstId)).toMatchObject({ phase: "pending" });

    requests[1]?.resolve(json({ message: "open offline" }, 503));
    await tick();
    expect(getOpenAcknowledgementState(client, firstId)).toMatchObject({ phase: "failed" });
    retryOpenAcknowledgement(client, firstId);
    expect(requests.map((request) => request.body)).toEqual([
      { isUnread: true },
      { isUnread: false },
      { isUnread: false },
    ]);
    requests[2]?.resolve(json(response));
    await tick();
    await tick();
    expect(getOpenAcknowledgementState(client, firstId)).toMatchObject({
      phase: "succeeded",
      attempt: 2,
    });

    releaseVisibleOpenAcknowledgement(client, lease);
    await Promise.resolve();
    expect(getOpenAcknowledgementState(client, firstId)).toBeNull();
    const secondId = claimVisibleOpenAcknowledgement(
      client,
      { projectId: "project-1", threadId: "thread-1" },
      createVisibilityLeaseId(),
    );
    expect(secondId).not.toBe(firstId);
    expect(requests.at(-1)?.body).toEqual({ isUnread: false });
  });

  it("cancels an unclaimed transfer deterministically without cancelling its transport", async () => {
    const client = new QueryClient();
    const requests = controlledRequests();
    const offer = prepareHomeOpenAcknowledgement(client, {
      projectId: "project-1",
      threadId: "thread-1",
    });
    if (offer.kind !== "transfer") return;
    cancelOpenAcknowledgementTransfer(client, offer.transfer);
    requests[0]?.resolve(json(response));
    await tick();
    await tick();
    expect(getOpenAcknowledgementState(client, offer.transfer.id)).toBeNull();
  });

  it("does not let a queued release detach a different key reclaimed by the same lease", async () => {
    const client = new QueryClient();
    const requests = controlledRequests();
    const lease = createVisibilityLeaseId();
    const firstId = claimVisibleOpenAcknowledgement(
      client,
      { projectId: "project-1", threadId: "thread-1" },
      lease,
    );
    releaseVisibleOpenAcknowledgement(client, lease);
    const secondId = claimVisibleOpenAcknowledgement(
      client,
      { projectId: "project-1", threadId: "thread-2" },
      lease,
    );

    await Promise.resolve();
    expect(requests).toHaveLength(2);
    requests[0]?.resolve(json(response));
    requests[1]?.resolve(json({ message: "offline" }, 503));
    await tick();
    await tick();

    expect(secondId).not.toBe(firstId);
    expect(getOpenAcknowledgementState(client, firstId)).toBeNull();
    expect(getOpenAcknowledgementState(client, secondId)).toMatchObject({
      phase: "failed",
      id: secondId,
      attempt: 1,
    });

    retryOpenAcknowledgement(client, secondId);
    expect(requests.map((request) => request.body)).toEqual([
      { isUnread: false },
      { isUnread: false },
      { isUnread: false },
    ]);
    requests[2]?.resolve(json({ ...response, threadId: "thread-2" }));
    await tick();
    await tick();
    expect(getOpenAcknowledgementState(client, secondId)).toMatchObject({
      phase: "succeeded",
      attempt: 2,
    });

    releaseVisibleOpenAcknowledgement(client, lease);
    await Promise.resolve();
    expect(getOpenAcknowledgementState(client, secondId)).toBeNull();
  });

  it.each([
    "settled",
    "pending",
  ] as const)("retires a %s mismatched transfer while claiming the visible key directly", async (phase) => {
    const client = new QueryClient();
    const requests = controlledRequests();
    const offer = prepareHomeOpenAcknowledgement(client, {
      projectId: "project-1",
      threadId: "thread-1",
    });
    if (offer.kind !== "transfer") return;

    if (phase === "settled") {
      requests[0]?.resolve(json(response));
      await tick();
      await tick();
      expect(getOpenAcknowledgementState(client, offer.transfer.id)).toMatchObject({
        phase: "succeeded",
      });
    }

    const claimed = claimVisibleOpenAcknowledgement(
      client,
      { projectId: "project-1", threadId: "thread-2" },
      createVisibilityLeaseId(),
      offer.transfer,
    );
    expect(claimed).not.toBe(offer.transfer.id);

    if (phase === "settled") {
      expect(getOpenAcknowledgementState(client, offer.transfer.id)).toBeNull();
      requests[1]?.resolve(json({ ...response, threadId: "thread-2" }));
    } else {
      expect(getOpenAcknowledgementState(client, offer.transfer.id)).toMatchObject({
        phase: "pending",
      });
      requests[0]?.resolve(json(response));
      requests[1]?.resolve(json({ ...response, threadId: "thread-2" }));
    }
    await tick();
    await tick();

    expect(getOpenAcknowledgementState(client, offer.transfer.id)).toBeNull();
    expect(getOpenAcknowledgementState(client, claimed)).toMatchObject({ phase: "succeeded" });
  });
});
