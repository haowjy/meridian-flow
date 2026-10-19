// Commit-time detection: what a save's accepted writes swept, read from the save's before and after.
import * as Y from "yjs";
import { classifyDestructiveDocumentEffect } from "../apply/destructive-classification.js";
import { type BlockSnapshot, snapshotBlocks } from "../apply/echo.js";
import type { ConcurrentUpdate } from "../apply/types.js";
import type { AgentEditCodec } from "../codec-adapter.js";
import { type DocHandle, toDocHandle } from "../handles.js";
import { type LineageRange, subtractLineageRanges } from "../lineage/range-set.js";
import type { DocumentAccess, DocumentCoordinator } from "../ports/document-coordinator.js";
import type { DocumentLinksPort } from "../ports/document-links.js";
import type { AgentEditModel, ContentLineage } from "../ports/model.js";
import type { UpdateMeta } from "../ports/types.js";
import type { AgentEditJournal, JournalBatchAppendEntry } from "../ports/update-journal.js";
import { effectiveYjsUpdate } from "../yjs-update.js";
import type { CommandLinks } from "./command-links.js";
import type { InteractionContext, MutationActor } from "./types.js";

export interface JournaledUpdate {
  update: Uint8Array;
  meta: UpdateMeta;
  mutation?: JournalBatchAppendEntry["mutation"];
}

/** One of the actor's own updates and the state it was made against. */
export interface OwnWriteStep {
  preOwnSnapshot: Uint8Array;
  update: Uint8Array;
}

export interface CommitDetectionInput {
  docId: string;
  /** The command's links: comparison snapshots spell through their codec, the revision reads their scope. */
  links: CommandLinks;
  interactionContext?: InteractionContext;
  /** The view the first write planned on: what detection takes as already seen. */
  preOwnSnapshot: Uint8Array;
  access?: DocumentAccess;
  actor: MutationActor;
  /**
   * The writes being committed, each against what the actor saw. What they
   * remove was asked for, so the save never reports it as swept writer text.
   */
  ownWrites?: readonly OwnWriteStep[];
}

export interface DestructiveSweepReport {
  affectedBlockHashes: string[];
  capturedDeletedBodies?: { hash: string; body: string }[];
  sweptContent: true;
}

/** A save's report: the revision it produced and the writer text its writes swept. */
export interface AcceptedMutationReport {
  revision: string | null;
  lateSweep?: DestructiveSweepReport;
  /** Detection failed: the save landed, and nothing is claimed about what it swept. */
  awarenessDegraded?: true;
}

/** Lineage concurrent updates first made visible, by the actor kind that wrote it. */
export interface ConcurrentDetectionResult {
  lineageOrigins: readonly (ContentLineage & { origin: "human" | "agent" })[];
}

export interface CommitDetection {
  /**
   * What the save of `input`'s writes swept: `before` is the room the save's append followed,
   * `after` the room with its kept writes. The same for every host. Never throws: the save
   * already landed, so a failure degrades the report.
   */
  reportAcceptedMutation(
    before: Y.Doc,
    after: Y.Doc,
    input: CommitDetectionInput,
  ): Promise<AcceptedMutationReport>;
}

export function createCommitDetection(deps: {
  links: DocumentLinksPort;
  journal: AgentEditJournal;
  coordinator: DocumentCoordinator;
  model: AgentEditModel;
}): CommitDetection {
  const { journal, coordinator, model } = deps;

  return {
    async reportAcceptedMutation(before, after, input) {
      let revision: string | null = null;
      try {
        revision = deps.links.revision(after, input.links.scope);
        const lateSweep = await destructiveReport(input, before, after);
        return lateSweep ? { revision, lateSweep } : { revision };
      } catch {
        return { revision, awarenessDegraded: true };
      }
    },
  };

  /**
   * The writer's text the writes removed: lineage that reached `before` after the view the
   * writes planned on (attributed by the host, else the writer's), minus what the writes saw.
   */
  async function destructiveReport(
    input: CommitDetectionInput,
    before: Y.Doc,
    afterCandidate: Y.Doc,
  ): Promise<DestructiveSweepReport | undefined> {
    if (input.actor.kind !== "agent") return undefined;
    const detection = await concurrentLineage(before, input);
    const affected = await classifyDestructiveDocumentEffect(
      { journal, model, codec: input.links.codec },
      {
        documentId: input.docId,
        before: toDocHandle(before),
        afterCandidate: toDocHandle(afterCandidate),
        attributedLineage: detection.lineageOrigins,
        ...(input.ownWrites ? { ownWrites: ownWriteLineage(input.ownWrites, detection) } : {}),
      },
    );
    const affectedBlockHashes = affected.map((block) => block.hash).sort();
    if (affectedBlockHashes.length === 0) return undefined;
    const affectedSet = new Set(affectedBlockHashes);
    return {
      affectedBlockHashes,
      capturedDeletedBodies: snapshotBlocks(toDocHandle(before), model, input.links.codec)
        .filter((block) => affectedSet.has(block.hash))
        .map((block) => ({ hash: block.hash, body: block.body })),
      sweptContent: true,
    };
  }

  /** The updates `before` holds beyond the first write's view, applied to it in order. */
  async function concurrentLineage(
    before: Y.Doc,
    input: CommitDetectionInput,
  ): Promise<ConcurrentDetectionResult> {
    const detectionDoc = docFromSnapshot(input.preOwnSnapshot);
    try {
      const updates = await concurrentUpdatesSince(
        coordinator,
        input.docId,
        before,
        detectionDoc,
        input.access,
      );
      return applyConcurrentUpdates(toDocHandle(detectionDoc), model, input.links.codec, updates);
    } finally {
      detectionDoc.destroy();
    }
  }

  /**
   * Visible lineage the own writes were made against, and what each one hid. A writer edit
   * that reached a write's view after the actor's last read is in that view without the actor
   * having seen it (the region check lets an unchanged region through), so it is not counted
   * as seen.
   */
  function ownWriteLineage(
    steps: readonly OwnWriteStep[],
    detection: ConcurrentDetectionResult,
  ): {
    seen: LineageRange[];
    removed: LineageRange[];
  } {
    const seen: LineageRange[] = [];
    const removed: LineageRange[] = [];
    for (const step of steps) {
      const doc = docFromSnapshot(step.preOwnSnapshot);
      try {
        const before = visibleLineage(doc);
        Y.applyUpdate(doc, step.update, { type: "system" });
        seen.push(...before);
        removed.push(...subtractLineageRanges(before, visibleLineage(doc)));
      } finally {
        doc.destroy();
      }
    }
    const unread = detection.lineageOrigins.filter((lineage) => lineage.origin === "human");
    return { seen: subtractLineageRanges(seen, unread), removed };
  }

  function visibleLineage(doc: Y.Doc): LineageRange[] {
    return model
      .getBlocks(toDocHandle(doc))
      .flatMap((block) => [...model.getVisibleContentLineage(block)]);
  }
}

/**
 * Apply concurrent updates one at a time, recording the lineage each first made visible and
 * who wrote it. Update bytes don't carry their origin, so callers pass it beside each one.
 */
export function applyConcurrentUpdates(
  doc: DocHandle,
  model: AgentEditModel,
  codec: AgentEditCodec,
  updates: readonly ConcurrentUpdate[],
): ConcurrentDetectionResult {
  const lineageOrigins: Array<ContentLineage & { origin: "human" | "agent" }> = [];
  for (const item of updates) {
    if (item.update.length === 0) continue;
    if (item.origin.type === "system") {
      model.applyUpdate(doc, item.update, item.origin);
      continue;
    }
    const before = snapshotLineage(snapshotBlocks(doc, model, codec));
    model.applyUpdate(doc, item.update, item.origin);
    const actor = item.origin.type === "agent" ? "agent" : "human";
    for (const lineage of snapshotLineage(snapshotBlocks(doc, model, codec)))
      if (!lineageCovered(lineage, before)) lineageOrigins.push({ ...lineage, origin: actor });
  }
  return { lineageOrigins };
}

function snapshotLineage(blocks: readonly BlockSnapshot[]): ContentLineage[] {
  return blocks.flatMap((block) => block.lineage);
}

function lineageCovered(target: ContentLineage, candidates: readonly ContentLineage[]): boolean {
  const end = target.clock + target.length;
  let coveredUntil = target.clock;
  const relevant = candidates
    .filter(
      (candidate) =>
        candidate.clientID === target.clientID &&
        candidate.clock < end &&
        candidate.clock + candidate.length > target.clock,
    )
    .sort((left, right) => left.clock - right.clock);
  for (const candidate of relevant) {
    if (candidate.clock > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, candidate.clock + candidate.length);
    if (coveredUntil >= end) return true;
  }
  return false;
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, snapshot, { type: "system" });
  return doc;
}

async function concurrentUpdatesSince(
  coordinator: DocumentCoordinator,
  docId: string,
  doc: Y.Doc,
  baselineDoc: Y.Doc,
  access?: DocumentAccess,
): Promise<ConcurrentUpdate[]> {
  const sinceStateVector = Y.encodeStateVector(baselineDoc);
  if (coordinator.concurrentUpdatesSince) {
    return coordinator.concurrentUpdatesSince({
      docId,
      doc,
      baselineDoc,
      sinceStateVector,
      access,
    });
  }
  const update = Y.encodeStateAsUpdate(doc, sinceStateVector);
  return effectiveYjsUpdate(baselineDoc, update)
    ? [{ update, origin: { type: "human", userId: "unknown" } }]
    : [];
}
