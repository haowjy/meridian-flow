/**
 * Runtime probe: figure projection no longer throws and re-seeds identically.
 * Simulates onStoreDocument readAsMdx + rebuild-from-projection writeDocFromMdx.
 */
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import {
  prosemirrorToYXmlFragment,
  updateYFragment,
  yXmlFragmentToProseMirrorRootNode,
} from "y-prosemirror";
import * as Y from "yjs";
import { documentMdxSchema } from "../server/domains/collab/domain/mdx-bridge.js";
import { getSchema, mdxToNode, nodeToMdx } from "../server/domains/collab/domain/schemas.js";

const schema = documentMdxSchema();

const figureDoc = schema.node("doc", null, [
  schema.node("paragraph", null, [schema.text("Chapter with a map.")]),
  schema.node("figure", {
    src: "uploads://work-1/realm-map.png",
    alt: "Realm map",
    caption: "The northern provinces",
    label: "fig-realm",
  }),
]);

console.log("=== BEFORE (prosemirror-markdown era) ===");
console.log("Serializing a doc with figure node would THROW — no markdown mapping.");

console.log("\n=== AFTER (MDX bridge) ===");
let projection: string;
try {
  projection = nodeToMdx("document", figureDoc);
  console.log("Projection succeeded:");
  console.log(projection);
} catch (error) {
  console.error("Projection THREW:", error);
  process.exit(1);
}

const ydoc = new Y.Doc();
prosemirrorToYXmlFragment(figureDoc, ydoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));

const rebuilt = mdxToNode("document", projection);
updateYFragment(ydoc, ydoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), rebuilt, {
  mapping: new Map(),
  isOMark: new Map(),
});

const reread = yXmlFragmentToProseMirrorRootNode(
  ydoc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  getSchema("document"),
);

const identical = figureDoc.eq(reread);
console.log("\nRe-seed from projection identical:", identical);
if (!identical) {
  console.error("ORIG:", JSON.stringify(figureDoc.toJSON(), null, 2));
  console.error("REREAD:", JSON.stringify(reread.toJSON(), null, 2));
  process.exit(1);
}

console.log("PASS: figure projection + rebuild is lossless.");
