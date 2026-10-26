/** Durable prepare → generation build → atomic reveal orchestration. */
import { isDeepStrictEqual } from "node:util";
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { ImportLinkBinder, MarkdownDocumentStore } from "../../../collab/index.js";
import type { ContextImportRead, ContextStagedCreation } from "../../../context/index.js";
import type { ObjectStorePort } from "../../../storage/index.js";
import type { DocumentConverterPort } from "../../ports/document-converter.js";
import type { ImportEntry, ImportRecord, ImportRepository } from "../../ports/import-repository.js";
import type { OrganizeClaim, OrganizeQueue } from "../../ports/organize-queue.js";
import { createLinkIndex, type ImportLinkCandidate } from "../link-index.js";
import { convertNote, respell } from "../note-conversion.js";
import { plannedRoots } from "../plan.js";
import { stagingKeyTime } from "../staging-key.js";
import { buildOrganizedTree, type OrganizedTree } from "./organize-tree.js";
import { prepareImportEntries } from "./prepare.js";

const BUILD_NODES = 500;
const BUILD_BYTES = 16 * 1024 * 1024;
const MAX_REBUILT_GENERATIONS = 5;

type OrganizerDeps = {
  repository: ImportRepository;
  queue: OrganizeQueue;
  objects: ObjectStorePort;
  converter: DocumentConverterPort;
  context(record: ImportRecord): { read: ContextImportRead; staged: ContextStagedCreation };
  binder: ImportLinkBinder;
  documents: Pick<MarkdownDocumentStore, "prepareSeed">;
  diagnostic(cause: unknown, detail: Record<string, unknown>): void;
};

function samePlacement(left: ImportRecord["placement"], right: ImportRecord["placement"]): boolean {
  return isDeepStrictEqual(left, right);
}

function uriMap(tree: OrganizedTree): Map<string, string> {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const destinations = new Map(tree.placement.destinations.map((row) => [row.area, row]));
  const memo = new Map<string, string>();
  const uri = (id: string): string => {
    const known = memo.get(id);
    if (known) return known;
    const node = nodes.get(id);
    if (!node?.area) throw new Error(`Import node has no area: ${id}`);
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    const base = parent
      ? uri(parent.id).replace(/[^/]*$/, "")
      : (destinations.get(node.area)?.uri ?? `${node.area}://`);
    const value = `${base}${node.filename}${node.kind === "folder" ? "/" : ""}`;
    memo.set(id, value);
    return value;
  };
  for (const node of tree.nodes) uri(node.id);
  return memo;
}

async function readText(objects: ObjectStorePort, key: string): Promise<string> {
  const result = await objects.get(key);
  if (!result.ok) throw new Error(`Prepared import object is unavailable: ${key}`);
  return Buffer.from(result.value.bytes).toString("utf8");
}

export function createImportOrganizer(deps: OrganizerDeps) {
  async function recordNoProgress(claim: OrganizeClaim): Promise<void> {
    await deps.repository.organizeTransaction(claim, async (locked) => {
      const attempts = locked.claimsWithoutProgress + 1;
      const now = await deps.repository.now();
      await deps.repository.update(locked.id, {
        claimsWithoutProgress: attempts,
        lastActivityAt: now,
        ...(attempts >= MAX_REBUILT_GENERATIONS
          ? {
              state: "failed" as const,
              reason: "organize_failed" as const,
              finishedAt: now,
              leaseToken: null,
              leaseUntil: null,
            }
          : {}),
      });
    });
  }
  async function resetGeneration(
    claim: OrganizeClaim,
    tree: OrganizedTree,
  ): Promise<"reset" | "failed" | "stale"> {
    const result = await deps.repository.organizeTransaction(claim, async (locked) => {
      const rebuilt =
        locked.placement === null ? locked.claimsWithoutProgress : locked.claimsWithoutProgress + 1;
      await deps.context(locked).staged.discardStaged(locked.id);
      if (rebuilt >= MAX_REBUILT_GENERATIONS) {
        const now = await deps.repository.now();
        await deps.repository.update(locked.id, {
          state: "failed",
          reason: "organize_failed",
          finishedAt: now,
          lastActivityAt: now,
          leaseToken: null,
          leaseUntil: null,
          claimsWithoutProgress: rebuilt,
        });
        return "failed" as const;
      }
      await deps.repository.update(locked.id, {
        placement: tree.placement,
        placementGeneration: locked.placementGeneration + 1,
        fellBack: locked.fellBack || tree.placement.destinations.some((row) => row.fellBack),
        claimsWithoutProgress: rebuilt,
      });
      await deps.repository.transitionEntries(locked.id, ["prepared"], {
        state: "received",
      });
      return "reset" as const;
    });
    return result.kind === "committed" ? result.value : "stale";
  }

  /** Everything a generation's batches share, loaded once: link index, entries, and the nodes still to stage. */
  async function prepareBuild(
    record: ImportRecord,
    tree: OrganizedTree,
    entries: readonly ImportEntry[],
    read: ContextImportRead,
  ) {
    const uris = uriMap(tree);
    const staged = new Set(
      entries.filter((entry) => entry.state === "prepared").map((entry) => entry.id),
    );
    const planned = new Set(
      tree.nodes
        .filter((node) => node.state === "planned" && node.kind !== "folder")
        .map((node) => node.id as DocumentId),
    );
    const selected: ImportLinkCandidate[] = tree.nodes.flatMap((node) =>
      node.state === "planned" && node.kind !== "folder"
        ? [
            {
              id: node.id,
              uri: uris.get(node.id) ?? "",
              path: node.path,
              rootId: node.rootId,
              aliases: node.aliases ?? [],
              kind: node.kind,
              filetype: node.filetype,
            },
          ]
        : [],
    );
    const existing: ImportLinkCandidate[] = (await read.linkCandidates()).map((candidate) => ({
      ...candidate,
      rootId: null,
      kind: "note",
    }));
    return {
      uris,
      planned,
      entriesById: new Map(entries.map((entry) => [entry.id, entry])),
      pending: tree.nodes.filter((node) => node.state === "planned" && !staged.has(node.id)),
      index: createLinkIndex(selected, existing),
      selectedById: new Map(selected.map((candidate) => [candidate.id, candidate])),
      roots: new Map(
        plannedRoots({ roots: record.roots } as never).map((root) => [root.rootId, root]),
      ),
    };
  }

  /** Stages the next batch of `build.pending` from `offset`; returns how many nodes it consumed. */
  async function buildBatch(
    claim: OrganizeClaim,
    record: ImportRecord,
    build: Awaited<ReturnType<typeof prepareBuild>>,
    offset: number,
  ): Promise<number> {
    const projectId = record.projectId;
    if (!projectId) throw new Error("Import project is unavailable");
    const { entriesById, index, pending, planned, roots, selectedById, uris } = build;
    const batch = [] as typeof pending;
    const folders = [] as Parameters<ContextStagedCreation["stage"]>[2]["folders"][number][];
    const documents = [] as Parameters<ContextStagedCreation["stage"]>[2]["documents"][number][];
    let bytes = 0;
    for (const node of pending.slice(offset, offset + BUILD_NODES)) {
      if (node.kind === "folder") {
        if (!node.area) throw new Error(`Import node has no area: ${node.id}`);
        batch.push(node);
        folders.push({ id: node.id, parentId: node.parentId, area: node.area, name: node.name });
        continue;
      }
      const entry = entriesById.get(node.id);
      if (entry?.kind !== "file" || !entry.receipt)
        throw new Error(`Import node has no receipt: ${node.id}`);
      if (!node.area) throw new Error(`Import node has no area: ${node.id}`);
      const base = {
        id: node.id,
        parentId: node.parentId,
        area: node.area,
        name: node.name,
        extension: node.extension,
        filetype: node.filetype,
        origin: {
          type: "import" as const,
          userId: record.userId,
          source: "upload",
          filename: node.filename,
        },
      };
      let document: (typeof documents)[number];
      if (node.kind === "binary") {
        document = {
          ...base,
          content: {
            kind: "binary",
            storageUrl: entry.receipt.storageUrl,
            mimeType: entry.receipt.facts.mimeType,
            sizeBytes: entry.receipt.receivedSize,
          },
        };
      } else {
        const key = entry.convertedKey ?? entry.receipt.objectKey;
        const text = await readText(deps.objects, key);
        if (node.kind === "code") {
          const content = deps.binder.bindPlannedCode(node.id as DocumentId, node.filetype, text);
          const seed = await deps.documents.prepareSeed({
            documentId: node.id as DocumentId,
            projectId,
            uri: uris.get(node.id) ?? "",
            content,
            origin: base.origin,
          });
          document = { ...base, content: { kind: "tracked", seed, aheadMints: [] } };
        } else {
          const source = selectedById.get(node.id);
          if (!source) throw new Error(`Import note has no link candidate: ${node.id}`);
          const root = roots.get(node.rootId);
          const converted = convertNote(text, {
            source,
            index,
            attachmentFolder: root?.settings.attachmentFolderPath ?? "",
            aheadFolder: `${node.area}://`,
          });
          const bound = await deps.binder.bindPlannedMarkdown({
            holder: {
              documentId: node.id as DocumentId,
              uri: uris.get(node.id) ?? "",
              projectId,
              filetype: node.filetype,
            },
            markdown: converted.template,
            targets: converted.targets as ReadonlyMap<number, DocumentId>,
            hrefs: respell(converted, uris),
            planned,
          });
          const seed = await deps.documents.prepareSeed({
            documentId: node.id as DocumentId,
            projectId,
            uri: uris.get(node.id) ?? "",
            content: bound.content,
            origin: base.origin,
          });
          document = {
            ...base,
            metadata: {
              ...(converted.properties ? { properties: converted.properties } : {}),
              ...(converted.aliases.length ? { aliases: converted.aliases } : {}),
            },
            content: { kind: "tracked", seed, aheadMints: bound.aheadMints },
          };
        }
      }
      const stagedBytes =
        document.content.kind === "tracked"
          ? document.content.seed.state.byteLength +
            document.content.seed.stateVector.byteLength +
            Buffer.byteLength(document.content.seed.markdown, "utf8") +
            Buffer.byteLength(JSON.stringify(document.content.seed.attributionManifest), "utf8") +
            Buffer.byteLength(JSON.stringify(document.content.aheadMints), "utf8")
          : 0;
      // A Yjs seed is indivisible. If one seed exceeds the batch cap, stage it alone;
      // otherwise the import could never advance past that document.
      if (batch.length && bytes + stagedBytes > BUILD_BYTES) break;
      batch.push(node);
      documents.push(document);
      bytes += stagedBytes;
    }
    const result = await deps.repository.organizeTransaction(
      { ...claim, generation: record.placementGeneration },
      async (locked) => {
        await deps
          .context(locked)
          .staged.stage(locked.id, locked.placementGeneration, { folders, documents });
        await deps.repository.transitionEntries(
          locked.id,
          ["received"],
          { state: "prepared" },
          batch.map((node) => node.id),
        );
        const counts = await deps.repository.refreshCounts(locked.id);
        await deps.repository.update(locked.id, {
          counts,
          lastActivityAt: await deps.repository.now(),
        });
        return batch.length;
      },
    );
    return result.kind === "committed" ? result.value : 0;
  }

  async function organize(claim: OrganizeClaim, signal: AbortSignal): Promise<number> {
    let record = await deps.repository.read(claim.importId);
    if (record?.state !== "organizing") return 0;
    const entries = await deps.repository.entries(record.id);
    const prepared = await prepareImportEntries(deps, { importId: record.id, entries });
    if (prepared.patches.length) {
      const applied = await deps.repository.organizeTransaction(claim, async (locked) => {
        const now = await deps.repository.now();
        if (
          prepared.createdKeys.some((key) => stagingKeyTime(key) < now.getTime() - 60 * 60 * 1000)
        )
          throw new Error("Prepared import object key is too old");
        await deps.repository.updateEntries(locked.id, prepared.patches);
      });
      if (applied.kind !== "committed") return 0;
    }
    const refreshed = await deps.repository.read(record.id);
    if (!refreshed) return 0;
    record = refreshed;
    const durableEntries = await deps.repository.entries(record.id);
    const parsed = parseContextUri(record.destinationUri);
    if (!parsed.ok) throw new Error("Import destination is invalid");
    const context = deps.context(record);
    const destinations = await context.read.destinations({
      destinationUri: record.destinationUri,
      folderId: record.folderId,
      areas: [
        parsed.value.scheme as "manuscript" | "kb" | "unfiled",
        "manuscript",
        "kb",
        "unfiled",
      ],
    });
    const tree = await buildOrganizedTree({ record, entries: durableEntries, destinations });
    if (!samePlacement(record.placement, tree.placement)) {
      const reset = await resetGeneration(claim, tree);
      return reset === "reset" ? 1 : 0;
    }
    const build = await prepareBuild(record, tree, durableEntries, context.read);
    let built = 0;
    while (!signal.aborted && built < build.pending.length) {
      const batch = await buildBatch(claim, record, build, built);
      if (!batch) break;
      built += batch;
    }
    if (signal.aborted) return built;
    const revealed = await deps.repository.organizeTransaction(
      { ...claim, generation: record.placementGeneration },
      async (locked) => {
        const result = await deps.context(locked).staged.commitStaged(locked.id, {
          generation: locked.placementGeneration,
          destinations: tree.placement.destinations,
          topLevelNames: new Map(Object.entries(tree.placement.topLevelNames)),
        });
        if (result.kind === "changed") return "changed" as const;
        const now = await deps.repository.now();
        await deps.repository.transitionEntries(locked.id, ["prepared"], {
          state: "organized",
        });
        const counts = await deps.repository.refreshCounts(locked.id);
        await deps.repository.update(locked.id, {
          state: "finished",
          counts,
          roots: locked.roots.map((root) => ({
            ...root,
            created: !!root.id && tree.nodes.some((node) => node.id === root.id),
          })),
          revealedAt: now,
          finishedAt: now,
          lastActivityAt: now,
          leaseToken: null,
          leaseUntil: null,
        });
        return "revealed" as const;
      },
    );
    if (revealed.kind === "committed" && revealed.value === "changed") {
      const changed = await deps.repository.read(record.id);
      if (!changed) return 0;
      const changedEntries = await deps.repository.entries(changed.id);
      const changedDestinations = await context.read.destinations({
        destinationUri: changed.destinationUri,
        folderId: changed.folderId,
        areas: [
          parsed.value.scheme as "manuscript" | "kb" | "unfiled",
          "manuscript",
          "kb",
          "unfiled",
        ],
      });
      await resetGeneration(
        claim,
        await buildOrganizedTree({
          record: changed,
          entries: changedEntries,
          destinations: changedDestinations,
        }),
      );
      return 1;
    }
    return revealed.kind === "committed" ? 1 : 0;
  }

  return {
    async runPass(signal: AbortSignal): Promise<number> {
      let total = 0;
      for (let pass = 0; pass < 100 && !signal.aborted; pass++) {
        const claim = await deps.queue.claim();
        if (!claim) break;
        const heartbeat = setInterval(() => void deps.queue.heartbeat(claim), 30_000);
        heartbeat.unref();
        try {
          total += await organize(claim, signal);
        } catch (cause) {
          deps.diagnostic(cause, {
            importId: claim.importId,
            token: claim.token,
            generation: claim.generation,
          });
          await recordNoProgress(claim);
        } finally {
          clearInterval(heartbeat);
          await deps.queue.release(claim);
        }
      }
      return total;
    },
  };
}
