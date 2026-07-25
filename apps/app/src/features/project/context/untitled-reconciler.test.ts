/** Stateful lifecycle coverage for untitled document reconciliation. */

import type {
  CreateUntitledContextDocumentResponse,
  MoveContextEntryResult,
} from "@meridian/contracts/protocol";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  documentWithText,
  LifecycleSession,
  lifecycleGate,
  UNTITLED_HOME,
  UntitledLifecycleRig,
} from "./test-support/UntitledLifecycleRig";
import { resolveUntitledHome, untitledDocumentIsEmpty } from "./untitled-reconciler";

const OPENING = {
  name: "Opening.md",
  destination: { scheme: "manuscript", folderPath: "Act 1" },
} as const;

function created(documentId = "doc-1"): CreateUntitledContextDocumentResponse {
  return {
    status: "created",
    documentId,
    scheme: "scratch",
    path: "/Untitled",
    name: "Untitled",
  };
}

describe("untitled reconciler lifecycle", () => {
  it("rehydrates durable work once and tears down online and retry scheduling", async () => {
    const rig = new UntitledLifecycleRig();
    rig.storage.set(
      "meridian:pending-untitled",
      JSON.stringify([
        {
          documentId: "doc-1",
          revision: 1,
          materialization: {
            phase: "pending",
            entry: { documentId: "doc-1", projectId: "project-1" },
          },
          pendingSinceMs: 0,
        },
      ]),
    );
    rig.home.setFallback(async () => null);

    rig.start();
    rig.start();
    expect(rig.onlineListeners.size).toBe(1);
    expect(rig.queued).toHaveLength(1);
    await rig.advance();
    expect(rig.records()).toEqual([
      expect.objectContaining({
        documentId: "doc-1",
        materialization: { phase: "pending", entry: expect.any(Object) },
      }),
    ]);
    expect(rig.create.calls).toEqual([]);
    expect(rig.timers).toHaveLength(1);

    rig.reconciler.dispose();
    expect(rig.onlineListeners.size).toBe(0);
    expect(rig.timers).toHaveLength(0);
  });

  it("preserves identity edits made while durable sync is gated", async () => {
    const rig = new UntitledLifecycleRig();
    const durableGate = lifecycleGate<void>();
    const session = new LifecycleSession(documentWithText());
    session.waitForDurable(durableGate);
    rig.replaceSession("doc-1", session);
    rig.start();
    rig.append("doc-1");

    rig.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    rig.queueIdentity("doc-1", "Opening.md");
    expect(rig.records()[0]?.desiredIdentity?.name).toBe("Opening.md");

    durableGate.resolve();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await rig.advance();
    expect(rig.move.calls.at(-1)?.[2]).toEqual(OPENING);
    expect(rig.records()).toEqual([]);
  });

  it("rebases the newest identity on the canonical result of an in-flight move", async () => {
    const rig = new UntitledLifecycleRig();
    const firstMove = lifecycleGate<MoveContextEntryResult>();
    rig.create.enqueueResult(created(), {
      status: "already-materialized",
      documentId: "doc-1",
      scheme: "manuscript",
      path: "/Act 1/First.md",
      name: "First.md",
    });
    rig.move.enqueueHandler(() => firstMove.promise);
    rig.start();
    rig.queueIdentity("doc-1", "First.md");

    rig.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    rig.queueIdentity("doc-1", "Latest.md", "Act 2");
    firstMove.resolve({
      status: "moved",
      scheme: "manuscript",
      path: "Act 1/First.md",
      name: "First.md",
    });
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await rig.advance();

    expect(rig.move.calls.at(-1)?.[1]).toMatchObject({ path: "/Act 1/First.md" });
    expect(rig.move.calls.at(-1)?.[2]).toMatchObject({ name: "Latest.md" });
    expect(rig.records()).toEqual([]);
  });

  it("restores an explicitly named empty document and materializes it after reload", async () => {
    const rig = new UntitledLifecycleRig();
    rig.replaceSession("doc-1", new LifecycleSession(documentWithText("")));
    rig.start();
    rig.reconciler.queueIdentity({ documentId: "doc-1", projectId: "project-1" }, OPENING);

    rig.restart();
    await rig.advance(); // callback left by the disposed instance
    await rig.advance();

    expect(rig.create.calls.at(-1)?.[0]).toMatchObject({
      documentId: "doc-1",
      home: UNTITLED_HOME,
    });
    expect(rig.move.calls.at(-1)?.[2]).toEqual(OPENING);
    expect(rig.records()).toEqual([]);
    expect(rig.clearedRooms).toEqual([]);
  });
});

describe("empty and denied room recovery", () => {
  it("drops an empty device-only record only after the server confirms no row", async () => {
    const rig = new UntitledLifecycleRig();
    rig.replaceSession("doc-1", new LifecycleSession(documentWithText("")));
    rig.start();
    rig.append("doc-1");
    await rig.advance();

    expect(rig.exists.calls).toHaveLength(1);
    expect(rig.create.calls).toEqual([]);
    expect(rig.records()).toEqual([]);
    expect(rig.clearedRooms).toEqual([]);
  });

  it("materializes an empty open candidate without probing for a server row", async () => {
    const rig = new UntitledLifecycleRig();
    rig.replaceSession("doc-1", new LifecycleSession(documentWithText("")));
    rig.start();
    rig.trackCandidate("doc-1");
    rig.append("doc-1");
    await rig.advance();

    expect(rig.exists.calls).toEqual([]);
    expect(rig.create.calls).toHaveLength(1);
    expect(rig.materialized).toEqual([expect.objectContaining({ documentId: "doc-1" })]);
  });

  it("keeps the pending room when the writer types during the no-row check", async () => {
    const rig = new UntitledLifecycleRig();
    const existsGate = lifecycleGate<boolean>();
    const session = new LifecycleSession(documentWithText(""));
    rig.replaceSession("doc-1", session);
    rig.exists.enqueueHandler(() => existsGate.promise);
    rig.start();
    rig.append("doc-1");

    rig.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("words typed during the check")]);
    session.document.getXmlFragment("prosemirror").insert(0, [paragraph]);
    existsGate.resolve(false);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();

    expect(rig.create.calls).toEqual([]);
    expect(rig.records()).toEqual([
      expect.objectContaining({
        documentId: "doc-1",
        materialization: expect.objectContaining({ phase: "pending" }),
      }),
    ]);
    expect(untitledDocumentIsEmpty(session.document.getXmlFragment("prosemirror"))).toBe(false);
  });

  it("attaches and durably flushes empty history when the server row exists", async () => {
    const rig = new UntitledLifecycleRig();
    const session = new LifecycleSession(documentWithText(""));
    rig.replaceSession("doc-1", session);
    rig.exists.enqueueResult(true);
    rig.create.enqueueResult({ ...created(), status: "already-materialized" });
    rig.start();
    rig.append("doc-1");
    await rig.advance();

    expect(session.durableSyncCount).toBe(1);
    expect(rig.records()).toEqual([]);
  });

  it("restarts an access-lost room and continues draining healthy entries", async () => {
    const rig = new UntitledLifecycleRig();
    const denied = rig.session("denied", "first");
    denied.setStatus("access-lost");
    rig.session("healthy", "second");
    rig.start();
    rig.append("denied");
    rig.append("healthy");
    await rig.advance();

    expect(rig.restartedRooms).toContain("denied");
    expect(rig.create.calls).toHaveLength(2);
    expect(rig.records()).toEqual([]);
  });
});

describe("collision recovery and durable receipts", () => {
  it("persists the reminted room before clearing the original", async () => {
    const rig = new UntitledLifecycleRig();
    const flushGate = lifecycleGate<void>();
    rig.create.enqueueResult({ status: "conflict" });
    rig.session("original", "irreplaceable words");
    const replacement = rig.session("replacement", "");
    replacement.waitForPersistenceFlush(flushGate);
    rig.start();
    rig.append("original");

    rig.queued.shift()?.();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(rig.records()[0]?.documentId).toBe("original");

    flushGate.resolve();
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    expect(rig.records()[0]?.documentId).toBe("replacement");
    expect(rig.clearedRooms).toEqual(["original"]);
    expect(untitledDocumentIsEmpty(replacement.document.getXmlFragment("prosemirror"))).toBe(false);
  });

  it("leaves the replacement recoverable when original cleanup is interrupted", async () => {
    const rig = new UntitledLifecycleRig();
    rig.create.enqueueResult({ status: "conflict" });
    rig.session("original", "irreplaceable words");
    const replacement = rig.session("replacement", "");
    rig.destroyRoomError = new Error("interrupted before original cleanup");
    rig.start();
    rig.append("original");
    await rig.advance();

    expect(rig.records()).toEqual([
      expect.objectContaining({
        documentId: "replacement",
        materialization: expect.objectContaining({
          entry: expect.objectContaining({ documentId: "replacement" }),
        }),
      }),
    ]);
    expect(untitledDocumentIsEmpty(replacement.document.getXmlFragment("prosemirror"))).toBe(false);
  });

  it("replays canonical materialization and identity receipts to a restored tab", async () => {
    const rig = new UntitledLifecycleRig();
    rig.start();
    rig.queueIdentity("doc-1", "Opening.md");
    await rig.advance();
    rig.trackCandidate("doc-1");

    expect(rig.materialized).toEqual([
      expect.objectContaining({ documentId: "doc-1", scheme: "manuscript", name: "Opening.md" }),
    ]);
    expect(rig.identities).toEqual([
      expect.objectContaining({ status: "moved", scheme: "manuscript", name: "Opening.md" }),
    ]);
  });

  it("evicts only unowned receipts beyond the replay cap", async () => {
    const rig = new UntitledLifecycleRig();
    rig.start();
    for (let index = 0; index < 17; index += 1) {
      rig.append(`doc-${index}`);
      await rig.advance();
    }
    rig.trackCandidate("doc-0");
    rig.trackCandidate("doc-16");
    expect(rig.materialized.map(({ documentId }) => documentId)).toEqual(["doc-16"]);

    const owned = new UntitledLifecycleRig();
    owned.start();
    owned.reconciler.setMaterializationReceiptOwners(
      new Set(Array.from({ length: 17 }, (_, index) => `doc-${index}`)),
    );
    for (let index = 0; index < 17; index += 1) {
      owned.append(`doc-${index}`);
      await owned.advance();
    }
    owned.trackCandidate("doc-0");
    expect(owned.materialized.map(({ documentId }) => documentId)).toEqual(["doc-0"]);
  });
});

describe("queued identity outcomes", () => {
  it.each([
    { label: "stale source", first: { status: "retry", reason: "stale-source" } as const },
    { label: "offline", first: new TypeError("offline") },
  ])("retains identity intent and retries after $label", async ({ first }) => {
    const rig = new UntitledLifecycleRig();
    if (first instanceof Error) rig.move.enqueueError(first);
    else rig.move.enqueueResult(first);
    rig.move.enqueueResult({
      status: "moved",
      scheme: "manuscript",
      path: "Act 1/Opening.md",
      name: "Opening.md",
    });
    rig.start();
    rig.queueIdentity("doc-1", "Opening.md");

    await rig.advance();
    expect(rig.records()[0]?.desiredIdentity?.name).toBe("Opening.md");
    expect(rig.reconciler.queuedIdentityFailure("doc-1")).toBeNull();
    await rig.retry();

    expect(rig.move.calls).toHaveLength(2);
    expect(rig.records()).toEqual([]);
  });

  it("retries rehydrated identity work immediately when connectivity returns", async () => {
    const rig = new UntitledLifecycleRig();
    rig.storage.set(
      "meridian:pending-untitled",
      JSON.stringify([
        {
          documentId: "doc-1",
          revision: 1,
          materialization: {
            phase: "pending",
            entry: { documentId: "doc-1", projectId: "project-1", home: UNTITLED_HOME },
          },
          desiredIdentity: OPENING,
          pendingSinceMs: Date.now(),
        },
      ]),
    );
    rig.move.enqueueError(new TypeError("offline"));
    rig.start();
    await rig.advance();

    rig.notifyOnline();
    await rig.advance();
    expect(rig.move.calls).toHaveLength(2);
    expect(rig.records()).toEqual([]);
  });

  it("stores a terminal conflict apart from materialization and clears it explicitly", async () => {
    const rig = new UntitledLifecycleRig();
    rig.move.enqueueResult({
      status: "conflict",
      collision: { scheme: "scratch", path: "taken.md", workId: "work-1" },
    });
    rig.start();
    rig.append("doc-1");
    rig.queueIdentity("doc-1", "taken.md", "/");
    await rig.advance();

    expect(rig.reconciler.has("doc-1")).toBe(false);
    expect(rig.reconciler.pendingSince("doc-1")).toBeNull();
    expect(rig.reconciler.queuedIdentityFailure("doc-1")).toEqual({
      kind: "conflict",
      name: "taken.md",
      scheme: "scratch",
      path: "/taken.md",
      workId: "work-1",
    });

    rig.reconciler.clearQueuedIdentityFailure("doc-1");
    expect(rig.records()).toEqual([]);
  });
});

describe("untitled document decisions", () => {
  it("resolves the default work scratch root through one seam", () => {
    expect(resolveUntitledHome("work-1")).toEqual(UNTITLED_HOME);
    expect(resolveUntitledHome(null)).toBeNull();
  });

  it("treats structural paragraphs as empty and atoms as content", () => {
    const document = documentWithText("");
    const fragment = document.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("paragraph")]);
    expect(untitledDocumentIsEmpty(fragment)).toBe(true);
    fragment.delete(0, 1);
    fragment.insert(0, [new Y.XmlElement("figure")]);
    expect(untitledDocumentIsEmpty(fragment)).toBe(false);
  });
});
