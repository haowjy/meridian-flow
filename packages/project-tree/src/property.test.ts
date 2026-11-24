import { LoroDoc } from "loro-crdt";
import { describe, expect, it } from "vitest";
import { admit, type Connection, changedSources } from "./admission.js";
import {
  applyDraft,
  childrenOf,
  descendantsOf,
  discardDraft,
  droppedRecords,
  fingerprint,
  LIVE,
  type NodeKind,
  replay,
  replayView,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  treeViolations,
  undoApply,
  type View,
  viewRecords,
} from "./index.js";
import { undoChange } from "./undo-open.js";

function admissionProblems(
  doc: LoroDoc,
  added: readonly TreeRecord[],
  dropped: readonly string[],
  connection: Connection,
): string[] {
  const problems: string[] = [];
  const ids = new Set(added.map((record) => record.id));
  const out = new Set(dropped);
  const droppedNodes = new Set(
    droppedRecords(doc).flatMap(({ record }) => (record.type === "create" ? [record.node] : [])),
  );
  const forced = (record: TreeRecord) =>
    (record.draft !== null && !connection.drafts.has(record.draft)) ||
    droppedNodes.has(record.node) ||
    (record.type === "create" && droppedNodes.has(record.parent));
  const changesClosed = (from: number, these: readonly TreeRecord[]) => {
    const kept = new Set(
      added.slice(0, from).flatMap((record) => (out.has(record.id) ? [] : [record.id])),
    );
    const judged = new Set(these.map((record) => record.id));
    return [...new Set(these.map((record) => record.draft))].some((draft) => {
      const view = { draft };
      const records = viewRecords(doc, view).filter(
        (r) => !ids.has(r.id) || kept.has(r.id) || judged.has(r.id),
      );
      const before = replay(
        records.filter((r) => !judged.has(r.id)),
        view,
      );
      return [...changedSources(before, replay(records, view))].some(connection.closed);
    });
  };
  const reportsClosed = added.some((record) =>
    replayView(doc, { draft: record.draft })
      .changes.get(record.id)
      ?.sources.some(connection.closed),
  );
  if (!added.some(forced) && !reportsClosed && !changesClosed(0, added) && dropped.length > 0)
    problems.push("dropped records from an update that changes no closed source");
  let runStart = 0;
  for (const [index, record] of [...added.entries(), [added.length, null] as const]) {
    if (record !== null && !out.has(record.id)) {
      if (forced(record))
        problems.push(`kept ${record.id}, in a closed draft or on a dropped node`);
      continue;
    }
    if (changesClosed(runStart, added.slice(runStart, index)))
      problems.push(`kept records ${runStart}..${index - 1}, which change a closed source`);
    if (record === null) break;
    if (!forced(record) && !changesClosed(index, [record]))
      problems.push(`dropped ${record.id}, which changes no closed source where it arrived`);
    if (record.type === "create") droppedNodes.add(record.node);
    runStart = index + 1;
  }
  return problems;
}

const ROOT = sourceRoot("manuscript");

const standing = (projection: TreeProjection) =>
  fingerprint(projection, false)
    .replaceAll(/( \(\d+\))*(~[0-9a-f]{4,})?(?=#)/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("~") && !line.startsWith("source:"))
    .join("\n");

const cmd = () => crypto.randomUUID();

const SEEDS = Number(process.env.TREE_SEEDS ?? 40);
const FIRST_SEED = Number(process.env.TREE_FIRST_SEED ?? 1 + Math.floor(Math.random() * 1_000_000));
const STEPS = Number(process.env.TREE_STEPS ?? 160);
const REPLICAS = 4;
const VIEWS: View[] = [LIVE, { draft: "w1" }, { draft: "w2" }];
const NAMES = ["Ch1", "Ch2", "Notes", "Arc", "Map"];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function listCopy(peer: number, records: readonly TreeRecord[]): LoroDoc {
  const doc = new LoroDoc();
  doc.setPeerId(peer);
  const ops = doc.getList("ops");
  for (const record of records) ops.push(JSON.parse(JSON.stringify(record)));
  doc.commit();
  return doc;
}

function sentAfter(server: LoroDoc, index: number, records: readonly TreeRecord[]) {
  const copy = new LoroDoc();
  copy.setPeerId(2000);
  copy.import(server.export({ mode: "update" }));
  const vector = copy.oplogVersion();
  const ops = copy.getList("ops");
  records.forEach((record, at) => {
    ops.insert(index + at, JSON.parse(JSON.stringify(record)));
  });
  copy.commit();
  return { copy, update: copy.export({ mode: "update", from: vector }) };
}

type Replica = {
  writer: TreeWriter;
  outbox: Uint8Array[];
  delivered: Map<number, Set<number>>;
};

function makeReplicas(): Replica[] {
  return Array.from({ length: REPLICAS }, (_, index) => {
    const doc = new LoroDoc();
    doc.setPeerId(index + 1);
    const replica: Replica = { writer: new TreeWriter(doc), outbox: [], delivered: new Map() };
    doc.subscribeLocalUpdates((update) => {
      replica.outbox.push(update);
    });
    return replica;
  });
}

function viewProblems(doc: LoroDoc, view: View): string[] {
  const projection = replayView(doc, view);
  const ops = viewRecords(doc, view);
  const byRoot = new Map(ops.map((op) => [op.carries ?? op.id, op]));
  const withdraws = (op: TreeRecord): boolean => {
    if (op.type !== "delete" || op.draft !== null || op.undoes === undefined) return false;
    if (op.fromDraft !== undefined && op.carries === undefined) return true;
    const restore = byRoot.get(op.undoes);
    const back = restore?.type === "restore" && restore.undoes && byRoot.get(restore.undoes);
    return back ? withdraws(back) : false;
  };
  const withdrawn = (node: string) =>
    ops.some((op) => op.node === node && projection.inForce.has(op.id) && withdraws(op));
  const created = ops.flatMap((op) =>
    op.type === "create" && !withdrawn(op.node) ? [op.node] : [],
  );
  const problems = treeViolations(projection, created);
  const named = new Set(
    ops.flatMap((op) => (op.type === "delete" ? [op.node, ...op.cascade] : [])),
  );
  const deletedTops = new Set(ops.flatMap((op) => (op.type === "delete" ? [op.node] : [])));
  for (const node of projection.nodes.values()) {
    if (!node.trashed) continue;
    if (!named.has(node.id)) problems.push(`trashed ${node.id} that no delete named`);
    let at: string | null = node.id;
    let steps = 0;
    while (at !== null && !deletedTops.has(at) && steps++ <= projection.nodes.size)
      at = projection.nodes.get(at)?.parent ?? null;
    if (at === null || !deletedTops.has(at))
      problems.push(`trashed ${node.id} outside any deleted node`);
  }
  return problems;
}

function runSeed(seed: number): {
  ops: number;
  skipped: number;
  kept: number;
  undone: number;
  undoneAny: number;
  leftPending: number;
} {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const replicas = makeReplicas();
  let undone = 0;
  let undoneAny = 0;
  let leftPending = 0;

  const deliver = (from: Replica, to: Replica) => {
    const fromIndex = replicas.indexOf(from);
    const seen = to.delivered.get(fromIndex) ?? new Set<number>();
    to.delivered.set(fromIndex, seen);
    const waiting = from.outbox.map((_, index) => index).filter((index) => !seen.has(index));
    if (waiting.length === 0) return;
    const index = pick(waiting);
    seen.add(index);
    to.writer.doc.import(from.outbox[index] as Uint8Array);
  };

  for (let step = 0; step < STEPS; step += 1) {
    const replica = pick(replicas);
    const writer = replica.writer;
    const roll = random();
    if (roll < 0.3) {
      const from = pick(replicas);
      if (from !== replica)
        for (let n = 0; n < 1 + Math.floor(random() * 4); n += 1) deliver(from, replica);
      continue;
    }
    const view = pick(VIEWS);
    const actor = pick(["user:w", "agent:t/1"]);
    const projection = replayView(writer.doc, view);
    const shown = [...projection.nodes.values()].filter(
      (node) => !node.trashed && node.id !== ROOT,
    );
    const folders = [
      ROOT,
      sourceRoot("notes-a"),
      sourceRoot("notes-b"),
      ...shown.filter((node) => node.kind === "folder").map((node) => node.id),
    ];
    const action = random();
    if (action < 0.3 || shown.length === 0) {
      const kind: NodeKind = random() < 0.4 ? "folder" : random() < 0.85 ? "document" : "file";
      const parent = pick(folders);
      const placed = { name: pick(NAMES), parent, index: Math.floor(random() * 5) };
      if (kind === "file")
        writer.create(view, actor, {
          ...placed,
          kind,
          blob: { storageKey: `k${step}`, mime: "image/png", size: 1 },
        });
      else if (kind === "document")
        writer.create(view, actor, { ...placed, kind, filetype: "markdown" });
      else writer.create(view, actor, { ...placed, kind });
    } else if (action < 0.55) {
      const node = pick(shown);
      const inside = new Set([node.id, ...descendantsOf(projection, node.id)]);
      const targets = folders.filter((folder) => !inside.has(folder));
      if (targets.length > 0) {
        const before = fingerprint(projection);
        const move = writer.move(view, actor, node.id, pick(targets), Math.floor(random() * 5));
        if (random() < 0.15) {
          const undo = undoChange(writer, view, actor, move.id);
          if (typeof undo === "object")
            expect(fingerprint(replayView(writer.doc, view)), `seed ${seed} undo move`).toBe(
              before,
            );
        }
      }
    } else if (action < 0.64) {
      writer.rename(view, actor, pick(shown).id, pick(NAMES));
    } else if (action < 0.68) {
      const earlier = viewRecords(writer.doc, view);
      if (earlier.length > 0) {
        const result = undoChange(writer, view, actor, pick(earlier).id);
        if (typeof result === "object") undoneAny += 1;
      }
    } else if (action < 0.8) {
      const target = pick(shown).id;
      writer.delete(view, actor, target);
      const after = replayView(writer.doc, view);
      for (const id of [target, ...descendantsOf(after, target)])
        expect(after.nodes.get(id)?.trashed, `seed ${seed} step ${step} delete took ${id}`).toBe(
          true,
        );
    } else if (action < 0.85) {
      const trashed = [...projection.nodes.values()].filter((node) => node.trashed);
      if (trashed.length > 0) {
        const target = pick(trashed).id;
        writer.restore(view, actor, target);
        expect(
          replayView(writer.doc, view).nodes.get(target)?.trashed,
          `seed ${seed} restore`,
        ).toBe(false);
      }
    } else if (view.draft !== null) {
      const pending = viewRecords(writer.doc, view).filter((op) => op.draft === view.draft);
      if (pending.length === 0) continue;
      const some = random() < 0.5 ? [pick(pending).id] : undefined;
      if (action < 0.93) {
        const shownBefore = standing(replayView(writer.doc, view));
        const shownTree = replayView(writer.doc, view);
        const liveBefore = standing(replayView(writer.doc, LIVE));
        const viewBefore = viewRecords(writer.doc, view);
        const skippedBefore = replayView(writer.doc, view).skipped.map(({ record }) => record);
        const liveInForce = replayView(writer.doc, LIVE).inForce;
        const inLive = new Set(
          viewRecords(writer.doc, LIVE).flatMap((op) =>
            op.carries !== undefined && liveInForce.has(op.id) ? [op.carries] : [],
          ),
        );
        const landed = applyDraft(writer, view.draft, "user:w", cmd(), some);
        const shapeBefore = fingerprint(shownTree, false);
        const landing = landed.left.length > 0;
        if (landed.left.length > 0) leftPending += 1;
        if (random() < 0.3) {
          const result = undoApply(writer, landed.command, "user:w", cmd());
          undone += 1;
          const doubled = landed.copies.some((op) => inLive.has(op.carries as string));
          if (result.left.length === 0 && !doubled) {
            expect(standing(replayView(writer.doc, LIVE)), `seed ${seed} undo apply live`).toBe(
              liveBefore,
            );
            if (landed.superseded.length === 0 && landed.left.length === 0)
              expect(standing(replayView(writer.doc, view)), `seed ${seed} undo apply draft`).toBe(
                shownBefore,
              );
          }
          for (const each of VIEWS)
            expect(viewProblems(writer.doc, each), `seed ${seed} step ${step}`).toEqual([]);
          continue;
        }
        const cannotLand = landed.left.length > 0 || skippedBefore.length > 0;
        if (!cannotLand && landed.superseded.length === 0)
          expect(
            fingerprint(replayView(writer.doc, view), false),
            `seed ${seed} partial apply`,
          ).toBe(shapeBefore);
        else {
          if (!cannotLand)
            expect(
              fingerprint(replayView(writer.doc, view), false),
              `seed ${seed} apply with superseded`,
            ).toBe(shapeBefore);
          const cannot = new Set([
            ...[...landed.left.map(({ record }) => record), ...landed.superseded].map(
              (op) => op.id,
            ),
            ...skippedBefore,
          ]);
          const without = (ops: readonly TreeRecord[]) =>
            fingerprint(
              replay(
                ops.filter((op) => !cannot.has(op.id)),
                { draft: view.draft },
              ),
              false,
            );
          if (fingerprint(replayView(writer.doc, view), false) !== shapeBefore)
            expect(without(viewRecords(writer.doc, view)), `seed ${seed} landing apply`).toBe(
              without(viewBefore),
            );
        }
        const shown = (shape: string) =>
          shape
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("~"))
            .filter((line, at, lines) => line.startsWith(" ") || lines[at + 1]?.startsWith(" "))
            .join("\n");
        if (!some && !landing)
          expect(
            shown(fingerprint(replayView(writer.doc, LIVE), false)),
            `seed ${seed} WYSIWYG apply`,
          ).toBe(shown(shapeBefore));
      } else {
        discardDraft(writer, view.draft, "user:w", cmd(), some);
        if (!some)
          expect(fingerprint(replayView(writer.doc, view))).toBe(
            fingerprint(replayView(writer.doc, LIVE)),
          );
      }
    }
    for (const each of VIEWS)
      expect(viewProblems(writer.doc, each), `seed ${seed} step ${step}`).toEqual([]);
  }

  for (let round = 0; round < 2; round += 1)
    for (const to of replicas)
      for (const from of [...replicas].sort(() => random() - 0.5))
        if (from !== to) for (let n = 0; n < from.outbox.length; n += 1) deliver(from, to);
  const clocks = (doc: LoroDoc) =>
    [...doc.oplogVersion().toJSON()].sort(([a], [b]) => (a < b ? -1 : 1));
  for (const replica of replicas)
    expect(clocks(replica.writer.doc), `seed ${seed} every update delivered`).toEqual(
      clocks(replicas[0]?.writer.doc as LoroDoc),
    );

  for (const view of VIEWS) {
    const prints = replicas.map((replica) => fingerprint(replayView(replica.writer.doc, view)));
    expect(new Set(prints).size, `seed ${seed} view ${view.draft ?? "live"} converges`).toBe(1);
    for (const replica of replicas)
      expect(viewProblems(replica.writer.doc, view), `seed ${seed}`).toEqual([]);
  }
  const doc = replicas[0]?.writer.doc as LoroDoc;
  for (const view of VIEWS) {
    const records = viewRecords(doc, view);
    if (records.length === 0) continue;
    const inserted = pick(records);
    const withRecord = replay(records, { draft: view.draft });
    const without = replay(
      records.filter((record) => record.id !== inserted.id),
      { draft: view.draft },
    );
    const sources = changedSources(without, withRecord);
    const shown = (p: TreeProjection, id: string) => {
      const n = p.nodes.get(id);
      return (
        n && [
          n.name,
          n.suffix,
          n.parent,
          n.source,
          n.rank,
          n.trashed,
          n.keptByChild,
          n.purged,
          n.filetype,
        ]
      );
    };
    for (const id of new Set([...withRecord.nodes.keys(), ...without.nodes.keys()])) {
      if (JSON.stringify(shown(withRecord, id)) === JSON.stringify(shown(without, id))) continue;
      for (const node of [withRecord.nodes.get(id), without.nodes.get(id)])
        if (node)
          expect(
            sources.has(node.source),
            `seed ${seed} record ${JSON.stringify(inserted)} change ${JSON.stringify([...sources])} node ${id} before ${JSON.stringify(shown(without, id))} after ${JSON.stringify(shown(withRecord, id))} records ${JSON.stringify(records.filter((r) => r.node === id || r.node === inserted.node))}`,
          ).toBe(true);
    }
    if (inserted.draft === view.draft) {
      const closed = [...sources][0] ?? "not-a-source";
      const server = listCopy(
        7,
        records.filter((r) => r.id !== inserted.id),
      );
      const { copy, update } = sentAfter(server, records.indexOf(inserted), [inserted]);
      const result = admit(new TreeWriter(server), update, {
        drafts: new Set(["w1", "w2"]),
        closed: (source) => source === closed,
      });
      expect(result.dropped.includes(inserted.id), `seed ${seed} closed ${closed}`).toBe(
        sources.has(closed),
      );
      copy.free();
      server.free();
    }
  }
  const all = viewRecords(doc, LIVE);
  if (all.length > 0) {
    const start = Math.floor(random() * all.length);
    const added: TreeRecord[] = [];
    added.push(...all.slice(start, start + 8));
    if (added.length > 0) {
      const server = listCopy(7, [...all.slice(0, start), ...all.slice(start + added.length)]);
      const { copy, update } = sentAfter(server, start, added);
      const closed = pick(["manuscript", "not-a-source"]);
      const connection = {
        drafts: new Set(["w1", "w2"]),
        closed: (source: string) => source === closed,
      };
      const result = admit(new TreeWriter(server), update, connection);
      expect(
        admissionProblems(copy, added, result.dropped, connection),
        `seed ${seed} closed ${closed} added ${JSON.stringify(added)} all ${JSON.stringify(all)} `,
      ).toEqual([]);
      copy.free();
      server.free();
    }
  }
  const views = VIEWS.map((view) => replayView(doc, view));
  return {
    ops: viewRecords(doc, LIVE).length,
    skipped: views.flatMap((view) => view.skipped).filter((s) => s.reason === "cycle").length,
    kept: views.flatMap((view) => [...view.nodes.values()]).filter((node) => node.keptByChild)
      .length,
    undone,
    undoneAny,
    leftPending,
  };
}

describe("file tree log under random concurrent edits", () => {
  it(`converges to one valid tree per view across ${SEEDS} seeds`, () => {
    let ops = 0;
    let skipped = 0;
    let kept = 0;
    let undone = 0;
    let undoneAny = 0;
    let leftPending = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed += 1) {
      let result: ReturnType<typeof runSeed>;
      try {
        result = runSeed(seed);
      } catch (error) {
        throw new Error(
          `tree property failed at seed ${seed}; rerun with TREE_FIRST_SEED=${seed} TREE_SEEDS=1`,
          { cause: error },
        );
      }
      ops += result.ops;
      skipped += result.skipped;
      kept += result.kept;
      undone += result.undone;
      undoneAny += result.undoneAny;
      leftPending += result.leftPending;
    }
    if (SEEDS >= 300) {
      expect(skipped).toBeGreaterThan(0);
      expect(kept).toBeGreaterThan(0);
      expect(undone).toBeGreaterThan(0);
      expect(undoneAny).toBeGreaterThan(0);
    }
    console.info(
      `tree property: ${SEEDS} seeds, ${ops} live ops, ${skipped} cycle skips, ${kept} folders kept by a child, ${undone} Applies undone at once, ${undoneAny} changes undone from a random earlier record, ${leftPending} Applies that left records that could not land`,
    );
  }, 600_000);

  it("replays a large project quickly enough to recompute on every change", () => {
    const doc = new LoroDoc();
    const writer = new TreeWriter(doc);
    const random = rng(7);
    const folders = [ROOT];
    const nodes: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const parent = folders[Math.floor(random() * folders.length)] as string;
      const op = writer.author(LIVE, "user:w", {
        type: "create",
        node: `n${i}`,
        kind: i % 10 === 0 ? "folder" : "document",
        ...(i % 10 === 0 ? {} : { filetype: "markdown" }),
        name: `N${i}`,
        parent,
        source: "manuscript",
        rank: `a${i.toString(36).padStart(4, "0")}1`,
      });
      if (i % 10 === 0) folders.push(op.node);
      nodes.push(`n${i}`);
    }
    for (let i = 0; i < 20_000; i += 1) {
      const node = nodes[Math.floor(random() * nodes.length)] as string;
      writer.author(LIVE, "user:w", {
        type: "move",
        node,
        parent: folders[Math.floor(random() * folders.length)] as string,
        rank: `b${i.toString(36).padStart(4, "0")}1`,
        from: { parent: ROOT, rank: "" },
      });
    }
    const started = performance.now();
    const projection = replayView(doc, LIVE);
    const elapsed = performance.now() - started;
    expect(treeViolations(projection)).toEqual([]);
    expect(childrenOf(projection, ROOT).length).toBeGreaterThan(0);
    const bytes = doc.export({ mode: "snapshot" }).byteLength;
    console.info(
      `2,000 nodes, 22,000 ops: replay ${elapsed.toFixed(0)} ms, doc ${(bytes / 1024).toFixed(0)} KiB`,
    );
  });
});
