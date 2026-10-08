/** Two views of one session share its presence: only the one in front may show a caret. */

import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createLocalPresence, gateCaretPresence } from "./local-presence";

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
