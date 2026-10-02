/**
 * Recents are posted only once the server holds the document, so opening a
 * just-created document never asks the server about one it does not have yet.
 */
import type { ResourceProjectionSnapshot, ResourceRecord } from "@meridian/resource-replica";
import { describe, expect, it, vi } from "vitest";

import { type ServerPresenceSource, whenOnServer } from "./use-record-opened-document";

const record = (lifecycle: ResourceRecord["resource"]["lifecycle"]) =>
  ({ resource: { identity: { documentId: "doc-1" }, lifecycle } }) as ResourceRecord;

function source(initial: ResourceRecord | null) {
  let listener: ((snapshot: ResourceProjectionSnapshot) => void) | null = null;
  const stop = vi.fn();
  const fake: ServerPresenceSource = {
    readKnownDocument: async () => (initial ? { record: initial } : null),
    observeProjection: (_projectId, next) => {
      listener = next;
      return stop;
    },
  };
  const publish = (records: ResourceRecord[]) => listener?.({ records, catalogs: [] });
  return { fake, publish, stop };
}

describe("whenOnServer", () => {
  it("answers at once for a document the server already has", async () => {
    const signal = new AbortController().signal;
    expect(await whenOnServer(source(null).fake, "p", "doc-1", signal)).toBe(true);
    const acknowledged = record({ kind: "acknowledged", availabilityGeneration: null });
    expect(await whenOnServer(source(acknowledged).fake, "p", "doc-1", signal)).toBe(true);
  });

  it("waits for a local create to be acknowledged", async () => {
    const { fake, publish, stop } = source(record({ kind: "local" }));
    let settled: boolean | null = null;
    const waiting = whenOnServer(fake, "p", "doc-1", new AbortController().signal).then((value) => {
      settled = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    publish([record({ kind: "local" })]);
    expect(settled).toBeNull();
    publish([record({ kind: "acknowledged", availabilityGeneration: null })]);
    await waiting;
    expect(settled).toBe(true);
    expect(stop).toHaveBeenCalled();
  });

  it("gives up when the document ends locally or the account closes", async () => {
    const ended = source(record({ kind: "local" }));
    const gone = whenOnServer(ended.fake, "p", "doc-1", new AbortController().signal);
    await Promise.resolve();
    await Promise.resolve();
    ended.publish([record({ kind: "terminal", generation: "1", transitionId: "t" })]);
    expect(await gone).toBe(false);

    const closing = new AbortController();
    const aborted = whenOnServer(
      source(record({ kind: "local" })).fake,
      "p",
      "doc-1",
      closing.signal,
    );
    await Promise.resolve();
    closing.abort();
    expect(await aborted).toBe(false);
  });
});
