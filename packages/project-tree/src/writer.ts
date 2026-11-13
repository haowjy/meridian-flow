import type * as Y from "yjs";
import {
  type ApplyResult,
  applyLanding,
  discardPending,
  undoApplyIfLast,
  undoDiscard,
} from "./apply.js";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
  isSourceRoot,
  type MoveRecord,
  type NodeKind,
  type RenameRecord,
  type RestoreRecord,
  recordsOf,
  type SettleRecord,
  settleLogOf,
  sourceIdOf,
  type TreeRecord,
  type TreeRecordInput,
} from "./record.js";
import type { TreeProjection } from "./replay.js";
import { descendantsOf, rankAt } from "./shape.js";
import { undoRecord } from "./undo.js";
import { replayView, type View, viewRecords } from "./view.js";

/**
 * Makes records in one copy of the list, against what that copy's own view shows. The browser
 * writes its own records this way; the server writes Apply, Discard, Undo and an AI tool's
 * records on a copy at the journal's head, and sends the Yjs update the copy emits.
 *
 * Ids come from the Yjs client id and a counter, so use one writer per client id.
 */
export class TreeWriter {
  private counter = 0;

  constructor(
    readonly doc: Y.Doc,
    private readonly origin: string = "local",
  ) {}

  nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.doc.clientID.toString(36)}-${this.counter}`;
  }

  view(view: View): TreeProjection {
    return replayView(this.doc, view);
  }

  /** Runs `change` as one Yjs transaction, so its records and settlements travel as one update. */
  transact(change: () => void): void {
    this.doc.transact(change, this.origin);
  }

  author(
    view: View,
    actor: Actor,
    input: TreeRecordInput,
    extra: Partial<TreeRecord> = {},
  ): TreeRecord {
    const record = {
      ...input,
      id: this.nextId("op"),
      actor,
      draft: view.draft,
      ...extra,
    } as TreeRecord;
    this.transact(() => recordsOf(this.doc).push([record]));
    return record;
  }

  /** Appends one settlement. Call inside `transact` with what it settles. */
  settle(
    actor: Actor,
    targets: readonly string[],
    to: SettleRecord["to"],
    extra: { reason?: string; command?: string } = {},
  ): void {
    if (targets.length === 0) return;
    settleLogOf(this.doc).push([
      { id: this.nextId("st"), actor, targets: [...targets], to, ...extra },
    ]);
  }

  create(
    view: View,
    actor: Actor,
    input: {
      kind: NodeKind;
      name: string;
      parent: string;
      index?: number;
      blob?: BlobRef;
      node?: string;
    },
  ): CreateRecord {
    const projection = this.view(view);
    const source = isSourceRoot(input.parent)
      ? sourceIdOf(input.parent)
      : projection.nodes.get(input.parent)?.source;
    if (source === undefined) throw new Error(`create under unknown parent ${input.parent}`);
    return this.author(view, actor, {
      type: "create",
      node: input.node ?? this.nextId("n"),
      kind: input.kind,
      name: input.name,
      parent: input.parent,
      source,
      rank: rankAt(projection, input.parent, input.index ?? Number.MAX_SAFE_INTEGER),
      ...(input.blob ? { blob: input.blob } : {}),
    }) as CreateRecord;
  }

  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveRecord {
    const projection = this.view(view);
    const current = projection.nodes.get(node);
    return this.author(view, actor, {
      type: "move",
      node,
      parent,
      rank: rankAt(projection, parent, index, node),
      from: { parent: current?.parent ?? parent, rank: current?.rank ?? "" },
    }) as MoveRecord;
  }

  rename(view: View, actor: Actor, node: string, name: string): RenameRecord {
    const current = this.view(view).nodes.get(node);
    return this.author(view, actor, {
      type: "rename",
      node,
      name,
      fromName: current?.name ?? "",
    }) as RenameRecord;
  }

  delete(view: View, actor: Actor, node: string): DeleteRecord {
    const projection = this.view(view);
    const cascade = descendantsOf(projection, node).filter(
      (id) => !projection.nodes.get(id)?.trashed,
    );
    return this.author(view, actor, { type: "delete", node, cascade }) as DeleteRecord;
  }

  restore(view: View, actor: Actor, node: string): RestoreRecord {
    return this.author(view, actor, { type: "restore", node }) as RestoreRecord;
  }

  /**
   * Restores one Trash entry: the delete named, and no other delete of the same folder. A
   * folder deleted, brought back for one chapter and deleted again by someone else has two
   * entries, and restoring one must not undo the other.
   */
  restoreEntry(view: View, actor: Actor, deleteId: string): RestoreRecord | "unknown" {
    const entry = viewRecords(this.doc, view).find(
      (record) =>
        record.type === "delete" && (record.id === deleteId || record.appliedFrom === deleteId),
    );
    if (!entry) return "unknown";
    return this.author(
      view,
      actor,
      { type: "restore", node: entry.node },
      { undoes: entry.id },
    ) as RestoreRecord;
  }

  /** Apply, whole or in part: lands what can land, leaves the rest pending. */
  apply(draft: string, appliedBy: Actor, only?: readonly string[], command?: string): ApplyResult {
    return applyLanding(this, draft, appliedBy, only, command);
  }

  /** Discard, whole or in part: the chosen records and every drafted record that stands on them. */
  discard(
    draft: string,
    only?: readonly string[],
    by: Actor = "user:w",
    command?: string,
  ): string[] {
    return discardPending(this, draft, only, by, command);
  }

  /**
   * Undo of a Discard: puts back to pending every record the Discard `discarded` named. A
   * repeat finds nothing left and returns an empty list.
   */
  undoDiscard(discarded: string, by: Actor, command?: string): string[] {
    return undoDiscard(this, discarded, by, command);
  }

  /**
   * Takes an Apply back, only while nothing has been admitted since (`mark` is the list's state
   * vector right after the Apply) and no text was written in a document it created.
   */
  undoApply(
    copies: readonly TreeRecord[],
    mark: Uint8Array,
    by: Actor = "user:w",
    writtenSince: ReadonlySet<string> = new Set(),
    command?: string,
  ): "undone" | "gone" {
    return undoApplyIfLast(this, copies, mark, by, writtenSince, command);
  }

  /** Undo of one change: the opposite record, or "superseded" when something later changed the same fact. */
  undo(view: View, actor: Actor, recordId: string): TreeRecord | "superseded" | "unknown" {
    return undoRecord(this, view, actor, recordId);
  }
}
