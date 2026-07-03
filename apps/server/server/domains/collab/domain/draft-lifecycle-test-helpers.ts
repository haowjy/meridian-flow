/** Shared scenario harness for draft lifecycle integration tests. */

import {
  createAgentEditCodec,
  fragmentOf,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { vi } from "vitest";
import * as Y from "yjs";
import {
  createInMemoryCoordinator,
  createInMemoryDocumentLifecycle,
  createInMemoryJournal,
} from "../adapters/in-memory/agent-edit.js";
import {
  createInMemoryDraftAcceptJournal,
  createInMemoryDraftStore,
} from "../adapters/in-memory/drafts.js";
import { createHocuspocusPersistenceService } from "../hocuspocus-persistence.js";
import { createDraftReviewQueries } from "./draft-review-queries.js";
import { createDraftService, type DraftStore } from "./drafts.js";

export const DOC_ID = "doc-1" as never;
export const THREAD_ID = "thread-1" as never;
export const WORK_ID = "work-1" as never;
export const USER_ID = "user-1" as never;
export const TURN_A = "turn-a" as never;
export const TURN_B = "turn-b" as never;

export const ACCEPT_MUTATION_WRITE_ID = /^draft-accept:.+:\d+$/;

export async function createScenario(
  options: {
    closeDraftRoom?: (draftId: string) => void;
    drainDraftRoomPersistence?: (draftId: string) => Promise<void>;
    reverseAcceptedDraft?: Parameters<typeof createDraftService>[0]["reverseAcceptedDraft"];
  } = {},
) {
  const journal = createInMemoryJournal();
  const coordinator = createInMemoryCoordinator(journal);
  const lifecycle = createInMemoryDocumentLifecycle(coordinator);
  await lifecycle.ensureDocument(DOC_ID);
  const store = createInMemoryDraftStore([[THREAD_ID, WORK_ID]]);
  const completeAccept = vi.spyOn(store, "completeAccept");
  const reject = vi.spyOn(store, "reject");
  const schema = buildDocumentSchema();
  const model = yProsemirrorModel(schema);
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const service = createDraftService({
    draftStore: store,
    liveJournal: createInMemoryDraftAcceptJournal(journal),
    liveUpdateJournal: journal,
    latestLiveUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId),
    liveCoordinator: coordinator,
    model,
    codec,
    closeDraftRoom: options.closeDraftRoom,
    drainDraftRoomPersistence: options.drainDraftRoomPersistence,
    reverseAcceptedDraft: options.reverseAcceptedDraft,
  });
  const preview = createDraftReviewQueries({
    journal,
    draftStore: store,
    liveSeqStore: { latestUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId) },
    codec,
    model,
  });
  const hocuspocus = createHocuspocusPersistenceService({
    journal,
    draftStore: store,
    hocuspocus: () => null,
    metaForOrigin: () => ({ origin: "system", seq: 0 }),
    latestUpdateSeq: (documentId) => journal.latestUpdateSeq(documentId),
    emitAgentEditInvariantViolation: () => {},
  });
  return {
    journal,
    coordinator,
    store: store as DraftStore,
    service,
    preview,
    hocuspocus,
    codec,
    model,
    completeAccept,
    reject,
  };
}

export type DraftScenario = Awaited<ReturnType<typeof createScenario>>;

export function acceptMutationWriteIds(
  journal: DraftScenario["journal"],
  documentId = DOC_ID,
): string[] {
  return journal
    .mutationRecords(documentId)
    .map((mutation) => mutation.writeId)
    .filter((writeId) => ACCEPT_MUTATION_WRITE_ID.test(writeId));
}

export function markdownFromDoc(
  scenario: Pick<DraftScenario, "codec" | "model">,
  doc: Y.Doc,
): string {
  if (scenario.model.getBlocks(toDocHandle(doc)).length === 0) return "";
  return scenario.codec.serialize(scenario.model.projectBlocks(toDocHandle(doc)));
}

export function updateFromText(value: string): Uint8Array {
  const doc = new Y.Doc({ gc: false });
  return appendText(doc, value);
}

export function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

export async function updateFromMarkdownOverLive(
  scenario: DraftScenario,
  markdown: string,
): Promise<Uint8Array> {
  const doc = createCollabYDoc({ gc: false });
  await scenario.coordinator.withDocument(DOC_ID, async (liveDoc) => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(liveDoc));
  });
  const before = Y.encodeStateVector(doc);
  replaceMarkdownInDoc(doc, scenario, markdown);
  const update = Y.encodeStateAsUpdate(doc, before);
  doc.destroy();
  return update;
}

export async function replaceLiveMarkdown(
  scenario: DraftScenario,
  markdown: string,
): Promise<void> {
  await scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    const before = Y.encodeStateVector(doc);
    replaceMarkdownInDoc(doc, scenario, markdown);
    const update = Y.encodeStateAsUpdate(doc, before);
    await scenario.journal.append(DOC_ID, update, { origin: "system", seq: 0 });
  });
}

export function replaceMarkdownInDoc(
  doc: Y.Doc,
  scenario: Pick<DraftScenario, "codec" | "model">,
  markdown: string,
): void {
  const parsed = scenario.codec.parse(markdown);
  doc.transact(
    () => {
      const fragment = fragmentOf(doc);
      if (fragment.length > 0) fragment.delete(0, fragment.length);
      scenario.model.insertBlocks(toDocHandle(doc), null, parsed);
    },
    { type: "system" },
  );
}

export async function draftRuntimeFromLive(scenario: DraftScenario): Promise<Y.Doc> {
  const doc = createCollabYDoc({ gc: false });
  await scenario.coordinator.withDocument(DOC_ID, async (liveDoc) => {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(liveDoc));
  });
  return doc;
}

export function appendMarkdownBlockInDoc(
  doc: Y.Doc,
  scenario: Pick<DraftScenario, "codec" | "model">,
  markdown: string,
): Uint8Array {
  const before = Y.encodeStateVector(doc);
  const blocks = scenario.model.getBlocks(toDocHandle(doc));
  scenario.model.insertBlocks(
    toDocHandle(doc),
    blocks.at(-1) ?? null,
    scenario.codec.parse(markdown),
  );
  return Y.encodeStateAsUpdate(doc, before);
}

export function operationContaining(
  preview: {
    operations?: { afterExcerpt?: string; beforeExcerpt?: string; operationId: string }[];
  },
  text: string,
): { operationId: string } {
  const operation = operationMaybeContaining(preview, text);
  if (!operation) throw new Error(`Expected review operation containing ${text}`);
  return operation;
}

export function operationMaybeContaining(
  preview: {
    operations?: { afterExcerpt?: string; beforeExcerpt?: string; operationId: string }[];
  },
  text: string,
): { operationId: string } | null {
  return (
    preview.operations?.find(
      (operation) =>
        operation.afterExcerpt?.includes(text) || operation.beforeExcerpt?.includes(text),
    ) ?? null
  );
}

export async function liveMarkdown(scenario: DraftScenario): Promise<string> {
  return scenario.coordinator.withDocument(DOC_ID, async (doc) => {
    if (scenario.model.getBlocks(toDocHandle(doc)).length === 0) return "";
    return scenario.codec.serialize(scenario.model.projectBlocks(toDocHandle(doc)));
  });
}

export function normalizeMarkdown(markdown: string): string {
  return markdown.trimEnd();
}

export function reviewChangeCount(review: { operations?: unknown[]; hunks?: unknown[] }): number {
  return (review.operations?.length ?? 0) + (review.hunks?.length ?? 0);
}

export async function liveText(coordinator: {
  withDocument<T>(docId: string, fn: (doc: Y.Doc) => Promise<T>): Promise<T>;
}) {
  return coordinator.withDocument(DOC_ID, async (doc) => doc.getText("body").toString());
}
