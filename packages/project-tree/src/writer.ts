import type { ContextSiblingPosition } from "@meridian/contracts/protocol";
import type { LoroDoc } from "loro-crdt";
import { listOf } from "./list-doc.js";
import { shownName } from "./names.js";
import {
  type Actor,
  type BlobRef,
  type CreateRecord,
  type DeleteRecord,
  isSourceRoot,
  type MoveRecord,
  newId,
  type PurgeRecord,
  type RenameRecord,
  type RestoreRecord,
  type SettleRecord,
  sourceIdOf,
  type TreeRecord,
  type TreeRecordInput,
} from "./record.js";
import type { TreeProjection } from "./replay.js";
import { childrenOf, descendantsOf, rankAmong } from "./shape.js";
import { writable } from "./validate.js";
import { droppedRecords, LIVE, lastOfFamily, replayView, type View } from "./view.js";

export type MovePlace = number | ContextSiblingPosition;

function indexOf(kids: readonly { id: string }[], place: MovePlace): number {
  if (typeof place === "number") return Math.max(0, Math.min(place, kids.length));
  if (!("siblingId" in place)) return place.kind === "start" ? 0 : kids.length;
  const at = kids.findIndex((kid) => kid.id === place.siblingId);
  if (at < 0) return kids.length;
  return place.kind === "before" ? at : at + 1;
}

export class TreeWriter {
  constructor(
    readonly doc: LoroDoc,
    private readonly origin: string = "local",
    private readonly known?: (view: View) => TreeProjection | null,
  ) {}

  private readonly replays = new Map<
    string | null,
    { records: number; settles: number; projection: TreeProjection }
  >();

  view(view: View): TreeProjection {
    const known = this.known?.(view);
    if (known) return known;
    const records = listOf(this.doc).recordCount();
    const settles = listOf(this.doc).settleCount();
    const hit = this.replays.get(view.draft);
    if (hit && hit.records === records && hit.settles === settles) return hit.projection;
    const projection = replayView(this.doc, view);
    this.replays.set(view.draft, { records, settles, projection });
    return projection;
  }

  transact(change: () => void): void {
    listOf(this.doc).transact(change, this.origin);
  }

  prepare(
    view: View,
    actor: Actor,
    input: TreeRecordInput,
    extra: Partial<TreeRecord> = {},
  ): TreeRecord {
    return writable({
      ...input,
      id: newId(),
      actor,
      draft: view.draft,
      ...extra,
    } as TreeRecord);
  }

  append(record: TreeRecord): void {
    this.transact(() => listOf(this.doc).pushRecords([record]));
  }

  appendAll(
    records: readonly TreeRecord[],
    seen: ReadonlyArray<{ view: View; projection: TreeProjection }>,
  ): void {
    this.transact(() => listOf(this.doc).pushRecords(records));
    const dropped = droppedRecords(this.doc);
    for (const { view, projection } of seen)
      this.replays.set(view.draft, {
        records: listOf(this.doc).recordCount(),
        settles: listOf(this.doc).settleCount(),
        projection: { ...projection, dropped },
      });
  }

  author(
    view: View,
    actor: Actor,
    input: TreeRecordInput,
    extra: Partial<TreeRecord> = {},
  ): TreeRecord {
    const record = this.prepare(view, actor, input, extra);
    this.append(record);
    return record;
  }

  settle(
    actor: Actor,
    targets: readonly string[],
    to: SettleRecord["to"],
    extra: { reason?: string; command?: string } = {},
  ): void {
    if (targets.length === 0) return;
    listOf(this.doc).pushSettles([{ id: newId(), actor, targets: [...targets], to, ...extra }]);
  }

  create(view: View, actor: Actor, input: CreateInput): CreateRecord {
    return this.createAll(view, actor, [input])[0] as CreateRecord;
  }

  createAll(view: View, actor: Actor, inputs: readonly CreateInput[]): CreateRecord[] {
    const projection = this.view(view);
    const sources = new Map<string, string>();
    const siblings = new Map<string, string[]>();
    const out: CreateRecord[] = [];
    this.transact(() => {
      for (const input of inputs) {
        const source = isSourceRoot(input.parent)
          ? sourceIdOf(input.parent)
          : (sources.get(input.parent) ?? projection.nodes.get(input.parent)?.source);
        if (source === undefined) throw new Error(`create under unknown parent ${input.parent}`);
        let kids = siblings.get(input.parent);
        if (!kids) {
          kids = childrenOf(projection, input.parent).map((node) => node.rank);
          siblings.set(input.parent, kids);
        }
        const name = shownName(
          input.kind,
          input.name,
          input.kind === "document" ? input.filetype : undefined,
        );
        const at = Math.max(0, Math.min(input.index ?? kids.length, kids.length));
        const rank = rankAmong(kids, at);
        kids.splice(at, 0, rank);
        const record = this.author(view, actor, {
          type: "create",
          node: input.node ?? newId(),
          kind: input.kind,
          name,
          parent: input.parent,
          source,
          rank,
          ...(input.kind === "document" ? { filetype: input.filetype } : {}),
          ...(input.provisional ? { provisional: true as const } : {}),
          ...(input.aliases ? { aliases: input.aliases } : {}),
          ...(input.hasProperties ? { hasProperties: true as const } : {}),
          ...(input.kind === "file" && input.blob ? { blob: input.blob } : {}),
        }) as CreateRecord;
        sources.set(record.node, source);
        out.push(record);
      }
    });
    return out;
  }

  move(
    view: View,
    actor: Actor,
    node: string,
    parent: string,
    index = Number.MAX_SAFE_INTEGER,
  ): MoveRecord {
    return this.moveAll(view, actor, [node], parent, index)[0] as MoveRecord;
  }

  moveAll(
    view: View,
    actor: Actor,
    nodes: readonly string[],
    parent: string,
    place: MovePlace = { kind: "end" },
  ): MoveRecord[] {
    const projection = this.view(view);
    const siblings = new Map<string, { id: string; rank: string }[]>();
    const kidsOf = (folder: string) => {
      let kids = siblings.get(folder);
      if (!kids) {
        kids = childrenOf(projection, folder).map((child) => ({ id: child.id, rank: child.rank }));
        siblings.set(folder, kids);
      }
      return kids;
    };
    const out: MoveRecord[] = [];
    let previous: string | undefined;
    this.transact(() => {
      for (const node of nodes) {
        const current = projection.nodes.get(node);
        if (current) {
          const left = kidsOf(current.parent);
          const at = left.findIndex((kid) => kid.id === node);
          if (at >= 0) left.splice(at, 1);
        }
        const kids = kidsOf(parent);
        const at = indexOf(
          kids,
          previous === undefined ? place : { kind: "after", siblingId: previous },
        );
        const rank = rankAmong(
          kids.map((kid) => kid.rank),
          at,
        );
        kids.splice(at, 0, { id: node, rank });
        previous = node;
        out.push(
          this.author(view, actor, {
            type: "move",
            node,
            parent,
            rank,
            from: { parent: current?.parent ?? parent, rank: current?.rank ?? "" },
          }) as MoveRecord,
        );
      }
    });
    return out;
  }

  rename(view: View, actor: Actor, node: string, name: string, filetype?: string): RenameRecord {
    const projection = this.view(view);
    const current = projection.nodes.get(node);
    return this.author(view, actor, {
      type: "rename",
      node,
      name: current ? shownName(current.kind, name, filetype ?? current.filetype) : name,
      fromName: current?.name ?? "",
      ...(filetype ? { filetype } : {}),
    }) as RenameRecord;
  }

  delete(view: View, actor: Actor, node: string): DeleteRecord {
    return this.deleteAll(view, actor, [node])[0] as DeleteRecord;
  }

  deleteAll(view: View, actor: Actor, nodes: readonly string[]): DeleteRecord[] {
    const projection = this.view(view);
    const gone = new Set<string>();
    const out: DeleteRecord[] = [];
    this.transact(() => {
      for (const node of nodes) {
        if (gone.has(node)) continue;
        const cascade = descendantsOf(projection, node).filter(
          (id) => !projection.nodes.get(id)?.trashed && !gone.has(id),
        );
        gone.add(node);
        for (const id of cascade) gone.add(id);
        out.push(this.author(view, actor, { type: "delete", node, cascade }) as DeleteRecord);
      }
    });
    return out;
  }

  restore(view: View, actor: Actor, node: string): RestoreRecord {
    return this.author(view, actor, { type: "restore", node }) as RestoreRecord;
  }

  purge(actor: Actor, entry: { id: string; node: string }, nodes: readonly string[]): PurgeRecord {
    return this.author(LIVE, actor, {
      type: "purge",
      node: entry.node,
      delete: entry.id,
      nodes: [...nodes],
    }) as PurgeRecord;
  }

  restoreEntry(view: View, actor: Actor, deleteId: string): RestoreRecord | "unknown" {
    const entry = lastOfFamily(this.doc, view, deleteId);
    if (entry === "unknown" || entry?.type !== "delete") return "unknown";
    return this.author(
      view,
      actor,
      { type: "restore", node: entry.node },
      { undoes: entry.carries ?? entry.id },
    ) as RestoreRecord;
  }
}

export type CreateInput = {
  name: string;
  parent: string;
  index?: number;
  node?: string;
  provisional?: true;
  aliases?: CreateRecord["aliases"];
  hasProperties?: true;
} & (
  | { kind: "folder" }
  | { kind: "document"; filetype: string }
  | { kind: "file"; blob?: BlobRef }
);
