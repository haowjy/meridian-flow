/** Contract tests for cached, delete-set-aware document containment. */

import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";

describe("document containment", () => {
  it("invalidates its snapshot after a delete-only document mutation", () => {
    const document = new Y.Doc({ gc: false });
    document.getText("content").insert(0, "retained history");
    const client = new Y.Doc({ gc: false });
    Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
    const beforeDelete = Y.encodeStateVector(client);
    client.getText("content").delete(0, 8);
    const deleteOnly = Y.encodeStateAsUpdate(client, beforeDelete);
    expect(Y.decodeUpdate(deleteOnly).structs).toHaveLength(0);

    const containment = createDocumentContainment();
    expect(containment.contains(document, deleteOnly)).toBe(false);

    Y.applyUpdate(document, deleteOnly);
    expect(containment.contains(document, deleteOnly)).toBe(true);
  });

  it("rejects struct novelty and exactly accepts contained updates", () => {
    const document = new Y.Doc({ gc: false });
    document.getText("content").insert(0, "current");
    const currentState = Y.encodeStateAsUpdate(document);
    const client = new Y.Doc({ gc: false });
    Y.applyUpdate(client, currentState);
    const beforeInsert = Y.encodeStateVector(client);
    client.getText("content").insert(7, " novel");

    const containment = createDocumentContainment();
    expect(containment.contains(document, currentState)).toBe(true);
    expect(containment.contains(document, Y.encodeStateAsUpdate(client, beforeInsert))).toBe(false);
  });
});
