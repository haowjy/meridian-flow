/** Awareness follows draft authorship rotation, including while presence is suspended. */
import { expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createLocalPresence } from "./local-presence";

it.each([
  false,
  true,
])("retires the old cursor and migrates current fields (suspended: %s)", (suspended) => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  const presence = createLocalPresence(awareness);
  awareness.on(
    "update",
    ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      applyAwarenessUpdate(
        remote,
        encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]),
        "wire",
      );
    },
  );
  presence.setField("cursor", { anchor: "relative" });
  const old = doc.clientID;
  if (suspended) presence.suspend();
  doc.clientID = old === 123456 ? 123457 : 123456;
  presence.adoptDocumentClient();
  expect(awareness.clientID).toBe(doc.clientID);
  expect(presence.caretProvider.awareness.clientID).toBe(doc.clientID);
  expect(remote.getStates().has(old)).toBe(false);
  if (suspended) {
    expect(awareness.getLocalState()).toBeNull();
    presence.setField("user", { name: "Writer" });
    presence.resume();
  }
  expect(remote.getStates().get(doc.clientID)?.cursor).toEqual({ anchor: "relative" });
  awareness.destroy();
  remote.destroy();
  doc.destroy();
  remoteDoc.destroy();
});
