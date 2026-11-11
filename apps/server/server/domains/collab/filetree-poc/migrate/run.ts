/**
 * Probe: build a project through the product's tree/collab commands, migrate it to
 * operation records, and answer the seven questions. Run with:
 *   pnpm probe:db apps/server/server/domains/collab/filetree-poc/migrate/run.ts
 */
import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { serializeRemovalIdentity } from "@meridian/contracts";
import { createDb } from "@meridian/database";
import {
  branchTreeChanges,
  branchTreeFolders,
  documentEdits,
  documentPreviousLocations,
  documents,
  folders,
} from "@meridian/database/schema";
import { modelResponses } from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { processDetachedWork } from "../../../../domains/runtime/detached-work.js";
import { createNoopEventSink } from "../../../../domains/observability/index.js";
import { composeAppServices, createProductionAppPorts } from "../../../../lib/compose.js";
import {
  handleApplyClickRequest,
  selectBranchRouteServices,
} from "../../../../lib/branch-review-route.js";
import {
  bindEditAgent,
  unloadHocuspocus,
} from "../../../../test-support/composed-runtime.js";
import { branchTreeScenario } from "../../../../test-support/branch-tree-scenario.js";
import { checkProject, snapshotOverlay, snapshotReplay, viewOpsFor } from "./check.js";
import { migrateProject } from "./migrate.js";
import {
  fingerprint,
  LIVE,
  materialize,
  opsOf,
  replay,
  TreeWriter,
  treeViolations,
} from "./tree-log.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

type Produced = Record<string, { ok: boolean; detail: string }>;

function mark(produced: Produced, name: string, ok: boolean, detail: string) {
  produced[name] = { ok, detail };
  const tag = ok ? "ok" : "FAIL";
  console.log(`  [${tag}] ${name}: ${detail}`);
}

async function compose(db: ReturnType<typeof createDb>) {
  const ports = await createProductionAppPorts({
    db,
    backgroundTasks: processDetachedWork,
    eventSink: createNoopEventSink(),
    environment: { FLOW_OPENAI_API_KEY: "sk-test-tree-oplog-migrate" },
  });
  const hocuspocus = new Hocuspocus({
    yDocOptions: { gc: false, gcFilter: () => true },
    async onLoadDocument({ documentName, document }) {
      const state = await ports.documentSync.loadHocuspocusDocument(documentName, document);
      if (state) Y.applyUpdate(document, state);
    },
    onStoreDocument: ({ documentName, document }) =>
      ports.documentSync.storeHocuspocusDocument(documentName, document),
  });
  ports.documentSync.bindHocuspocus(hocuspocus);
  const app = composeAppServices(ports);
  return { ports, hocuspocus, app };
}

async function main() {
  const db = createDb(DATABASE_URL, { max: 8 });
  let runtime: Awaited<ReturnType<typeof compose>> | undefined;
  const produced: Produced = {};
  const report: Record<string, unknown> = { produced };
  try {
    runtime = await compose(db);
    const sequences = new Map<string, number>();
    const runtimes = {
      compose: async () => runtime as NonNullable<typeof runtime>,
      script: (rt: NonNullable<typeof runtime>, thread: { threadId: string; turnId: string }) => ({
        begin: async () => {
          await bindEditAgent(rt, thread.threadId);
          const sequence = (sequences.get(thread.turnId) ?? 0) + 1;
          sequences.set(thread.turnId, sequence);
          const responseId = randomUUID();
          await db.insert(modelResponses).values({
            id: responseId,
            turnId: thread.turnId,
            sequence,
            provider: "runtime-test",
            model: "runtime-test",
            requestMessageCount: 1,
            predictedCacheState: "cold",
            predictedCacheReason: "facts_unavailable",
          });
          const call = (name: string, args: Record<string, unknown>) =>
            rt.app.toolExecutor.executeTool(
              { id: randomUUID(), name, arguments: args },
              {
                ...thread,
                responseIdentity: { providerResponseId: responseId, editScopeId: responseId },
                agentSlug: null,
                request: async () => ({
                  kind: "refused" as const,
                  refusal: { code: "request_refused", message: "No one answers requests here." },
                }),
              },
            );
          return { responseId, call };
        },
      }),
    };
    const s = await branchTreeScenario(db, { runtime, runtimes: runtimes as never });
    console.log(`project ${s.project.id}`);

    const rewrite = await s.work("Rewrite", "draft");
    const polish = await s.work("Polish", "draft");
    const liveChat = await s.work("Live", "direct");

    const mkdir = async (path: string) => {
      await s.writer.mkdir(path);
    };
    const create = async (path: string, content: string) => s.writer.createDocument(path, content);

    await mkdir("arc-1");
    const ch1 = await create("arc-1/ch1", "Chapter one.");
    const ch2 = await create("arc-1/ch2", "Chapter two.");
    const ch3 = await create("arc-1/ch3", "Chapter three.");
    mark(produced, "nested manuscript folders+docs", true, `arc-1/{ch1,ch2,ch3}`);

    const prologue = await create("prologue", "Once.");
    await mkdir("kb://lore");
    await mkdir("kb://lore/places");
    const kael = await create("kb://lore/kael", "Kael of the river.");
    const harbor = await create("kb://lore/places/harbor", "The harbor.");
    mark(produced, "knowledge source nested", true, `kael=${kael} harbor=${harbor}`);

    const scratch = await s.writer.create("notes", {
      content: "Scratch notes.",
      inScratchOf: rewrite,
    });
    mark(
      produced,
      "work scratch document",
      scratch.status === "created",
      JSON.stringify(scratch),
    );

    try {
      const bytes = new Uint8Array([137, 80, 78, 71, 13, 10]);
      const put = await runtime.ports.objectStore.put(
        `uploads/${s.project.id}/map.png`,
        bytes,
        "image/png",
      );
      if (!put.ok) throw new Error(put.error.message);
      const uploaded = await runtime.ports.contextPorts
        .forProject(s.project.id, s.project.userId, new Map())
        .writeBinary("manuscript://map.png", {
          fileType: "image",
          storageUrl: put.value.storageUrl,
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        });
      mark(
        produced,
        "binary upload",
        uploaded.ok,
        uploaded.ok ? "manuscript://map.png" : JSON.stringify(uploaded),
      );
    } catch (error) {
      mark(produced, "binary upload", false, String(error));
    }

    const renamed = await s.writer.move("prologue", "opening");
    mark(produced, "live rename", renamed.ok, renamed.ok ? "prologue→opening" : JSON.stringify(renamed));

    await mkdir("staging");
    const moved = await s.writer.move("arc-1/ch3", "staging/ch3");
    mark(produced, "live move", moved.ok, moved.ok ? "ch3→staging/ch3" : JSON.stringify(moved));

    const reorder = await s.model(liveChat).now("write", {
      command: "move",
      from: { path: "manuscript://arc-1/ch2" },
      path: "manuscript://arc-1/ch2",
      position: { kind: "start" },
    });
    mark(
      produced,
      "live reorder",
      !(reorder.isError ?? false),
      JSON.stringify(reorder.output).slice(0, 200),
    );

    const trashMe = await create("trash-me", "Gone soon.");
    const deleted = await s.writer.delete("trash-me");
    mark(produced, "live delete", deleted.ok, deleted.ok ? `deleted ${trashMe}` : JSON.stringify(deleted));
    const [removalRow] = await db
      .select({
        deletedAt: documents.deletedAt,
        locationVersion: documents.locationVersion,
      })
      .from(documents)
      .where(eq(documents.id, trashMe));
    if (removalRow?.deletedAt) {
      const restored = await runtime.ports.restoreRemovedDocuments({
        userId: s.project.userId,
        projectId: s.project.id,
        documents: [
          {
            documentId: trashMe,
            removal: serializeRemovalIdentity({
              time: removalRow.deletedAt,
              locationVersion: removalRow.locationVersion,
            }),
          },
        ],
      });
      mark(produced, "live restore", restored.documents[0]?.outcome === "restored", JSON.stringify(restored));
    } else {
      mark(produced, "live restore", false, "no deletedAt after delete");
    }

    const purgeMe = await create("purge-me", "Bytes to drop.");
    const purgedDelete = await s.writer.delete("purge-me");
    if (purgedDelete.ok) {
      await db
        .update(documents)
        .set({ deletedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
        .where(eq(documents.id, purgeMe));
      const n = await runtime.ports.documentTrash.purge();
      const [purged] = await db
        .select({ contentPurgedAt: documents.contentPurgedAt })
        .from(documents)
        .where(eq(documents.id, purgeMe));
      mark(
        produced,
        "content purge",
        purged?.contentPurgedAt != null,
        `purge()=${n} contentPurgedAt=${purged?.contentPurgedAt ?? null} (backdated deletedAt to pass retention)`,
      );
    } else {
      mark(produced, "content purge", false, JSON.stringify(purgedDelete));
    }

    await mkdir("held");
    const heldNote = await create("held/note", "A note in a folder.");
    await mkdir("doomed");
    const letter = await create("doomed/letter", "A letter.");

    const scene = await s.model(rewrite).create("arc-2/scene", "A new scene.");
    mark(produced, "drafted create in new folder", true, `scene=${scene}`);

    const draftMove = await s.model(rewrite).now("write", {
      command: "move",
      from: { path: "manuscript://arc-1/ch1" },
      path: "manuscript://arc-2/ch1",
    });
    mark(
      produced,
      "drafted move",
      !(draftMove.isError ?? false),
      JSON.stringify(draftMove.output).slice(0, 240),
    );

    const draftRename = await s.model(rewrite).now("write", {
      command: "move",
      from: { path: "manuscript://arc-1/ch2" },
      path: "manuscript://arc-1/ch2-draft",
    });
    mark(
      produced,
      "drafted rename",
      !(draftRename.isError ?? false),
      JSON.stringify(draftRename.output).slice(0, 240),
    );

    const draftDelete = await s.model(rewrite).now("write", {
      command: "delete",
      path: "manuscript://staging/ch3",
    });
    mark(
      produced,
      "drafted delete",
      !(draftDelete.isError ?? false),
      JSON.stringify(draftDelete.output).slice(0, 240),
    );

    const draftReorder = await s.model(rewrite).now("write", {
      command: "move",
      from: { path: "manuscript://opening" },
      path: "manuscript://opening",
      position: { kind: "start" },
    });
    mark(
      produced,
      "drafted reorder",
      !(draftReorder.isError ?? false),
      JSON.stringify(draftReorder.output).slice(0, 240),
    );

    await s.model(polish).edit("doomed/letter", "A letter.", "A drafted letter.");
    mark(produced, "drafted edit in doomed folder", true, `letter=${letter}`);

    const inboxMove = await s.model(polish).now("write", {
      command: "move",
      from: { path: "manuscript://held/note" },
      path: "manuscript://inbox/note",
    });
    mark(
      produced,
      "drafted move into new folder (held)",
      !(inboxMove.isError ?? false),
      JSON.stringify(inboxMove.output).slice(0, 240),
    );

    await runtime.ports.documentSync.draftEffects.flush();

    try {
      await mkdir("inbox");
      mark(produced, "live mkdir inbox (absorb hidden)", true, "inbox");
    } catch (error) {
      mark(produced, "live mkdir inbox (absorb hidden)", false, String(error));
    }
    const renamedInbox = await s.writer.move("inbox", "mail");
    mark(
      produced,
      "live rename of held folder",
      renamedInbox.ok,
      renamedInbox.ok ? "inbox→mail" : JSON.stringify(renamedInbox),
    );
    await mkdir("archive");
    const movedMail = await s.writer.move("mail", "archive/mail");
    mark(
      produced,
      "live move of held folder",
      movedMail.ok,
      movedMail.ok ? "mail→archive/mail" : JSON.stringify(movedMail),
    );
    const doomedDelete = await s.writer.delete("doomed");
    mark(
      produced,
      "live delete of drafted document's folder (folder_missing)",
      doomedDelete.ok,
      doomedDelete.ok ? "deleted doomed/" : JSON.stringify(doomedDelete),
    );
    const archiveDelete = await s.writer.delete("archive");
    mark(
      produced,
      "live delete of absorbed/held folder",
      archiveDelete.ok,
      archiveDelete.ok ? "deleted archive/" : JSON.stringify(archiveDelete),
    );

    const wander = await create("wander", "Moved in a draft, then killed live.");
    const wanderMove = await s.model(polish).now("write", {
      command: "move",
      from: { path: "manuscript://wander" },
      path: "manuscript://wandered",
    });
    mark(
      produced,
      "drafted move only (no text)",
      !(wanderMove.isError ?? false),
      JSON.stringify(wanderMove.output).slice(0, 200),
    );
    const wanderLiveDelete = await s.writer.delete("wander");
    mark(
      produced,
      "live delete of drafted-move-only document",
      wanderLiveDelete.ok,
      wanderLiveDelete.ok ? `deleted ${wander}` : JSON.stringify(wanderLiveDelete),
    );

    const cutMe = await create("cut-me", "The branch will delete me; live keeps me.");
    const branchDelete = await s.model(rewrite).now("write", {
      command: "delete",
      path: "manuscript://cut-me",
    });
    mark(
      produced,
      "drafted delete of a still-live document",
      !(branchDelete.isError ?? false),
      JSON.stringify(branchDelete.output).slice(0, 200),
    );

    await runtime.ports.documentSync.draftEffects.flush();

    const rewriteItems = await s.items(rewrite);
    const renameItem = rewriteItems.find((item) => item.documentId === ch2);
    const deleteItem = rewriteItems.find((item) => item.documentId === ch3);
    if (renameItem) {
      const applied = await handleApplyClickRequest(selectBranchRouteServices(runtime.app), {
        projectId: s.project.id,
        branchId: renameItem.branchId,
        userId: s.project.userId,
        documentId: ch2,
        request: {
          commandId: randomUUID(),
          baseViewDelta: [],
          groupIds: [],
          tree: { revision: renameItem.tree?.revision ?? null },
        },
      });
      mark(produced, "partial apply (ch2 rename)", applied.status === "applied", JSON.stringify(applied).slice(0, 240));
    } else {
      mark(produced, "partial apply (ch2 rename)", false, "no review item for ch2");
    }
    if (deleteItem) {
      const discarded = await s.discard(rewrite, [ch3]);
      mark(produced, "partial discard (ch3 delete)", true, JSON.stringify(discarded).slice(0, 240));
    } else {
      mark(produced, "partial discard (ch3 delete)", false, "no review item for ch3");
    }

    await runtime.ports.documentSync.draftEffects.flush();

    const absorbedRows = await db
      .select({ id: folders.id, name: folders.name, absorbedInto: folders.absorbedInto, hidden: folders.hidden })
      .from(folders);
    const absorbedAny = absorbedRows.filter((row) => row.absorbedInto != null);
    mark(
      produced,
      "absorbed_into row",
      absorbedAny.length > 0,
      absorbedAny.length > 0 ? JSON.stringify(absorbedAny) : "no absorbed_into (mkdir may have reused the hidden folder)",
    );
    const held = await db.select().from(branchTreeFolders);
    mark(produced, "held-folder rows", held.length > 0, `branch_tree_folders=${held.length}`);

    // --- migrate ---
    const migrated = await migrateProject(db, s.project.id);
    const checked = await checkProject(db, s.project.id, migrated);
    report.counts = migrated.counts;
    report.unrecorded = migrated.unrecorded;
    report.actorColumns = migrated.actorColumns;
    report.recordCount = migrated.records.length;
    report.checkOk = checked.ok;
    report.violations = checked.violations;
    report.diffs = checked.diffs;
    report.liveFingerprint = checked.fingerprint;

    const rewriteBranch = await s.branchOf(rewrite);
    const polishBranch = await s.branchOf(polish);
    report.openBranches = [rewriteBranch.id, polishBranch.id];

    const q4 = await authorship(db, s.project.id, migrated);
    report.q4 = q4;

    const q7 = {
      previousLocationRows: migrated.previousLocations.length,
      recordsKnowHistory: migrated.records.some(
        (op) => op.type === "rename" && op.draft === null,
      ),
      mustStay: true,
      reason:
        "Migrated live records are a snapshot (one create at the current name/parent). Earlier names and parents are not in the log unless the change is still a drafted op. document_previous_locations must stay for old-path redirects.",
    };
    report.q7 = q7;

    // Q6: Apply Polish (has live-deleted docs) with applyLanding, then today's per-document loop.
    const draftId = polishBranch.id;
    const pendingText = new Set(migrated.pendingText[draftId] ?? []);
    const ydoc = new Y.Doc({ gc: false });
    const writer = new TreeWriter(ydoc);
    ydoc.transact(() => {
      opsOf(ydoc).push(migrated.records);
    });
    const landing = writer.applyLanding(draftId, `user:${s.project.userId}`);
    const liveAfterWriter = materialize(ydoc, LIVE);
    report.q6 = {
      blocked: landing.blocked,
      left: landing.left.map((op) => ({ id: op.id, type: op.type, node: op.node, draft: op.draft })),
      copies: landing.copies.map((op) => ({ id: op.id, type: op.type, node: op.node, fromDraft: op.fromDraft })),
      writerViolations: treeViolations(liveAfterWriter),
      pendingText: [...pendingText],
    };
    void viewOpsFor;
    void replay;
    void fingerprint;

    const overlayBeforeToday = await snapshotOverlay(db, { kind: "live" });
    const routes = selectBranchRouteServices(runtime.app);
    const applyResults: unknown[] = [];
    const seen = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      await runtime.ports.documentSync.draftEffects.flush();
      const items = await s.items(polish);
      const item = items.find((row) => !seen.has(row.documentId));
      if (!item) break;
      seen.add(item.documentId);
      const applied = await handleApplyClickRequest(routes, {
        projectId: s.project.id,
        branchId: item.branchId,
        userId: s.project.userId,
        documentId: item.documentId as never,
        request: {
          commandId: randomUUID(),
          baseViewDelta: [],
          groupIds: [],
          tree: { revision: item.tree?.revision ?? null },
        },
      });
      applyResults.push({
        documentId: item.documentId,
        status: applied.status,
        deletedLive: item.deletedLive,
        tree: item.tree,
        extra: "reason" in applied ? (applied as { reason?: unknown }).reason : undefined,
      });
    }
    const overlayAfterToday = await snapshotOverlay(db, { kind: "live" });
    const writerSnap = snapshotReplay(liveAfterWriter);
    const todayVsWriter: unknown[] = [];
    const writerIds = new Set(writerSnap.nodes.map((n) => n.id));
    const todayIds = new Set(overlayAfterToday.nodes.map((n) => n.id));
    for (const id of todayIds) {
      if (!writerIds.has(id)) todayVsWriter.push({ extraInToday: id });
    }
    for (const node of writerSnap.nodes) {
      if (!todayIds.has(node.id)) todayVsWriter.push({ missingInToday: node.id, name: node.name });
      const other = overlayAfterToday.nodes.find((n) => n.id === node.id);
      if (!other) continue;
      if (other.parent !== node.parent || other.name !== node.name) {
        todayVsWriter.push({
          id: node.id,
          writer: { parent: node.parent, name: node.name, path: node.path },
          today: { parent: other.parent, name: other.name, path: other.path },
        });
      }
    }
    const liveDeletedAfterToday = await db
      .select({ id: documents.id, name: documents.name, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, documents.id));
    (report.q6 as Record<string, unknown>).todayApply = applyResults;
    (report.q6 as Record<string, unknown>).todayVsWriter = todayVsWriter;
    (report.q6 as Record<string, unknown>).todayLiveCount = overlayAfterToday.nodes.length;
    (report.q6 as Record<string, unknown>).writerLiveCount = writerSnap.nodes.length;
    (report.q6 as Record<string, unknown>).overlayBeforeTodayCount = overlayBeforeToday.nodes.length;
    (report.q6 as Record<string, unknown>).stillDeletedLive = liveDeletedAfterToday
      .filter((row) => row.deletedAt != null)
      .map((row) => ({ id: row.id, name: row.name }));

    const summary = {
      produced: Object.fromEntries(
        Object.entries(produced).map(([k, v]) => [k, v.ok ? v.detail : `FAIL ${v.detail}`]),
      ),
      checkOk: report.checkOk,
      violations: report.violations,
      diffCount: Array.isArray(report.diffs) ? report.diffs.length : null,
      diffs: report.diffs,
      counts: report.counts,
      q6: {
        blocked: (report.q6 as Record<string, unknown>).blocked,
        left: (report.q6 as Record<string, unknown>).left,
        copies: (report.q6 as Record<string, unknown>).copies,
        todayApply: (report.q6 as Record<string, unknown>).todayApply,
        todayVsWriter: (report.q6 as Record<string, unknown>).todayVsWriter,
        todayLiveCount: (report.q6 as Record<string, unknown>).todayLiveCount,
        writerLiveCount: (report.q6 as Record<string, unknown>).writerLiveCount,
        stillDeletedLive: (report.q6 as Record<string, unknown>).stillDeletedLive,
      },
      pendingText: migrated.pendingText,
      inventedRecords: migrated.counts.inventedRecords,
      q4unrecorded: (report.q4 as Record<string, unknown>).unrecordedCount,
      q7: report.q7,
    };
    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify(summary, null, 2));
    const { writeFileSync } = await import("node:fs");
    writeFileSync("/tmp/p16552-tree-oplog-migrate.json", JSON.stringify(report, null, 2));
    console.log("full report: /tmp/p16552-tree-oplog-migrate.json");
  } finally {
    if (runtime) {
      await unloadHocuspocus(runtime.hocuspocus);
      await runtime.app.shutdown();
      await runtime.ports.documentSync.drainHocuspocusPersistence();
    }
    await db.close();
  }
}

async function authorship(db: ReturnType<typeof createDb>, projectId: string, migrated: Awaited<ReturnType<typeof migrateProject>>) {
  const edits = await db
    .select({
      documentId: documentEdits.documentId,
      actor: documentEdits.actor,
      actorUserId: documentEdits.actorUserId,
      threadId: documentEdits.threadId,
      turnId: documentEdits.turnId,
      kind: documentEdits.kind,
      treeChange: documentEdits.treeChange,
    })
    .from(documentEdits)
    .where(eq(documentEdits.documentId, documentEdits.documentId));
  const treeEdits = edits.filter((row) => row.treeChange != null);
  const previous = await db.select().from(documentPreviousLocations);
  const changes = await db.select().from(branchTreeChanges);
  const deletedDocs = await db
    .select({
      id: documents.id,
      deletedByUserId: documents.deletedByUserId,
      deletedByThreadId: documents.deletedByThreadId,
      deletedAt: documents.deletedAt,
      contentPurgedAt: documents.contentPurgedAt,
    })
    .from(documents)
    .where(eq(documents.id, documents.id));

  const liveCreatesUnrecorded = migrated.unrecorded.filter((f) => f.fact === "create.document" || f.fact === "create.folder");
  const liveFolderCreates = migrated.records.filter((op) => op.type === "create" && op.draft === null && op.kind === "folder");
  const liveDocCreates = migrated.records.filter((op) => op.type === "create" && op.draft === null && op.kind !== "folder");
  const liveDocCreatesUnrecorded = liveDocCreates.filter((op) => op.actor === "unrecorded");
  const liveFolderCreatesUnrecorded = liveFolderCreates.filter((op) => op.actor === "unrecorded");

  return {
    documentEditsWithTreeChange: treeEdits.length,
    documentEditsStayInTable: true,
    previousLocations: previous.length,
    previousLocationsStayInTable: true,
    branchTreeChangeActors: changes.map((row) => ({
      nodeId: row.nodeId,
      createdThreadId: row.createdThreadId,
      changedThreadId: row.changedThreadId,
    })),
    deletedDocActors: deletedDocs
      .filter((row) => row.deletedAt)
      .map((row) => ({
        id: row.id,
        deletedByUserId: row.deletedByUserId,
        deletedByThreadId: row.deletedByThreadId,
        contentPurgedAt: row.contentPurgedAt,
      })),
    unrecordedCount: migrated.unrecorded.length,
    liveFolderCreatesUnrecorded: liveFolderCreatesUnrecorded.length,
    liveDocumentCreatesUnrecorded: liveDocCreatesUnrecorded.length,
    liveFolderCreates: liveFolderCreates.length,
    liveDocumentCreates: liveDocCreates.length,
    factsWithNoActorAtAll: liveCreatesUnrecorded.length,
    note: "Who created a folder, and who renamed or moved a live node (unless a document_edits tree_change row says), is unrecorded. Those facts stay in their tables when the table holds them (document_edits, document_previous_locations); folders have no such table.",
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
