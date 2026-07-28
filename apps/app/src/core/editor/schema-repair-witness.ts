/**
 * Schema repair witness — observes and reports binding-authored content removal.
 *
 * The witness owns one Y.Doc update listener across both construction and live
 * editing. Construction repairs are unambiguous; live repairs are correlated
 * with the ProseMirror transaction emitted by the y-sync binding.
 */
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { PROSEMIRROR_FRAGMENT_NAME } from "./schema";

export type SchemaRepairEvent = {
  phase: "open" | "live";
  detectedAt: string;
  deletedNodeTypes: string[];
  deletedClockCount: number;
  /** Full removed prose, session-scoped (open phase always, live best-effort). */
  removedText?: string;
  /** Present when the bind horizon or pre-GC live capture could not recover all evidence. */
  evidenceDegraded?: true;
};

export type SchemaRepairEvidence = Pick<
  SchemaRepairEvent,
  "deletedNodeTypes" | "deletedClockCount" | "removedText"
>;

type DeleteRange = { clock: number; len: number };
type DeleteSet = { clients: Map<number, DeleteRange[]> };
type ItemLike = {
  id: { client: number; clock: number };
  length: number;
  right: ItemLike | null;
  content?: unknown;
};
type YTypeLike = { _start: ItemLike | null; nodeName?: string };
type ExtractedEvidence = {
  evidence: SchemaRepairEvidence;
  resolvedClockCount: number;
  contentUnavailable: boolean;
};

function decodedDeleteSet(update: Uint8Array): DeleteSet {
  return Y.decodeUpdate(update).ds as DeleteSet;
}

function deletedClockCount(deleteSet: DeleteSet): number {
  let total = 0;
  for (const ranges of deleteSet.clients.values()) {
    for (const range of ranges) total += range.len;
  }
  return total;
}

function deletedSlices(item: ItemLike, deleteSet: DeleteSet): Array<{ from: number; to: number }> {
  const ranges = deleteSet.clients.get(item.id.client);
  if (!ranges) return [];
  const itemStart = item.id.clock;
  const itemEnd = itemStart + item.length;
  const slices: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const from = Math.max(itemStart, range.clock);
    const to = Math.min(itemEnd, range.clock + range.len);
    if (from < to) slices.push({ from: from - itemStart, to: to - itemStart });
  }
  return slices;
}

function contentType(content: unknown): YTypeLike | null {
  if (!content || typeof content !== "object" || !("type" in content)) return null;
  return (content as { type: YTypeLike }).type;
}

/**
 * Resolve delete-set clocks against the pre-repair clone's item graph.
 *
 * Traversal follows Y item identity and logical XML order. It never compares
 * sibling positions between before and after documents, which would be
 * ambiguous when repeated or nested siblings have the same shape.
 */
function extractEvidenceFromType(type: YTypeLike, deleteSet: DeleteSet): ExtractedEvidence {
  const deletedNodeTypes: string[] = [];
  let resolvedClockCount = 0;
  let contentUnavailable = false;
  type TextToken = { kind: "text"; text: string } | { kind: "boundary" };
  const walk = (current: YTypeLike): TextToken[] => {
    const tokens: TextToken[] = [];
    for (let item = current._start; item; item = item.right) {
      const slices = deletedSlices(item, deleteSet);
      const content = item.content;
      resolvedClockCount += slices.reduce((total, slice) => total + slice.to - slice.from, 0);
      if (content instanceof Y.ContentString) {
        const text = slices.map((slice) => content.str.slice(slice.from, slice.to)).join("");
        if (text) tokens.push({ kind: "text", text });
      } else if (slices.length > 0 && content instanceof Y.ContentDeleted) {
        contentUnavailable = true;
      }
      const child = contentType(content);
      if (!child) continue;
      if (slices.length > 0 && child.nodeName && !deletedNodeTypes.includes(child.nodeName)) {
        deletedNodeTypes.push(child.nodeName);
      }
      if (child.nodeName) tokens.push({ kind: "boundary" });
      tokens.push(...walk(child));
      if (child.nodeName) tokens.push({ kind: "boundary" });
    }
    return tokens;
  };

  let text = "";
  let boundary = false;
  for (const token of walk(type)) {
    if (token.kind === "boundary") {
      if (text) boundary = true;
      continue;
    }
    if (boundary) text += "\n";
    text += token.text;
    boundary = false;
  }

  return {
    evidence: {
      deletedNodeTypes,
      deletedClockCount: deletedClockCount(deleteSet),
      ...(text ? { removedText: text } : {}),
    },
    resolvedClockCount,
    contentUnavailable,
  };
}

export function extractSchemaRepairEvidence(
  preRepairSnapshot: Uint8Array,
  repairUpdate: Uint8Array,
): SchemaRepairEvidence {
  const deleteSet = decodedDeleteSet(repairUpdate);
  const snapshot = new Y.Doc({ gc: false });
  Y.applyUpdate(snapshot, preRepairSnapshot);
  const { evidence } = extractEvidenceFromType(
    snapshot.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME) as unknown as YTypeLike,
    deleteSet,
  );
  snapshot.destroy();
  return evidence;
}

type PendingLiveRepair = {
  evidence: SchemaRepairEvidence;
  evidenceDegraded: boolean;
  postRepairSnapshot: Uint8Array;
  remoteFallbackEligible: boolean;
};
type LiveRepairAttempt = {
  userAuthored: boolean;
  userDeletion: SchemaRepairEvidence | null;
  bindingSeen: boolean;
  remoteInterleaved: boolean;
  candidate: PendingLiveRepair | null;
};

function proseMirrorDeletion(transaction: Transaction): SchemaRepairEvidence | null {
  const deletedNodeTypes: string[] = [];
  const removedText: string[] = [];
  let deletedClockCount = 0;

  transaction.steps.forEach((step, index) => {
    const before = transaction.docs[index];
    if (!before) return;
    step.getMap().forEach((from, to) => {
      if (from >= to) return;
      deletedClockCount += to - from;
      const content = before.slice(from, to).content;
      const text = content.textBetween(0, content.size, "\n", "\n");
      if (text) removedText.push(text);
      content.descendants((node) => {
        if (!node.isText && !deletedNodeTypes.includes(node.type.name)) {
          deletedNodeTypes.push(node.type.name);
        }
      });
    });
  });

  if (deletedClockCount === 0) return null;
  return {
    deletedNodeTypes,
    deletedClockCount,
    ...(removedText.length > 0 ? { removedText: removedText.join("\n") } : {}),
  };
}

function withoutUserDeletion(
  evidence: SchemaRepairEvidence,
  userDeletion: SchemaRepairEvidence,
): { evidence: SchemaRepairEvidence; degraded: boolean } | null {
  const allRemovedTextIsUserAuthored =
    evidence.removedText === userDeletion.removedText ||
    (!evidence.removedText && !userDeletion.removedText);
  const allDeletedNodeTypesAreUserAuthored = evidence.deletedNodeTypes.every((nodeType) =>
    userDeletion.deletedNodeTypes.includes(nodeType),
  );
  if (allRemovedTextIsUserAuthored && allDeletedNodeTypesAreUserAuthored) return null;

  const deletedClockCount = evidence.deletedClockCount - userDeletion.deletedClockCount;
  if (deletedClockCount <= 0) return null;

  let removedText = evidence.removedText;
  let degraded = false;
  if (removedText && userDeletion.removedText) {
    const index = removedText.indexOf(userDeletion.removedText);
    if (index >= 0) {
      let before = removedText.slice(0, index);
      let after = removedText.slice(index + userDeletion.removedText.length);
      if (before.endsWith("\n")) before = before.slice(0, -1);
      else if (after.startsWith("\n")) after = after.slice(1);
      removedText = `${before}${after}`;
    } else {
      removedText = undefined;
      degraded = true;
    }
  }

  return {
    evidence: {
      deletedNodeTypes: evidence.deletedNodeTypes.filter(
        (nodeType) => !userDeletion.deletedNodeTypes.includes(nodeType),
      ),
      deletedClockCount,
      ...(removedText ? { removedText } : {}),
    },
    degraded,
  };
}

export type SchemaRepairWitness = {
  readonly phase: "open" | "live";
  readonly preBindSnapshot: Uint8Array;
  readonly latestPostRepairSnapshot: Uint8Array | null;
  enterLive(editor: Editor): void;
  destroy(): void;
};

export type CreateSchemaRepairWitnessOptions = {
  document: Y.Doc;
  onRepair: (event: SchemaRepairEvent) => void;
  evidenceDegraded?: boolean;
  now?: () => string;
};

export function createSchemaRepairWitness({
  document,
  onRepair,
  evidenceDegraded = false,
  now = () => new Date().toISOString(),
}: CreateSchemaRepairWitnessOptions): SchemaRepairWitness {
  // This snapshot and listener installation are intentionally one synchronous
  // operation. A render-time snapshot or later effect would leave remote bytes
  // outside the evidence source before Collaboration constructs.
  const preBindSnapshot = Y.encodeStateAsUpdate(document);
  let phase: "open" | "live" = "open";
  let latestPostRepairSnapshot: Uint8Array | null = null;
  let editor: Editor | null = null;
  let activeProseMirrorTransaction: {
    transaction: Transaction;
    binding: boolean;
    userDeletion: SchemaRepairEvidence | null;
  } | null = null;
  let liveRepairAttempts: LiveRepairAttempt[] = [];
  const attemptsByTransaction = new WeakMap<Y.Transaction, LiveRepairAttempt>();
  let remoteTransactionSeen = false;
  let batchToken = 0;
  let destroyed = false;

  const reportLiveRepairs = (repairs: PendingLiveRepair[]) => {
    for (const repair of repairs) {
      latestPostRepairSnapshot = repair.postRepairSnapshot;
      onRepair({
        phase: "live",
        detectedAt: now(),
        ...repair.evidence,
        ...(repair.evidenceDegraded || evidenceDegraded ? { evidenceDegraded: true as const } : {}),
      });
    }
  };

  const clearBatch = () => {
    liveRepairAttempts = [];
    // beforeAllTransactions may run inside TipTap's beforeTransaction →
    // transaction bracket, so the active PM cause survives this batch reset.
    remoteTransactionSeen = false;
  };

  const fallbackRepairs = () =>
    liveRepairAttempts.flatMap(({ candidate }) =>
      candidate?.remoteFallbackEligible ? [candidate] : [],
    );

  const finishBatch = (token: number) => {
    if (destroyed || token !== batchToken) return;
    reportLiveRepairs(fallbackRepairs());
    clearBatch();
  };

  const onBeforeAllTransactions = () => {
    if (phase !== "live") return;
    batchToken += 1;
    // A new Y batch seals the previous batch before its queued microtask runs;
    // candidates and remote eligibility may never bleed into this generation.
    reportLiveRepairs(fallbackRepairs());
    clearBatch();
  };

  const onAfterAllTransactions = () => {
    if (phase !== "live") return;
    // A PM transaction emitted after doc.transact() returns still belongs to
    // this batch when it resolves an existing candidate. Binding meta with no
    // candidate must not leak into a later writer command in the same task.
    activeProseMirrorTransaction = null;
    const token = ++batchToken;
    queueMicrotask(() => finishBatch(token));
  };

  const bindingDispatched = (transaction: Transaction) => {
    const meta = transaction.getMeta(ySyncPluginKey) as Record<string, unknown> | undefined;
    return (
      meta !== undefined &&
      (Object.hasOwn(meta, "binding") || Object.hasOwn(meta, "isChangeOrigin"))
    );
  };

  const removeAttempt = (attempt: LiveRepairAttempt) => {
    liveRepairAttempts = liveRepairAttempts.filter((pending) => pending !== attempt);
  };

  const onBeforeProseMirrorTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (phase !== "live") return;
    const binding = bindingDispatched(transaction);
    const userDeletion = binding ? null : proseMirrorDeletion(transaction);
    activeProseMirrorTransaction = { transaction, binding, userDeletion };
    if (!binding) {
      // TipTap emits beforeTransaction after ProseMirror applies the state, but
      // before view.updateState. A PM→Y transaction may therefore have started
      // just before this callback or may start while this bracket is active.
      for (let index = liveRepairAttempts.length - 1; index >= 0; index -= 1) {
        const attempt = liveRepairAttempts[index];
        if (!attempt || attempt.bindingSeen || attempt.remoteInterleaved || attempt.userAuthored) {
          continue;
        }
        attempt.userAuthored = true;
        attempt.userDeletion = userDeletion;
        break;
      }
      return;
    }

    const attempt = liveRepairAttempts.find(
      (pending) => !pending.userAuthored && !pending.bindingSeen,
    );
    if (!attempt) return;
    attempt.bindingSeen = true;
    if (attempt.candidate) {
      reportLiveRepairs([attempt.candidate]);
      removeAttempt(attempt);
    }
  };

  const onProseMirrorTransaction = ({ transaction }: { transaction: Transaction }) => {
    if (activeProseMirrorTransaction?.transaction === transaction) {
      activeProseMirrorTransaction = null;
    }
  };

  const onBeforeTransaction = (transaction: Y.Transaction) => {
    if (phase !== "live" || !transaction.local || transaction.origin !== ySyncPluginKey) {
      return;
    }
    const attempt: LiveRepairAttempt = {
      userAuthored: activeProseMirrorTransaction?.binding === false,
      userDeletion: activeProseMirrorTransaction?.userDeletion ?? null,
      bindingSeen: false,
      remoteInterleaved: remoteTransactionSeen,
      candidate: null,
    };
    liveRepairAttempts.push(attempt);
    attemptsByTransaction.set(transaction, attempt);
  };

  const onAfterTransaction = (transaction: Y.Transaction) => {
    if (phase !== "live") return;
    if (!transaction.local) {
      remoteTransactionSeen = true;
      for (const attempt of liveRepairAttempts) {
        attempt.remoteInterleaved = true;
        const { candidate } = attempt;
        if (candidate) candidate.remoteFallbackEligible = true;
      }
      return;
    }
    if (transaction.origin !== ySyncPluginKey) return;
    const attempt = attemptsByTransaction.get(transaction);
    if (!attempt) return;

    const deleteSet = transaction.deleteSet as DeleteSet;
    const count = deletedClockCount(deleteSet);
    let insertedClockCount = 0;
    for (const [client, clock] of transaction.afterState) {
      insertedClockCount += clock - (transaction.beforeState.get(client) ?? 0);
    }
    if (count === 0 || insertedClockCount !== 0) {
      removeAttempt(attempt);
      return;
    }

    // afterTransaction runs before Yjs replaces deleted structs with
    // ContentDeleted under gc:true. Capture now; correlation may resolve later
    // in this same JavaScript flush without retaining the deleted structs.
    const extracted = extractEvidenceFromType(
      document.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME) as unknown as YTypeLike,
      deleteSet,
    );
    // When a writer command runs during remote cleanup, y-prosemirror can fold
    // that command and normalization into one queued Y transaction. PM steps
    // are the only exact record of which part the writer deliberately removed.
    const repairEvidence = attempt.userDeletion
      ? withoutUserDeletion(extracted.evidence, attempt.userDeletion)
      : { evidence: extracted.evidence, degraded: false };
    if (!repairEvidence) {
      removeAttempt(attempt);
      return;
    }
    const candidate: PendingLiveRepair = {
      evidence: repairEvidence.evidence,
      evidenceDegraded:
        repairEvidence.degraded ||
        extracted.contentUnavailable ||
        extracted.resolvedClockCount < extracted.evidence.deletedClockCount,
      postRepairSnapshot: Y.encodeStateAsUpdate(document),
      remoteFallbackEligible: attempt.remoteInterleaved,
    };

    if (attempt.bindingSeen) {
      reportLiveRepairs([candidate]);
      removeAttempt(attempt);
      return;
    }
    attempt.candidate = candidate;
  };

  const onUpdate = (
    update: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: Y.Transaction,
  ) => {
    const decoded = Y.decodeUpdate(update);
    const count = deletedClockCount(decoded.ds as DeleteSet);
    const deleteOnly = decoded.structs.length === 0 && count > 0;
    // During this synchronous bracket the shipped extension assembly has no
    // other init-time local deleter; clean-open coverage pins that soundness
    // bound, so open classification does not need the live fork-meta signal.
    if (phase !== "open" || !transaction.local || !deleteOnly) return;

    // The update callback runs before control returns from construction, while
    // the repaired post-state and the pre-bind snapshot are both still exact.
    latestPostRepairSnapshot = Y.encodeStateAsUpdate(document);
    onRepair({
      phase,
      detectedAt: now(),
      ...extractSchemaRepairEvidence(preBindSnapshot, update),
      ...(evidenceDegraded ? { evidenceDegraded: true as const } : {}),
    });
  };

  document.on("update", onUpdate);
  document.on("beforeAllTransactions", onBeforeAllTransactions);
  document.on("beforeTransaction", onBeforeTransaction);
  document.on("afterTransaction", onAfterTransaction);
  document.on("afterAllTransactions", onAfterAllTransactions);

  return {
    get phase() {
      return phase;
    },
    preBindSnapshot,
    get latestPostRepairSnapshot() {
      return latestPostRepairSnapshot;
    },
    enterLive(liveEditor) {
      editor = liveEditor;
      editor.on("beforeTransaction", onBeforeProseMirrorTransaction);
      editor.on("transaction", onProseMirrorTransaction);
      phase = "live";
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      const repairs = fallbackRepairs();
      clearBatch();
      activeProseMirrorTransaction = null;
      editor?.off("beforeTransaction", onBeforeProseMirrorTransaction);
      editor?.off("transaction", onProseMirrorTransaction);
      document.off("update", onUpdate);
      document.off("beforeAllTransactions", onBeforeAllTransactions);
      document.off("beforeTransaction", onBeforeTransaction);
      document.off("afterTransaction", onAfterTransaction);
      document.off("afterAllTransactions", onAfterAllTransactions);
      reportLiveRepairs(repairs);
    },
  };
}
