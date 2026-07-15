// Contract proofs for response-scoped observation authority.

import { describe, expect, it } from "vitest";
import {
  createObservationAuthority,
  digestRenderedContent,
  type ObservationSnapshot,
  type ObservationSnapshotStore,
  observationCoversRendering,
} from "./index.js";

class MemoryStore implements ObservationSnapshotStore {
  readonly snapshots = new Map<string, ObservationSnapshot>();

  async seal(snapshot: ObservationSnapshot): Promise<void> {
    if (this.snapshots.has(snapshot.responseId)) throw new Error("response already sealed");
    this.snapshots.set(snapshot.responseId, structuredClone(snapshot));
  }

  async load(responseId: string): Promise<ObservationSnapshot | null> {
    return structuredClone(this.snapshots.get(responseId) ?? null);
  }
}

const docA = { documentId: "doc-a", clientID: 4_294_967_295, clock: 18 } as const;
const docB = { documentId: "doc-b", clientID: 8, clock: 3 } as const;

describe("ObservationSnapshot", () => {
  it("uses the canonical SHA-256 digest", () => {
    expect(digestRenderedContent("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("uses one exact-rendering predicate for both observation forms", () => {
    expect(
      observationCoversRendering({
        observation: {
          kind: "rendered",
          digest: digestRenderedContent("abc|Writer prose"),
        },
        renderedContent: "abc|Writer prose",
        digestRenderedContent,
      }),
    ).toBe(true);
    expect(
      observationCoversRendering({
        observation: { kind: "explicit_deletion", capturedBody: "Writer prose" },
        renderedContent: "abc|Writer prose",
        digestRenderedContent,
      }),
    ).toBe(true);
    expect(
      observationCoversRendering({
        observation: {
          kind: "rendered",
          digest: digestRenderedContent("abc|Older prose"),
        },
        renderedContent: "abc|Writer prose",
        digestRenderedContent,
      }),
    ).toBe(false);
  });

  it("gives sibling writes the one snapshot assembled before their response", async () => {
    const authority = createObservationAuthority({
      store: new MemoryStore(),
    });
    const request = authority.beginRequest("request-1");
    request.observeRendered({ ...docA, renderedContent: "paragraph|before siblings" });
    await authority.sealSuccessfulResponse("response-1", request);

    // W1's echo is produced while the sibling calls execute. It belongs to the next
    // request and cannot broaden the already-sealed response that also authored W2.
    const nextRequest = authority.beginRequest("request-2");
    nextRequest.observeRendered({ ...docA, renderedContent: "paragraph|echo after W1" });

    await expect(authority.lookup("response-1", docA)).resolves.toEqual({
      kind: "rendered",
      digest: digestRenderedContent("paragraph|before siblings"),
    });
  });

  it("creates no credit when a request fails", async () => {
    const store = new MemoryStore();
    const authority = createObservationAuthority({ store });
    const failed = authority.beginRequest("failed-request");
    failed.observeRendered({ ...docA, renderedContent: "paragraph|never delivered" });

    await expect(authority.load("missing-response")).resolves.toBeNull();
    expect(store.snapshots.size).toBe(0);
  });

  it("isolates concurrent request contexts even when they render the same identity", async () => {
    const authority = createObservationAuthority({
      store: new MemoryStore(),
    });
    const left = authority.beginRequest("thread-left");
    const right = authority.beginRequest("thread-right");
    left.observeRendered({ ...docA, renderedContent: "paragraph|left" });
    right.observeRendered({ ...docA, renderedContent: "paragraph|right" });
    await Promise.all([
      authority.sealSuccessfulResponse("response-left", left),
      authority.sealSuccessfulResponse("response-right", right),
    ]);

    await expect(authority.lookup("response-left", docA)).resolves.toEqual({
      kind: "rendered",
      digest: digestRenderedContent("paragraph|left"),
    });
    await expect(authority.lookup("response-right", docA)).resolves.toEqual({
      kind: "rendered",
      digest: digestRenderedContent("paragraph|right"),
    });
  });

  it("rebuilds the same candidate from re-assembled persisted results after restart", async () => {
    const store = new MemoryStore();
    const firstProcess = createObservationAuthority({ store });
    const original = firstProcess.beginRequest("original");
    original.observeRendered({ ...docA, renderedContent: "heading|# One" });
    original.observeExplicitDeletion({ ...docB, capturedBody: "deleted paragraph" });
    await firstProcess.sealSuccessfulResponse("before-restart", original);

    const restarted = createObservationAuthority({ store });
    const rebuilt = restarted.beginRequest("rebuilt-from-persisted-results");
    rebuilt.observeRendered({ ...docA, renderedContent: "heading|# One" });
    rebuilt.observeExplicitDeletion({ ...docB, capturedBody: "deleted paragraph" });
    await restarted.sealSuccessfulResponse("after-restart", rebuilt);

    const before = await restarted.load("before-restart");
    const after = await restarted.load("after-restart");
    expect(after?.entries).toEqual(before?.entries);
  });

  it("gives omitted and overflowed bodies no credit", async () => {
    const authority = createObservationAuthority({
      store: new MemoryStore(),
    });
    const candidate = authority.beginRequest("overflow");
    candidate.omit(docA, "sync_overflow");
    candidate.omit(docB, "omitted");
    await authority.sealSuccessfulResponse("overflow-response", candidate);

    await expect(authority.lookup("overflow-response", docA)).resolves.toBeNull();
    await expect(authority.lookup("overflow-response", docB)).resolves.toBeNull();
  });
});
