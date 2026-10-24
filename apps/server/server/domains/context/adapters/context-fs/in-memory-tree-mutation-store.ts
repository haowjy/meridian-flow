/** Atomic move/delete CAS operations over the shared in-memory context backing. */
import { serializeRemovalIdentity } from "@meridian/contracts";
import {
  allocateFilename,
  parseDocumentFilename,
  renderFilename as renderDocumentFilename,
  sameNamespaceName,
} from "@meridian/contracts/protocol";
import { Err, Ok, type Result } from "../../../../shared/result.js";
import { renderFilename, splitPath } from "../../context/paths.js";
import { ContextEntryConflictError } from "../../ports/context-document-store.js";
import {
  CONTEXT_ROOT_DIRECTORY_ID,
  type ContextLocationToken,
  type ContextTargetExpectation,
  type ContextTreeDeleteCommand,
  type ContextTreeDeleteResult,
  type ContextTreeMoveCommand,
  type ContextTreeMutationError,
  type ContextTreeMutationResult,
  type ContextTreeMutationStore,
} from "../../ports/context-tree-mutation-store.js";
import {
  claimLocation,
  type DocumentRow,
  type FolderRow,
  hasOppositeEntry,
  type InMemoryContextDocumentStoreBacking,
  memoryFileLocations,
  recordMemoryMove,
} from "./in-memory-store.js";

const MISSING_FOLDER = Symbol("missing-folder");

type FolderResolution = string | null | typeof MISSING_FOLDER;

function normalizeTreePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function treePathSegments(path: string): string[] {
  return normalizeTreePath(path).split("/").filter(Boolean);
}

function treeBasename(path: string): string {
  const segments = treePathSegments(path);
  return segments[segments.length - 1] ?? "";
}

function treeDirname(path: string): string {
  const segments = treePathSegments(path);
  segments.pop();
  return segments.join("/");
}

function sameLocation(a: ContextLocationToken | null, b: ContextLocationToken | null): boolean {
  return (
    a?.kind === b?.kind &&
    a?.nodeId === b?.nodeId &&
    a?.sourceId === b?.sourceId &&
    a?.path === b?.path &&
    (a?.kind !== "file" || b?.kind !== "file" || a.filetype === b.filetype)
  );
}

/**
 * Backing-scoped in-memory implementation of the atomic move/delete CAS port.
 * Mutations serialize like the Drizzle adapter's source lock. Snapshots remain
 * coarse because preflight and hooks finish before synchronous backing writes;
 * rollback therefore covers only the active mutator's partial application.
 */
export class InMemoryContextTreeMutationStore implements ContextTreeMutationStore {
  private beforeDestructiveWrite: (() => void | Promise<void>) | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private mutatorTouchedBacking = false;

  constructor(private readonly backing: InMemoryContextDocumentStoreBacking) {}

  /** Test hook: runs after CAS rechecks, immediately before destructive writes. */
  setBeforeDestructiveWrite(hook: (() => void | Promise<void>) | null): void {
    this.beforeDestructiveWrite = hook;
  }

  private markMutatorWrite(): void {
    this.mutatorTouchedBacking = true;
  }

  private async runBeforeDestructiveWrite(): Promise<void> {
    await this.beforeDestructiveWrite?.();
  }

  private nextTimestamp(): string {
    this.backing.clock.value += 1;
    return new Date(this.backing.clock.value * 1000).toISOString();
  }

  private snapshot() {
    return {
      folders: new Map([...this.backing.folders].map(([id, row]) => [id, { ...row }] as const)),
      documents: new Map([...this.backing.documents].map(([id, row]) => [id, { ...row }] as const)),
      previousLocations: new Map(this.backing.previousLocations),
      clock: this.backing.clock.value,
      availabilityGeneration: this.backing.availabilityGeneration.value,
    };
  }

  private restore(snapshot: ReturnType<InMemoryContextTreeMutationStore["snapshot"]>): void {
    this.backing.folders.clear();
    for (const entry of snapshot.folders) this.backing.folders.set(...entry);
    this.backing.documents.clear();
    for (const entry of snapshot.documents) this.backing.documents.set(...entry);
    this.backing.previousLocations = snapshot.previousLocations;
    this.backing.clock.value = snapshot.clock;
    this.backing.availabilityGeneration.value = snapshot.availabilityGeneration;
  }

  private async atomic<T>(
    operation: () => Promise<Result<T, ContextTreeMutationError>>,
  ): Promise<Result<T, ContextTreeMutationError>> {
    const previousMutation = this.mutationTail;
    let releaseMutation = () => {};
    this.mutationTail = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    await previousMutation;
    const snapshot = this.snapshot();
    this.mutatorTouchedBacking = false;
    try {
      const result = await operation();
      if (!result.ok && this.mutatorTouchedBacking) this.restore(snapshot);
      return result;
    } catch (error) {
      if (this.mutatorTouchedBacking) this.restore(snapshot);
      if (error instanceof ContextEntryConflictError)
        return Err({ code: "conflict", occupantKind: error.occupantKind });
      throw error;
    } finally {
      releaseMutation();
    }
  }

  private async findFolderId(sourceId: string, dir: readonly string[]): Promise<FolderResolution> {
    let parentId: string | null = null;
    for (const name of dir) {
      let found: FolderRow | null = null;
      for (const folder of this.backing.folders.values()) {
        if (
          folder.contextSourceId === sourceId &&
          folder.deletedAt === null &&
          folder.parentId === parentId &&
          folder.name === name
        ) {
          found = folder;
          break;
        }
      }
      if (!found) return MISSING_FOLDER;
      parentId = found.id;
    }
    return parentId;
  }

  private ensureFolderPath(sourceId: string, dir: readonly string[]): string | null {
    let parentId: string | null = null;
    for (const name of dir) {
      const existing = this.findDirectFolder(sourceId, parentId, name);
      if (existing) {
        parentId = existing.id;
        continue;
      }
      if (hasOppositeEntry(this.backing, sourceId, parentId, name, "folder"))
        throw new ContextEntryConflictError("file");
      const folder: FolderRow = {
        id: crypto.randomUUID(),
        contextSourceId: sourceId,
        parentId,
        name,
        deletedAt: null,
        updatedAt: this.nextTimestamp(),
      };
      this.backing.folders.set(folder.id, folder);
      claimLocation(this.backing, folder.contextSourceId, folder.parentId, folder.name);
      this.markMutatorWrite();
      parentId = folder.id;
    }
    return parentId;
  }

  private findDirectFolder(
    sourceId: string,
    parentId: string | null,
    name: string,
  ): FolderRow | null {
    for (const folder of this.backing.folders.values()) {
      if (
        folder.contextSourceId === sourceId &&
        folder.deletedAt === null &&
        folder.parentId === parentId &&
        folder.name === name
      ) {
        return folder;
      }
    }
    return null;
  }

  private async findFolderAtPath(sourceId: string, path: string): Promise<FolderRow | null> {
    const segments = treePathSegments(path);
    if (segments.length === 0) return null;
    const folderId = await this.findFolderId(sourceId, segments);
    if (folderId === MISSING_FOLDER || folderId === null) return null;
    return this.backing.folders.get(folderId) ?? null;
  }

  private async findDocumentAtPath(sourceId: string, path: string): Promise<DocumentRow | null> {
    const { dir, filename } = splitPath(normalizeTreePath(path));
    if (!filename) return null;
    const folderId = await this.findFolderId(sourceId, dir);
    if (folderId === MISSING_FOLDER) return null;
    const parsed = parseDocumentFilename(filename);
    if (!parsed.ok) return null;
    const { name, extension } = parsed.value;
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === sourceId &&
        doc.deletedAt === null &&
        doc.folderId === folderId &&
        doc.name === name &&
        doc.extension === extension
      ) {
        return doc;
      }
    }
    return null;
  }

  async inspect(sourceId: string, path: string): Promise<ContextLocationToken | null> {
    const normalized = normalizeTreePath(path);
    if (!normalized) {
      return {
        kind: "directory",
        nodeId: CONTEXT_ROOT_DIRECTORY_ID,
        sourceId,
        path: "",
      };
    }
    const doc = await this.findDocumentAtPath(sourceId, normalized);
    if (doc) {
      return {
        kind: "file",
        nodeId: doc.id,
        sourceId,
        path: [...splitPath(normalized).dir, renderDocumentFilename(doc.name, doc.extension)].join(
          "/",
        ),
        filetype: doc.filetype,
      };
    }
    const folder = await this.findFolderAtPath(sourceId, normalized);
    if (folder) {
      return {
        kind: "directory",
        nodeId: folder.id,
        sourceId,
        path: normalized,
      };
    }
    return null;
  }

  private async expectationStillMatches(
    sourceId: string,
    path: string,
    expectation: ContextTargetExpectation,
  ): Promise<boolean> {
    const inspected = await this.inspect(sourceId, path);
    return expectation.state === "absent"
      ? inspected === null
      : sameLocation(inspected, expectation.token);
  }

  private collectSubtree(folderId: string, sourceId: string): Set<string> {
    const subtree = new Set<string>([folderId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of this.backing.folders.values()) {
        if (
          folder.contextSourceId === sourceId &&
          folder.deletedAt === null &&
          folder.parentId !== null &&
          subtree.has(folder.parentId) &&
          !subtree.has(folder.id)
        ) {
          subtree.add(folder.id);
          changed = true;
        }
      }
    }
    return subtree;
  }

  private documentIdsInSubtree(subtree: ReadonlySet<string>, sourceId: string): string[] {
    const ids: string[] = [];
    for (const doc of this.backing.documents.values()) {
      if (
        doc.contextSourceId === sourceId &&
        doc.deletedAt === null &&
        doc.folderId !== null &&
        subtree.has(doc.folderId)
      ) {
        ids.push(doc.id);
      }
    }
    return ids;
  }

  async commitMove(
    input: ContextTreeMoveCommand,
  ): Promise<Result<ContextTreeMutationResult, ContextTreeMutationError>> {
    return this.atomic(async () => {
      let destinationPath = normalizeTreePath(input.destinationPath);
      let targetBasename = treeBasename(destinationPath);
      if (!targetBasename || input.source.nodeId === CONTEXT_ROOT_DIRECTORY_ID) {
        return Err({ code: "invalid_operation" });
      }

      const sourceNow = await this.inspect(input.source.sourceId, input.source.path);
      if (!sameLocation(sourceNow, input.source)) return Err({ code: "stale_source" });

      if (
        !(await this.expectationStillMatches(
          input.destinationSourceId,
          destinationPath,
          input.expectedTarget,
        ))
      ) {
        return Err({ code: "stale_target" });
      }

      if (
        input.destinationParentToken &&
        !sameLocation(
          await this.inspect(input.destinationSourceId, input.destinationParentToken.path),
          input.destinationParentToken,
        )
      )
        return Err({ code: "destination_missing" });

      const targetToken =
        input.expectedTarget.state === "occupied" ? input.expectedTarget.token : null;
      if (targetToken) {
        if (targetToken.nodeId === input.source.nodeId) return Err({ code: "invalid_operation" });
        if (
          input.overwrite &&
          (targetToken.kind !== input.source.kind || input.source.kind === "directory")
        ) {
          return Err({ code: "conflict" });
        }
      }

      const targetParentPath = treeDirname(destinationPath);
      if (
        input.source.kind === "directory" &&
        input.source.sourceId === input.destinationSourceId &&
        (targetParentPath === input.source.path ||
          targetParentPath.startsWith(`${input.source.path}/`))
      ) {
        return Err({ code: "invalid_operation" });
      }

      const previousLocations = memoryFileLocations(this.backing, input.source.sourceId);
      if (input.source.kind === "file") {
        if (targetToken?.kind === "file" && input.overwrite) await this.runBeforeDestructiveWrite();
        await this.runBeforeDestructiveWrite();
        const sourceAfterHooks = await this.inspect(input.source.sourceId, input.source.path);
        if (!sameLocation(sourceAfterHooks, input.source)) return Err({ code: "stale_source" });
        if (
          !(await this.expectationStillMatches(
            input.destinationSourceId,
            destinationPath,
            input.expectedTarget,
          ))
        ) {
          return Err({ code: "stale_target" });
        }
        const sourceRow = this.backing.documents.get(input.source.nodeId);
        if (!sourceRow || sourceRow.deletedAt !== null) return Err({ code: "stale_source" });
        const targetRow =
          targetToken?.kind === "file" && input.overwrite
            ? this.backing.documents.get(targetToken.nodeId)
            : null;
        if (targetToken?.kind === "file" && input.overwrite) {
          if (!targetRow || targetRow.deletedAt !== null) return Err({ code: "stale_target" });
        }
        const destParentId =
          input.destinationParentToken && !input.destinationCreateFolders?.length
            ? input.destinationParentToken.nodeId === CONTEXT_ROOT_DIRECTORY_ID
              ? null
              : input.destinationParentToken.nodeId
            : this.ensureFolderPath(input.destinationSourceId, treePathSegments(targetParentPath));
        const wanted = parseDocumentFilename(targetBasename);
        if (!wanted.ok) return Err({ code: "invalid_operation" });
        targetBasename = await allocateFilename(
          { kind: "document", name: wanted.value.name, extension: wanted.value.extension },
          (candidate) =>
            [...this.backing.documents.values()]
              .filter(
                (row) =>
                  row.id !== input.source.nodeId &&
                  row.contextSourceId === input.destinationSourceId &&
                  row.folderId === destParentId &&
                  row.deletedAt === null,
              )
              .some((row) =>
                sameNamespaceName(candidate, {
                  kind: "document",
                  filename: renderFilename(row.name, row.extension),
                }),
              ) ||
            [...this.backing.folders.values()]
              .filter(
                (row) =>
                  row.contextSourceId === input.destinationSourceId &&
                  row.parentId === destParentId &&
                  row.deletedAt === null,
              )
              .some((row) => sameNamespaceName(candidate, { kind: "folder", filename: row.name })),
        );
        destinationPath = [targetParentPath, targetBasename].filter(Boolean).join("/");
        const now = this.nextTimestamp();
        if (targetRow) {
          targetRow.deletedAt = now;
          targetRow.deletionReason = "deleted";
          targetRow.deletedByUserId = input.actorUserId ?? null;
          targetRow.updatedAt = now;
          this.markMutatorWrite();
        }
        const parsed = parseDocumentFilename(targetBasename);
        if (!parsed.ok) return Err({ code: "invalid_operation" });
        const { name, extension } = parsed.value;
        const basenameChanged = targetBasename !== treeBasename(input.source.path);
        sourceRow.contextSourceId = input.destinationSourceId;
        sourceRow.folderId = destParentId;
        sourceRow.name = name;
        sourceRow.extension = extension;
        if (
          (basenameChanged ||
            ("graduateProvisionalName" in input && input.graduateProvisionalName)) &&
          sourceRow.provisionalName
        ) {
          sourceRow.provisionalName = false;
        }
        if (input.destinationFiletype != null) {
          sourceRow.filetype = input.destinationFiletype;
        }
        sourceRow.updatedAt = this.nextTimestamp();
        this.markMutatorWrite();
        recordMemoryMove(
          this.backing,
          input.source.sourceId,
          input.destinationSourceId,
          previousLocations,
        );
        return Ok({ movedNodeId: sourceRow.id, destinationPath });
      }

      const root = this.backing.folders.get(input.source.nodeId);
      if (!root || root.deletedAt !== null) return Err({ code: "stale_source" });
      await this.runBeforeDestructiveWrite();
      const sourceAfterHook = await this.inspect(input.source.sourceId, input.source.path);
      if (!sameLocation(sourceAfterHook, input.source)) return Err({ code: "stale_source" });
      if (
        !(await this.expectationStillMatches(
          input.destinationSourceId,
          destinationPath,
          input.expectedTarget,
        ))
      ) {
        return Err({ code: "stale_target" });
      }
      const movedRoot = this.backing.folders.get(input.source.nodeId);
      if (!movedRoot || movedRoot.deletedAt !== null) return Err({ code: "stale_source" });
      const destParentId =
        input.destinationParentToken && !input.destinationCreateFolders?.length
          ? input.destinationParentToken.nodeId === CONTEXT_ROOT_DIRECTORY_ID
            ? null
            : input.destinationParentToken.nodeId
          : this.ensureFolderPath(input.destinationSourceId, treePathSegments(targetParentPath));
      targetBasename = await allocateFilename(
        { kind: "folder", name: targetBasename },
        (candidate) =>
          [...this.backing.folders.values()]
            .filter(
              (row) =>
                row.id !== input.source.nodeId &&
                row.contextSourceId === input.destinationSourceId &&
                row.parentId === destParentId &&
                row.deletedAt === null,
            )
            .some((row) => sameNamespaceName(candidate, { kind: "folder", filename: row.name })) ||
          [...this.backing.documents.values()]
            .filter(
              (row) =>
                row.contextSourceId === input.destinationSourceId &&
                row.folderId === destParentId &&
                row.deletedAt === null,
            )
            .some((row) =>
              sameNamespaceName(candidate, {
                kind: "document",
                filename: renderFilename(row.name, row.extension),
              }),
            ),
      );
      destinationPath = [targetParentPath, targetBasename].filter(Boolean).join("/");
      const subtree = this.collectSubtree(movedRoot.id, input.source.sourceId);
      const movedDocumentIds = this.documentIdsInSubtree(subtree, input.source.sourceId);
      for (const id of subtree) {
        const folder = this.backing.folders.get(id);
        if (!folder) continue;
        folder.contextSourceId = input.destinationSourceId;
        folder.updatedAt = this.nextTimestamp();
      }
      movedRoot.parentId = destParentId;
      movedRoot.name = targetBasename;
      movedRoot.updatedAt = this.nextTimestamp();
      for (const documentId of movedDocumentIds) {
        const doc = this.backing.documents.get(documentId);
        if (!doc) continue;
        doc.contextSourceId = input.destinationSourceId;
        doc.updatedAt = this.nextTimestamp();
      }
      this.markMutatorWrite();
      recordMemoryMove(
        this.backing,
        input.source.sourceId,
        input.destinationSourceId,
        previousLocations,
      );
      return Ok({ movedNodeId: movedRoot.id, destinationPath });
    });
  }

  async commitProvisionalGraduation(
    source: Extract<ContextLocationToken, { kind: "file" }>,
  ): Promise<Result<void, ContextTreeMutationError>> {
    return this.atomic(async () => {
      const sourceNow = await this.inspect(source.sourceId, source.path);
      if (!sameLocation(sourceNow, source)) return Err({ code: "stale_source" });
      const row = this.backing.documents.get(source.nodeId);
      if (!row || row.deletedAt !== null) return Err({ code: "stale_source" });
      row.provisionalName = false;
      this.markMutatorWrite();
      return Ok(undefined);
    });
  }

  async commitRecursiveDelete(
    command: ContextTreeDeleteCommand,
  ): Promise<Result<ContextTreeDeleteResult, ContextTreeMutationError>> {
    const result = await this.atomic(async () => {
      const token = command.root;
      if (token.nodeId === CONTEXT_ROOT_DIRECTORY_ID) return Err({ code: "invalid_operation" });
      const current = await this.inspect(token.sourceId, token.path);
      if (!sameLocation(current, token)) return Err({ code: "stale_source" });
      const now = this.nextTimestamp();
      if (token.kind === "file") {
        await this.runBeforeDestructiveWrite();
        const doc = this.backing.documents.get(token.nodeId);
        if (!doc || doc.deletedAt !== null) {
          return Err({ code: "stale_source" });
        }
        doc.deletedAt = now;
        doc.deletionReason = command.removal?.reason ?? "deleted";
        doc.deletedByUserId = command.actorUserId ?? null;
        doc.deletionCause = command.removal?.cause ?? null;
        doc.updatedAt = now;
        this.markMutatorWrite();
        this.backing.availabilityGeneration.value += 1n;
        return Ok({
          removed: [
            {
              documentId: doc.id,
              removal: serializeRemovalIdentity({
                time: new Date(now),
                locationVersion: this.backing.availabilityGeneration.value,
              }),
            },
          ],
          availabilityGeneration: String(this.backing.availabilityGeneration.value),
        });
      }
      const folder = this.backing.folders.get(token.nodeId);
      if (!folder || folder.deletedAt !== null) return Err({ code: "stale_source" });
      await this.runBeforeDestructiveWrite();
      const folderNow = this.backing.folders.get(token.nodeId);
      if (!folderNow || folderNow.deletedAt !== null) return Err({ code: "stale_source" });
      const subtree = this.collectSubtree(folderNow.id, token.sourceId);
      const deletedDocumentIds = this.documentIdsInSubtree(subtree, token.sourceId).sort();
      for (const document of this.backing.documents.values()) {
        if (
          document.contextSourceId === token.sourceId &&
          document.deletedAt === null &&
          document.folderId !== null &&
          subtree.has(document.folderId)
        ) {
          document.deletedAt = now;
          document.deletionReason = command.removal?.reason ?? "deleted";
          document.deletedByUserId = command.actorUserId ?? null;
          document.deletionCause = command.removal?.cause ?? null;
          document.updatedAt = now;
        }
      }
      for (const folderId of subtree) {
        const descendant = this.backing.folders.get(folderId);
        if (!descendant || descendant.deletedAt !== null) return Err({ code: "stale_source" });
        descendant.deletedAt = now;
        descendant.updatedAt = now;
      }
      this.markMutatorWrite();
      this.backing.availabilityGeneration.value += 1n;
      return Ok({
        removed: deletedDocumentIds.map((documentId) => ({
          documentId,
          removal: serializeRemovalIdentity({
            time: new Date(now),
            locationVersion: this.backing.availabilityGeneration.value,
          }),
        })),
        availabilityGeneration: String(this.backing.availabilityGeneration.value),
      });
    });
    return result;
  }
}
