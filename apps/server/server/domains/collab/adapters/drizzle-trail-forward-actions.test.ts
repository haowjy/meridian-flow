/** Forward-action placement planning against live Yjs identities. */
import {
  createAgentEditCodec,
  decodeNavigationPosition,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { deletionBoundaryTarget, type TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { planTrailForwardAction } from "./drizzle-trail-forward-actions.js";

it("plans Restore at a validated live-root boundary", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const doc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(doc), null, codec.parse("Survivor."));
  const next = doc.getXmlFragment("prosemirror").get(0);
  if (!(next instanceof Y.XmlElement)) throw new Error("missing anchor");
  const change: TrailChangeV1 = {
    changeId: "change",
    ordinal: 0,
    documentId: "doc",
    pushId: null,
    receiptId: null,
    kind: "delete",
    beforeBlockId: "before",
    afterBlockId: null,
    beforeText: "before|Restored.",
    afterTextAtReceipt: null,
    navigation: deletionBoundaryTarget({ doc, next }),
    swept: null,
    writerProtection: {
      kind: "sweep",
      body: { status: "available", markdown: "Restored." },
    },
    reversible: false,
  };
  if (change.navigation.kind !== "deletion_boundary") throw new Error("missing boundary");
  const scratch = createCollabYDoc({ gc: false });
  Y.applyUpdate(scratch, Y.encodeStateAsUpdate(doc));
  const scratchRoot = scratch.getXmlFragment("prosemirror");
  const absolute = Y.createAbsolutePositionFromRelativePosition(
    decodeNavigationPosition(change.navigation.position),
    scratch,
  );
  expect(absolute?.type).toBe(scratchRoot);

  const planned = planTrailForwardAction({
    liveDoc: doc,
    change,
    action: "restore",
    model,
    codec,
  });
  expect(planned).not.toBeNull();
  if (planned) Y.applyUpdate(doc, planned.update);
  expect(codec.serialize(model.projectBlocks(toDocHandle(doc)))).toContain("Restored.");
});
