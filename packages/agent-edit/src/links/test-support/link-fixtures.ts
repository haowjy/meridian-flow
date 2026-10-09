// Shared fixtures for link-identity tests: a static catalog, ref-bearing seeds and stored-attr readback.
import { type CatalogDocument, documentRef, storedHref } from "@meridian/contracts";
import { walkLinkOccurrences } from "@meridian/markup";
import { PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { prosemirrorBlocksForDoc } from "../../model/y-prosemirror.js";
import {
  createStaticDocumentLinks,
  type StaticCatalogDocument,
  type StaticDocumentCatalog,
} from "../../ports/static-document-links.js";
import { codecFactory, harness, schema } from "../../tool/test-support/write-tool-harness.js";
import type { LinkSpliceFallbackDetail } from "../../tool/write-deps.js";
import type { ShownLink } from "../correspondence.js";

export const PROJECT = "11111111-1111-4111-8111-111111111111";

/** Readable UUIDs: refs only accept canonical UUIDs. */
export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

export function catalogDocument(
  id: string,
  uri: string,
  overrides: Partial<StaticCatalogDocument> = {},
): StaticCatalogDocument {
  return {
    documentId: id,
    projectId: PROJECT,
    uri,
    presence: "live",
    readable: true,
    nameable: true,
    ...overrides,
  };
}

/** One inline run: plain text, or a link stored as `{ ref, href, title }`. */
export type Segment = string | { text: string; ref: string | null; href: string; title?: string };

/** A linked run naming document `id` at `uri`, stored the way producers store it. */
export function docLink(text: string, id: string, uri: string, title?: string): Segment {
  return { text, ref: documentRef(id), href: storedHref(uri, ""), ...(title ? { title } : {}) };
}

export function paragraph(...segments: Segment[]): PMNode {
  return schema.node(
    "paragraph",
    null,
    segments
      .filter((segment) => (typeof segment === "string" ? segment : segment.text).length > 0)
      .map((segment) =>
        typeof segment === "string"
          ? schema.text(segment)
          : schema.text(segment.text, [
              schema.marks.link.create({
                href: segment.href,
                title: segment.title ?? null,
                ref: segment.ref,
              }),
            ]),
      ),
  );
}

export function docFromBlocks(blocks: readonly PMNode[], clientID: number): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = clientID;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, [...blocks]),
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  return doc;
}

export interface StoredLink {
  label: string;
  ref: string | null;
  href: string;
  title: string | null;
}

/** Every stored occurrence of a doc, in document order. */
export function storedLinks(doc: Y.Doc): StoredLink[] {
  return walkLinkOccurrences(prosemirrorBlocksForDoc(doc, schema)).map(({ label, attrs }) => ({
    label,
    ...attrs,
  }));
}

/** Every format item ever integrated (deleted ones too): a write's churn is the difference. */
export function formatItemCount(doc: Y.Doc): number {
  let count = 0;
  // biome-ignore lint/suspicious/noExplicitAny: Yjs types are invariant in their event type.
  const visit = (type: Y.AbstractType<any>) => {
    for (let item = type._start; item; item = item.right) {
      if (item.content instanceof Y.ContentFormat) count += 1;
      if (item.content instanceof Y.ContentType) visit(item.content.type);
    }
  };
  visit(doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME));
  return count;
}

/**
 * A write harness over a static catalog with one holder document, seeded from
 * nodes or given as a doc. Replacing `catalog.documents` moves a document; it
 * never writes to the holder.
 */
export function linkHarness(input: {
  holder: { id: string; uri: string };
  documents: readonly StaticCatalogDocument[];
  blocks?: readonly PMNode[];
  /** The holder's live doc itself (a merge-matrix client), instead of `blocks`. */
  doc?: Y.Doc;
  /** The agent runtime's Yjs client id, so client order is fixed. */
  runtimeClientID?: number;
  clientID?: number;
  settlements?: ReadonlyMap<string, string>;
  onLinkSpliceFallback?: (event: LinkSpliceFallbackDetail) => void;
}) {
  const catalog: StaticDocumentCatalog = {
    projectId: PROJECT,
    documents: [catalogDocument(input.holder.id, input.holder.uri), ...input.documents],
    ...(input.settlements ? { settlements: input.settlements } : {}),
  };
  const links = createStaticDocumentLinks(catalog);
  const ctx = harness(
    {},
    {
      links,
      ...(input.onLinkSpliceFallback ? { onLinkSpliceFallback: input.onLinkSpliceFallback } : {}),
      ...(input.runtimeClientID === undefined
        ? {}
        : {
            createRuntimeDoc: () => {
              const runtime = new Y.Doc({ gc: false });
              runtime.clientID = input.runtimeClientID as number;
              return runtime;
            },
          }),
    },
  );
  const doc = input.doc ?? docFromBlocks(input.blocks ?? [], input.clientID ?? 7000);
  ctx.coordinator.docs.set(input.holder.id, doc);
  ctx.journal.setCheckpoint(input.holder.id, Y.encodeStateAsUpdate(doc));
  const live = () => ctx.coordinator.require(input.holder.id);
  return {
    ...ctx,
    catalog,
    links,
    live,
    /** Spells the live holder (or any copy of it) under the catalog as it is now, prepared like a door. */
    async markdown(of: Y.Doc = live()) {
      await links.prepare({ documentId: input.holder.id, docs: [of] });
      return codecFactory
        .forScope(links.scopeFor(input.holder.id, undefined))
        .serialize(prosemirrorBlocksForDoc(of, schema))
        .trim();
    },
    /** Reads the holder as the model would. */
    read(command: Record<string, unknown> = {}) {
      return ctx.core.read(
        { file: "holder.md", documentId: input.holder.id, ...command } as never,
        { sessionId: "session-a", threadId: "thread-a" },
      );
    },
    /** Runs one model command against the holder, with the given showings as evidence. */
    write(
      command: Record<string, unknown> & { command: string },
      shown: readonly ShownLink[] = [],
    ) {
      return ctx.core.write(
        { file: "holder.md", documentId: input.holder.id, ...command } as never,
        { sessionId: "session-a", threadId: "thread-a", shownLinks: async () => shown },
      );
    },
  };
}

export type { CatalogDocument };
