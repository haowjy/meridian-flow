import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { DocumentSession } from "./document-session";

it("remints identity while preserving Y.Doc, awareness, provider, exact P, and words", async () => {
  const session = new DocumentSession({
    roomKey: "A",
    persistence: { kind: "indexeddb", key: "opaque-lineage-p" },
  });
  await session.whenLocalPersistenceSynced();
  const paragraph = new Y.XmlElement("paragraph");
  paragraph.insert(0, [new Y.XmlText("the words stay")]);
  session.document.getXmlFragment(session.fragmentName).insert(0, [paragraph]);
  const before = {
    document: session.document,
    awareness: session.awareness,
    provider: session.localPersistenceProvider,
    name: session.persistenceName,
  };

  const prepared = session.prepareDetachedReidentity("B");
  prepared.commit();

  expect(session.documentId).toBe("B");
  expect(session.document).toBe(before.document);
  expect(session.awareness).toBe(before.awareness);
  expect(session.localPersistenceProvider).toBe(before.provider);
  expect(session.persistenceName).toBe(before.name);
  expect(session.document.getXmlFragment(session.fragmentName).toString()).toContain(
    "the words stay",
  );
  await session.destroy();
});
