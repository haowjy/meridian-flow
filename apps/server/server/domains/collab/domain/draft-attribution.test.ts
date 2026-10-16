/** The attribution read caches its restoration links per branch state, and a deletion alone can create one. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDraftAttribution } from "./draft-attribution.js";

function peer(from: Y.Doc, clientID: number) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
  return doc;
}
const textOf = (doc: Y.Doc) =>
  (doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;

describe("draft attribution links", () => {
  it("refreshes when only a deletion changed them", async () => {
    const draft = new Y.Doc({ gc: false });
    draft.clientID = 1;
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("alpha tail")]);
    draft.getXmlFragment("prosemirror").insert(0, [paragraph]);
    const sync = (from: Y.Doc) => Y.applyUpdate(draft, Y.encodeStateAsUpdate(from));
    const ai = peer(draft, 2);
    textOf(ai).insert(6, "OLD ");
    sync(ai);
    // The writer retypes the same words in front of the AI's; no link exists while both are alive.
    const writer = peer(draft, 100);
    textOf(writer).insert(6, "OLD ");
    sync(writer);
    const service = createDraftAttribution(
      { pendingAgentEdits: async () => [], projectUserId: async () => "u" },
      {
        getBranch: async () =>
          ({
            state: Y.encodeStateAsUpdate(draft),
            stateVector: Y.encodeStateVector(draft),
          }) as never,
      },
    );
    const item = { itemKey: "doc", draftBranchId: "branch" };
    expect((await service.forItem(item)).restorations).toEqual([]);

    const later = peer(draft, 101);
    textOf(later).delete(10, 4); // the AI's copy goes; the state vector does not move
    sync(later);
    expect((await service.forItem(item)).restorations).toEqual([[100, 0, 4, 2, 0]]);
  });
});
