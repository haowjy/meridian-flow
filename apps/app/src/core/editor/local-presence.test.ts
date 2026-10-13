/** Awareness follows draft authorship rotation, including while presence is suspended. */
import { describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createLocalPresence, gateCaretPresence } from "./local-presence";

it.each([
  false,
  true,
])("retires the old cursor and migrates current fields (suspended: %s)", (suspended) => {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const remoteDoc = new Y.Doc();
  const remote = new Awareness(remoteDoc);
  const presence = createLocalPresence(awareness);
  const gate = gateCaretPresence(presence, () => true);
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
  gate.presence.adoptDocumentClient();
  expect(awareness.clientID).toBe(doc.clientID);
  expect(presence.caretProvider.awareness.clientID).toBe(doc.clientID);
  expect(gate.presence.caretProvider.awareness.clientID).toBe(doc.clientID);
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

function twoViews() {
  const awareness = new Awareness(new Y.Doc());
  const presence = createLocalPresence(awareness);
  let front: "tab" | "dock" = "tab";
  const tab = gateCaretPresence(presence, () => front === "tab");
  const dock = gateCaretPresence(presence, () => front === "dock");
  const caret = (view: typeof tab, value: unknown) =>
    view.presence.caretProvider.awareness.setLocalStateField("cursor", value);
  return {
    tab,
    dock,
    caret,
    state: () => awareness.getLocalState(),
    bring: (view: "tab" | "dock") => {
      front = view;
    },
  };
}

describe("gateCaretPresence", () => {
  it("drops a back view's caret writes, so it cannot clear the front view's", () => {
    const { tab, dock, caret, state, bring } = twoViews();
    caret(tab, { anchor: 1 });
    tab.retire();
    bring("dock");
    caret(dock, { anchor: 7 });

    // y-prosemirror clears a caret it believes is its own whenever its editor updates unfocused.
    caret(tab, null);
    caret(tab, { anchor: 3 });

    expect(state()?.cursor).toEqual({ anchor: 7 });
  });

  it("retires its caret when no one else has published, and not after the front view's equal one", () => {
    const { tab, dock, caret, state, bring } = twoViews();
    caret(tab, { anchor: 4, head: 4 });
    bring("dock");
    tab.retire();
    expect(state()?.cursor).toBeNull();

    // Retire first, then the dock publishes an equal cursor: a second retire is a no-op.
    caret(dock, { anchor: 4, head: 4 });
    tab.retire();
    expect(state()?.cursor).toEqual({ anchor: 4, head: 4 });
  });

  it("does not let a late retire clear an equal caret the front view published first", () => {
    const { tab, dock, caret, state, bring } = twoViews();
    caret(tab, { anchor: 4, head: 4 });
    bring("dock");
    caret(dock, { anchor: 4, head: 4 });

    tab.retire();

    expect(state()?.cursor).toEqual({ anchor: 4, head: 4 });
  });

  it("lets an upload announcement clear while its view is in the back", () => {
    const { tab, bring, state } = twoViews();
    tab.presence.setField("imageUploads", ["token"]);
    bring("dock");

    tab.presence.setField("imageUploads", []);

    expect(state()?.imageUploads).toEqual([]);
  });
});
