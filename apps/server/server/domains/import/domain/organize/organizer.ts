/** Durable prepare → plan → batches of first texts → one reveal orchestration. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { ImportLinkBinder, MarkdownDocumentStore } from "../../../collab/index.js";
import type {
  ContextImportRead,
  ContextImportReveal,
  ImportRevealNode,
} from "../../../context/index.js";
import type { ImagePreviewFailureReason } from "../../../file-intake/image-preview.js";
import type { ObjectStorePort } from "../../../storage/index.js";
import type { DocumentConverterPort } from "../../ports/document-converter.js";
import type {
  EntryAhead,
  ImportEntry,
  ImportRecord,
  ImportRepository,
} from "../../ports/import-repository.js";
import type { OrganizeClaim, OrganizeQueue } from "../../ports/organize-queue.js";
import { createLinkIndex, type ImportLinkCandidate } from "../link-index.js";
import { convertNote, respell } from "../note-conversion.js";
import { plannedRoots } from "../plan.js";
import { stagingKeyTime } from "../staging-key.js";
import { buildOrganizedTree, type OrganizedTree } from "./organize-tree.js";
import { prepareImportEntries } from "./prepare.js";

const BUILD_NODES = 500;
const BUILD_BYTES = 16 * 1024 * 1024;
const MAX_FAILED_PASSES = 5;
/** Pause after the nth consecutive failed pass: 10 s, 20 s, 40 s, 80 s. */
const retryDelayMs = (attempts: number) => 10_000 * 2 ** (attempts - 1);

type OrganizerDeps = {
  repository: ImportRepository;
  queue: OrganizeQueue;
  objects: ObjectStorePort;
  converter: DocumentConverterPort;
  read(record: ImportRecord): ContextImportRead;
  binder: ImportLinkBinder;
  documents: Pick<MarkdownDocumentStore, "encodeSeed" | "installSeeds">;
  reveal: ContextImportReveal;
  diagnostic(cause: unknown, detail: Record<string, unknown>): void;
  /** An image preview that should have been made but failed; the file shows as a card. */
  previewFailed(reason: ImagePreviewFailureReason): void;
};

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
  async function recordNoProgress(claim: OrganizeClaim): Promise<number> {
    const result = await deps.repository.organizeTransaction(claim, async (locked) => {
      const attempts = locked.claimsWithoutProgress + 1;
      const now = await deps.repository.now();
      await deps.repository.update(locked.id, {
        claimsWithoutProgress: attempts,
        lastActivityAt: now,
        ...(attempts >= MAX_FAILED_PASSES
          ? {
              state: "failed" as const,
              reason: "organize_failed" as const,
              finishedAt: now,
              leaseToken: null,
              leaseUntil: null,
            }
          : {}),
      });
      return attempts;
    });
    return result.kind === "committed" ? result.value : 0;
  }
  /** Keeps the plan on the import, once: later passes plan from it. */
  async function storePlacement(claim: OrganizeClaim, tree: OrganizedTree): Promise<boolean> {
    const result = await deps.repository.organizeTransaction(claim, async (locked) => {
      if (locked.placement !== null) return;
      await deps.repository.update(locked.id, {
        placement: tree.placement,
        fellBack: locked.fellBack || tree.placement.destinations.some((row) => row.fellBack),
      });
    });
    return result.kind === "committed";
  }

  /** Everything the batches share, loaded once: link index, entries, and the nodes still to write. */
  async function prepareBuild(
    record: ImportRecord,
    tree: OrganizedTree,
    entries: readonly ImportEntry[],
    read: ContextImportRead,
  ) {
    const uris = uriMap(tree);
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
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
      entriesById,
      // An entry still `received` has had no batch: its first text is not in the journal yet.
      pending: tree.nodes.filter(
        (node) => node.state === "planned" && entriesById.get(node.id)?.state === "received",
      ),
      index: createLinkIndex(selected, existing),
      selectedById: new Map(selected.map((candidate) => [candidate.id, candidate])),
      roots: new Map(
        plannedRoots({ roots: record.roots } as never).map((root) => [root.rootId, root]),
      ),
    };
  }

  /**
   * Writes the next batch of `build.pending` from `offset`: each document's first state into the
   * journal under the id its create will have, and what else the batch worked out onto the
   * entry. Returns how many nodes it consumed.
   */
  async function buildBatch(
    claim: OrganizeClaim,
    record: ImportRecord,
    projectId: string,
    build: Awaited<ReturnType<typeof prepareBuild>>,
    offset: number,
  ): Promise<number> {
    const { entriesById, index, pending, planned, roots, selectedById, uris } = build;
    const batch = [] as typeof pending;
    const seeds = [] as { documentId: DocumentId; state: Uint8Array }[];
    const aheads = [] as { id: string; ahead: EntryAhead }[];
    let bytes = 0;
    for (const node of pending.slice(offset, offset + BUILD_NODES)) {
      if (node.kind === "folder") {
        batch.push(node);
        continue;
      }
      const entry = entriesById.get(node.id);
      if (entry?.kind !== "file" || !entry.receipt)
        throw new Error(`Import node has no receipt: ${node.id}`);
      if (!node.area) throw new Error(`Import node has no area: ${node.id}`);
      if (node.kind === "binary") {
        batch.push(node);
        continue;
      }
      const origin = {
        type: "import" as const,
        userId: record.userId,
        source: "upload",
        filename: node.filename,
      };
      const text = await readText(deps.objects, entry.convertedKey ?? entry.receipt.objectKey);
      let state: Uint8Array;
      let ahead: EntryAhead;
      if (node.kind === "code") {
        const content = deps.binder.bindPlannedCode(node.id as DocumentId, node.filetype, text);
        state = deps.documents.encodeSeed(content, origin);
        ahead = { aheadMints: [] };
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
        state = deps.documents.encodeSeed(bound.content, origin);
        ahead = {
          ...(converted.properties ? { properties: converted.properties } : {}),
          ...(converted.aliases.length ? { aliases: converted.aliases } : {}),
          aheadMints: [...bound.aheadMints],
        };
      }
      const stagedBytes = state.byteLength + Buffer.byteLength(JSON.stringify(ahead), "utf8");
      // A Yjs seed is indivisible. If one seed exceeds the batch cap, write it alone;
      // otherwise the import could never advance past that document.
      if (batch.length && bytes + stagedBytes > BUILD_BYTES) break;
      batch.push(node);
      seeds.push({ documentId: node.id as DocumentId, state });
      aheads.push({ id: node.id, ahead });
      bytes += stagedBytes;
    }
    const result = await deps.repository.organizeTransaction(claim, async (locked) => {
      await deps.documents.installSeeds(seeds);
      await deps.repository.writeAhead(locked.id, aheads);
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
    });
    return result.kind === "committed" ? result.value : 0;
  }

  /** The planned tree as the nodes the reveal makes `create` records of. */
  function revealNodes(
    tree: OrganizedTree,
    entriesById: ReadonlyMap<string, ImportEntry>,
    aheads: ReadonlyMap<string, EntryAhead>,
  ): ImportRevealNode[] {
    return tree.nodes.flatMap((node): ImportRevealNode[] => {
      if (node.state !== "planned") return [];
      if (!node.area) throw new Error(`Import node has no area: ${node.id}`);
      const base = { id: node.id, area: node.area, parentId: node.parentId };
      if (node.kind === "folder") return [{ ...base, kind: "folder", name: node.name }];
      const receipt = entriesById.get(node.id)?.receipt;
      if (!receipt) throw new Error(`Import node has no receipt: ${node.id}`);
      if (node.kind === "binary")
        return [
          {
            ...base,
            kind: "file",
            name: node.filename,
            blob: {
              storageKey: receipt.storageUrl,
              mime: receipt.facts.mimeType,
              size: receipt.receivedSize,
            },
            hasPreview: receipt.hasPreview,
          },
        ];
      const ahead = aheads.get(node.id);
      if (!ahead) throw new Error(`Import node has no first text: ${node.id}`);
      return [
        {
          ...base,
          kind: "document",
          name: node.filename,
          filetype: node.filetype,
          aliases: ahead.aliases ?? [],
          ...(ahead.properties ? { properties: ahead.properties } : {}),
          aheadMints: ahead.aheadMints,
        },
      ];
    });
  }

  async function organize(claim: OrganizeClaim, signal: AbortSignal): Promise<number> {
    let record = await deps.repository.read(claim.importId);
    if (record?.state !== "organizing") return 0;
    const projectId = record.projectId;
    if (!projectId) throw new Error("Import project is unavailable");
    const entries = await deps.repository.entries(record.id);
    const prepared = await prepareImportEntries(deps, {
      importId: record.id,
      projectId,
      entries,
    });
    if (prepared.patches.length) {
      const applied = await deps.repository.organizeTransaction(claim, async (locked) => {
        const now = await deps.repository.now();
        if (
          prepared.createdKeys.some((key) => stagingKeyTime(key) < now.getTime() - 60 * 60 * 1000)
        )
          throw new Error("Prepared import object key is too old");
        await deps.repository.updateEntries(locked.id, prepared.patches);
        await deps.repository.addDerivedEntries(locked.id, prepared.reconverted, prepared.images);
      });
      if (applied.kind !== "committed") return 0;
    }
    const refreshed = await deps.repository.read(record.id);
    if (!refreshed) return 0;
    record = refreshed;
    const durableEntries = await deps.repository.entries(record.id);
    const parsed = parseContextUri(record.destinationUri);
    if (!parsed.ok) throw new Error("Import destination is invalid");
    const read = deps.read(record);
    // The plan is made once, against the destinations as they are, and kept: a later pass plans
    // from it, so the paths the stored texts spell their links with stay the ones planned.
    const fixed = record.placement ?? undefined;
    const tree = await buildOrganizedTree({
      record,
      entries: durableEntries,
      destinations: fixed
        ? fixed.destinations.map((destination) => ({ ...destination, children: [] }))
        : await read.destinations({
            destinationUri: record.destinationUri,
            folderId: record.folderId,
            areas: [
              parsed.value.scheme as "manuscript" | "kb" | "unfiled",
              "manuscript",
              "kb",
              "unfiled",
            ],
          }),
      ...(fixed ? { fixed } : {}),
    });
    if (!fixed && !(await storePlacement(claim, tree))) return 0;
    const build = await prepareBuild(record, tree, durableEntries, read);
    let built = 0;
    while (!signal.aborted && built < build.pending.length) {
      const batch = await buildBatch(claim, record, projectId, build, built);
      if (!batch) break;
      built += batch;
    }
    if (signal.aborted) return built;
    const revealed = await deps.repository.organizeTransaction(claim, async (locked) => {
      await deps.reveal.reveal({
        projectId,
        nodes: revealNodes(tree, build.entriesById, await deps.repository.readAhead(locked.id)),
      });
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
    });
    return revealed.kind === "committed" ? 1 : 0;
  }

  return {
    async runPass(signal: AbortSignal): Promise<number> {
      let total = 0;
      for (let pass = 0; pass < 100 && !signal.aborted; pass++) {
        const claim = await deps.queue.claim();
        if (!claim) break;
        let retryAfterMs: number | undefined;
        const heartbeat = setInterval(() => void deps.queue.heartbeat(claim), 30_000);
        heartbeat.unref();
        try {
          total += await organize(claim, signal);
        } catch (cause) {
          deps.diagnostic(cause, {
            importId: claim.importId,
            token: claim.token,
          });
          const attempts = await recordNoProgress(claim);
          if (attempts) retryAfterMs = retryDelayMs(attempts);
        } finally {
          clearInterval(heartbeat);
          await deps.queue.release(claim, retryAfterMs);
        }
      }
      return total;
    },
  };
}
