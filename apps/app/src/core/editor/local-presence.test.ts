/** Two views of one session share its presence: only the one in front may speak. */

import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createLocalPresence, gateLocalPresence } from "./local-presence";

function twoViews() {
  const awareness = new Awareness(new Y.Doc());
  const presence = createLocalPresence(awareness);
  let front: "tab" | "dock" = "tab";
  const tab = gateLocalPresence(presence, () => front === "tab");
  const dock = gateLocalPresence(presence, () => front === "dock");
  return {
    tab,
    dock,
    cursor: () => awareness.getLocalState()?.cursor,
    bring: (view: "tab" | "dock") => {
      front = view;
    },
  };
}

describe("gateLocalPresence", () => {
  it("drops a back view's writes, so it cannot clear the front view's caret", () => {
    const { tab, dock, cursor, bring } = twoViews();
    tab.setField("cursor", { anchor: 1 });
    bring("dock");
    dock.setField("cursor", { anchor: 7 });

    // y-prosemirror clears a caret it believes is its own whenever its editor updates unfocused.
    tab.setField("cursor", null);
    tab.setField("cursor", { anchor: 3 });

    expect(cursor()).toEqual({ anchor: 7 });
  });

  it("lets a view retire the caret it left behind when it goes to the back", () => {
    const { tab, cursor, bring } = twoViews();
    tab.setField("cursor", { anchor: 4 });
    bring("dock");

    tab.setField("cursor", null);

    expect(cursor()).toBeNull();
  });
});
